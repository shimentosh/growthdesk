import { Inject, Injectable, Logger } from "@nestjs/common";
import { rm } from "node:fs/promises";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { AuditService } from "../core/audit.service.js";
import { MailService } from "../core/mail.service.js";
import { BillingService } from "../billing/billing.service.js";
import { me, ws, type RequestContext } from "../common/context.js";
import { badRequest, conflict, forbidden, notFound, unavailable } from "../common/errors.js";
import type { Workspace } from "../generated/prisma/client.js";
import { PURGE_BATCH, PURGE_ORDER } from "./purge.js";
import { exportDirFor } from "./workspace-export.service.js";

const DAY = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The suspension reason a deletion sets, so a restore knows the suspension was its own. */
export const DELETED_REASON = "This workspace was deleted.";

/** Subscription statuses that may still bill the account. */
const BILLING_STATUSES: readonly string[] = ["active", "trialing", "past_due", "incomplete"];

/*
 * Deleting, restoring and purging a workspace, and handing it to a new owner
 * (docs/PRIVACY_OPS.md).
 *
 * Delete is a soft delete. At once: the workspace answers 404 to everyone
 * (AccessGuard, API keys), drops out of the switcher and the plan's usage,
 * running campaigns pause, and it is marked suspended, which every sending
 * path (email, chat, marketing, workflows) already refuses. When it was the
 * billing account's last workspace, the subscription is cancelled through
 * BillingService (at period end when Stripe bills it). Platform admin can
 * restore it until `purgeAfter` (WORKSPACE_PURGE_DAYS); after that the purge
 * job hard-deletes its data in batches and finally the row itself.
 */
@Injectable()
export class WorkspaceLifecycleService {
  private readonly log = new Logger("workspace-lifecycle");

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly billing: BillingService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // ─── Delete ────────────────────────────────────────────────────────────────

  /** The owner deletes their workspace, typing its name to confirm. */
  async deleteByOwner(ctx: RequestContext, confirmName: string) {
    const w = ws(ctx);
    if (w.role !== "owner") throw forbidden("Only the workspace owner can delete it.");
    const row = await this.prisma.db.workspace.findUniqueOrThrow({ where: { id: w.id } });
    if (confirmName.trim() !== row.name.trim()) {
      throw badRequest("Type the workspace name exactly as it is shown to confirm.", { confirmName: "Does not match the workspace name" });
    }
    return this.softDelete(ctx, row, { actorId: me(ctx).userId, platform: false });
  }

  /** Platform admin deletes a workspace on a customer's behalf. */
  async deleteByAdmin(ctx: RequestContext, id: string, reason: string) {
    const row = await this.find(id);
    if (row.deletedAt) throw conflict("This workspace is already deleted.");
    return this.softDelete(ctx, row, { actorId: me(ctx).userId, platform: true, reason });
  }

  private async softDelete(ctx: RequestContext, row: Workspace, opts: { actorId: string; platform: boolean; reason?: string }) {
    const now = new Date();
    const purgeAfter = new Date(now.getTime() + this.config.WORKSPACE_PURGE_DAYS * DAY);

    // The subscription goes first: a deleted customer must not be charged again, so a provider failure stops the deletion.
    const others = await this.prisma.db.workspace.count({ where: { billingAccountId: row.billingAccountId, deletedAt: null, id: { not: row.id } } });
    let subscriptionCanceled = false;
    if (others === 0) {
      const sub = await this.prisma.db.subscription.findUnique({ where: { billingAccountId: row.billingAccountId } });
      if (sub && BILLING_STATUSES.includes(sub.status) && !sub.cancelAtPeriodEnd) {
        try {
          await this.billing.cancelAccount(row.billingAccountId, ctx);
          subscriptionCanceled = true;
        } catch (e) {
          this.log.error(`could not cancel the subscription of ${row.billingAccountId}: ${e instanceof Error ? e.message : String(e)}`);
          throw unavailable("The subscription could not be cancelled with the payment provider, so the workspace was not deleted. Try again in a few minutes.");
        }
      }
    }

    const members = await this.prisma.db.membership.findMany({ where: { workspaceId: row.id }, include: { user: { select: { email: true, suspendedAt: true } } } });
    const paused = await this.prisma.db.$transaction(async (tx) => {
      await tx.workspace.update({
        where: { id: row.id },
        data: {
          deletedAt: now,
          deletedById: opts.actorId,
          purgeAfter,
          // Suspended is what every sending path refuses. An existing suspension (abuse, say) keeps its own reason.
          status: "suspended",
          suspendedAt: row.status === "suspended" ? row.suspendedAt : now,
          suspendedReason: row.status === "suspended" ? row.suspendedReason : DELETED_REASON,
        },
      });
      const campaigns = await tx.campaign.updateMany({ where: { workspaceId: row.id, status: { in: ["running", "scheduled"] } }, data: { status: "paused" } });
      const marketing = await tx.marketingCampaign.updateMany({ where: { workspaceId: row.id, status: { in: ["sending", "scheduled"] } }, data: { status: "paused" } });
      await tx.invitation.updateMany({ where: { workspaceId: row.id, acceptedAt: null, revokedAt: null }, data: { revokedAt: now } });
      return campaigns.count + marketing.count;
    });

    await this.audit.record(
      ctx,
      {
        workspaceId: row.id,
        action: opts.platform ? "platform.workspace_deleted" : "workspace.deleted",
        targetType: "workspace",
        targetId: row.id,
        metadata: { purgeAfter: purgeAfter.toISOString(), campaignsPaused: paused, subscriptionCanceled, ...(opts.reason ? { reason: opts.reason } : {}) },
      },
      opts.platform ? "platform_admin" : "user",
    );
    const when = purgeAfter.toISOString().slice(0, 10);
    for (const m of members) {
      if (m.user.suspendedAt) continue;
      await this.mail.notification(
        m.user.email,
        `${row.name} was deleted`,
        `The workspace ${row.name} was deleted${opts.platform ? " by our support team" : " by its owner"} and nobody can open it any more. Its data will be permanently erased on ${when}. Until then, the owner can ask support to restore it.`,
        "/",
      );
    }
    return { deleted: true, purgeAfter, campaignsPaused: paused, subscriptionCanceled };
  }

  // ─── Restore (platform admin) ──────────────────────────────────────────────

  async restore(ctx: RequestContext, id: string) {
    const row = await this.find(id);
    if (!row.deletedAt) throw conflict("This workspace is not deleted.");
    if (row.purgeAfter && row.purgeAfter.getTime() <= Date.now()) {
      throw conflict("This workspace is past its restore window and is being erased. It can't be restored.");
    }
    const ours = row.suspendedReason === DELETED_REASON;
    await this.prisma.db.workspace.update({
      where: { id },
      data: {
        deletedAt: null,
        deletedById: null,
        purgeAfter: null,
        ...(ours ? { status: "active", suspendedAt: null, suspendedReason: "" } : {}),
      },
    });
    await this.audit.record(ctx, { workspaceId: id, action: "platform.workspace_restored", targetType: "workspace", targetId: id, metadata: { deletedAt: row.deletedAt.toISOString() } }, "platform_admin");
    return { restored: true, stillSuspended: !ours };
  }

  private async find(id: string) {
    if (!UUID.test(id)) throw notFound("That workspace");
    const row = await this.prisma.db.workspace.findUnique({ where: { id } });
    if (!row) throw notFound("That workspace");
    return row;
  }

  // ─── Transfer ownership ────────────────────────────────────────────────────

  /**
   * The owner hands the workspace to another member, and becomes an admin.
   * When the billing account holds no other workspace, it moves with it, so
   * the new owner is the one billing notices go to. The provider subscription
   * and its card stay as they are; the new owner can change them in Billing.
   */
  async transferOwnership(ctx: RequestContext, membershipId: string) {
    const w = ws(ctx);
    const current = me(ctx);
    if (w.role !== "owner") throw forbidden("Only the owner can transfer ownership.");
    const target = await this.prisma.db.membership.findFirst({
      where: { id: membershipId, workspaceId: w.id },
      include: { user: { select: { id: true, email: true, name: true, suspendedAt: true, emailVerifiedAt: true } } },
    });
    if (!target) throw notFound("That member");
    if (target.userId === current.userId) throw badRequest("You already own this workspace.");
    if (target.user.suspendedAt) throw badRequest("That person's account is disabled, so they can't own the workspace.");
    if (!target.user.emailVerifiedAt) throw badRequest("That person must confirm their email address before they can own the workspace.");

    const billingAccountMoved = await this.prisma.db.$transaction(async (tx) => {
      await tx.membership.update({ where: { id: target.id }, data: { role: "owner" } });
      await tx.membership.update({ where: { workspaceId_userId: { workspaceId: w.id, userId: current.userId } }, data: { role: "admin" } });
      const account = await tx.billingAccount.findUniqueOrThrow({ where: { id: w.billingAccountId } });
      const others = await tx.workspace.count({ where: { billingAccountId: account.id, deletedAt: null, id: { not: w.id } } });
      if (account.ownerId !== current.userId || others > 0) return false;
      await tx.billingAccount.update({
        where: { id: account.id },
        data: { ownerId: target.userId, ...(account.billingEmail === current.email ? { billingEmail: target.user.email } : {}) },
      });
      return true;
    });
    await this.audit.record(ctx, {
      action: "workspace.ownership_transferred",
      targetType: "membership",
      targetId: target.id,
      metadata: { fromUserId: current.userId, toUserId: target.userId, billingAccountMoved },
    });
    await this.mail.notification(
      target.user.email,
      `You now own ${w.name}`,
      `${current.name || current.email} made you the owner of ${w.name}.${billingAccountMoved ? " Billing notices for the workspace now come to you." : ""}`,
      `/w/${w.id}/settings/general`,
    );
    return { ownerMembershipId: target.id, billingAccountMoved };
  }

  // ─── Purge ─────────────────────────────────────────────────────────────────

  /** Deleted workspaces past their restore window, purged one after another. */
  async purgeDue(now = new Date(), limit = 10): Promise<number> {
    // Workspace is not a tenant model; this sweep is platform-wide by design.
    const due = await this.prisma.db.workspace.findMany({
      where: { deletedAt: { not: null }, purgeAfter: { lte: now } },
      select: { id: true },
      orderBy: { purgeAfter: "asc" },
      take: limit,
    });
    let purged = 0;
    for (const w of due) if ((await this.purge(w.id, now)).purged) purged++;
    return purged;
  }

  /**
   * Hard-deletes one deleted workspace: every tenant table in PURGE_ORDER, in
   * batches of PURGE_BATCH rows, then its export files, then the row. Safe to
   * stop and run again; each batch commits on its own. Audit rows are kept
   * (they hold no customer records) and billing records stay with the account.
   */
  async purge(workspaceId: string, now = new Date()): Promise<{ purged: boolean; rows: number }> {
    const row = await this.prisma.db.workspace.findUnique({ where: { id: workspaceId } });
    if (!row?.deletedAt || !row.purgeAfter || row.purgeAfter.getTime() > now.getTime()) return { purged: false, rows: 0 };
    let rows = 0;
    for (const table of PURGE_ORDER) {
      for (;;) {
        // Unscoped by necessity: raw batched deletes of a deleted workspace's rows. Table names come from PURGE_ORDER, never from input.
        const n = await this.prisma.unscoped.$executeRawUnsafe(
          `DELETE FROM "${table}" WHERE ctid IN (SELECT ctid FROM "${table}" WHERE "workspaceId" = $1::uuid LIMIT ${PURGE_BATCH})`,
          workspaceId,
        );
        rows += n;
        if (n < PURGE_BATCH) break;
      }
    }
    await rm(exportDirFor(this.config, workspaceId), { recursive: true, force: true });
    // Only while still deleted: a row restored in the meantime is never removed.
    const gone = await this.prisma.db.workspace.deleteMany({ where: { id: workspaceId, deletedAt: { not: null } } });
    await this.audit.record(null, { workspaceId, action: "workspace.purged", targetType: "workspace", targetId: workspaceId, metadata: { rows, name: row.name } }, "system");
    this.log.log(`purged workspace ${workspaceId} (${rows} rows)`);
    return { purged: gone.count > 0, rows };
  }
}
