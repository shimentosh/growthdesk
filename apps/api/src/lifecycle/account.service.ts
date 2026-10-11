import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service.js";
import { AuditService } from "../core/audit.service.js";
import { MailService } from "../core/mail.service.js";
import { BillingService } from "../billing/billing.service.js";
import { verifyPassword } from "../common/crypto.js";
import { me, type RequestContext } from "../common/context.js";
import { badRequest, conflict, forbidden } from "../common/errors.js";
import { currentTermsVersion } from "./terms.js";
import { eraseUserIdentity } from "./user-erasure.js";

const LIVE_STATUSES = ["active", "trialing", "past_due", "incomplete"] as const;

/*
 * A person's own account: the terms they accepted, and closing the account
 * (docs/PRIVACY_OPS.md).
 *
 * Closing is refused while they own a workspace that is not deleted (they
 * transfer it or delete it first), or a billing account that still pays for
 * one. Otherwise they leave every workspace (their records stay, unassigned),
 * their identity is erased exactly as platform admin's "Delete & anonymise"
 * does it, every session ends and the API keys they created are revoked.
 */
@Injectable()
export class AccountService {
  private readonly log = new Logger("account");

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly billing: BillingService,
  ) {}

  /** What stops this person closing their account, as workspaces to deal with first. */
  private async blockers(userId: string) {
    const owned = await this.prisma.db.workspace.findMany({
      where: { deletedAt: null, OR: [{ memberships: { some: { userId, role: "owner" } } }, { billingAccount: { ownerId: userId } }] },
      select: { id: true, name: true, billingAccount: { select: { ownerId: true } }, memberships: { where: { userId }, select: { role: true } } },
      orderBy: { createdAt: "asc" },
    });
    return owned.map((w) => ({
      workspaceId: w.id,
      name: w.name,
      // "owner": transfer or delete it. "billing": they pay for a workspace someone else owns; support moves the billing account.
      reason: w.memberships[0]?.role === "owner" ? ("owner" as const) : ("billing" as const),
    }));
  }

  async summary(ctx: RequestContext) {
    const id = me(ctx);
    const [user, blockers, version] = await Promise.all([
      this.prisma.db.user.findUniqueOrThrow({ where: { id: id.userId }, select: { termsAcceptedAt: true, termsVersion: true, passwordHash: true, platformRole: true } }),
      this.blockers(id.userId),
      currentTermsVersion(this.prisma),
    ]);
    return {
      terms: { acceptedAt: user.termsAcceptedAt, version: user.termsVersion || null, currentVersion: version },
      close: { allowed: blockers.length === 0 && user.platformRole === "none", staff: user.platformRole !== "none", blockers, needsPassword: Boolean(user.passwordHash) },
    };
  }

  /** Everything the platform holds about the signed-in person themselves (not the workspaces' records), as one JSON document. */
  async exportMine(ctx: RequestContext) {
    const id = me(ctx);
    const [user, profile, memberships, sessions, billingAccounts, activity] = await Promise.all([
      this.prisma.db.user.findUniqueOrThrow({
        where: { id: id.userId },
        select: { id: true, email: true, name: true, timezone: true, avatarUrl: true, emailVerifiedAt: true, googleSub: true, termsAcceptedAt: true, termsVersion: true, lastLoginAt: true, createdAt: true },
      }),
      this.prisma.db.platformUserProfile.findUnique({ where: { userId: id.userId }, omit: { tags: true } }),
      this.prisma.db.membership.findMany({ where: { userId: id.userId }, include: { workspace: { select: { id: true, name: true, deletedAt: true } } } }),
      this.prisma.db.session.findMany({ where: { userId: id.userId }, select: { ip: true, userAgent: true, createdAt: true, lastSeenAt: true, expiresAt: true, revokedAt: true }, orderBy: { createdAt: "desc" } }),
      this.prisma.db.billingAccount.findMany({ where: { ownerId: id.userId }, select: { id: true, name: true, billingEmail: true, country: true, address: true, taxId: true, createdAt: true } }),
      this.prisma.db.auditEvent.findMany({ where: { actorUserId: id.userId }, orderBy: { createdAt: "desc" }, take: 1000, select: { action: true, workspaceId: true, ip: true, createdAt: true } }),
    ]);
    await this.audit.record({ ...ctx, workspace: undefined }, { action: "account.data_exported", targetType: "user", targetId: id.userId }, "user");
    const { googleSub, ...rest } = user;
    return {
      format: "growthdesk-account-export",
      version: 1,
      exportedAt: new Date(),
      user: { ...rest, googleLinked: Boolean(googleSub) },
      profile,
      workspaces: memberships.filter((m) => !m.workspace.deletedAt).map((m) => ({ id: m.workspace.id, name: m.workspace.name, role: m.role, joinedAt: m.createdAt })),
      billingAccounts,
      sessions,
      activity,
    };
  }

  async acceptTerms(ctx: RequestContext) {
    const id = me(ctx);
    const version = await currentTermsVersion(this.prisma);
    const now = new Date();
    await this.prisma.db.user.update({ where: { id: id.userId }, data: { termsAcceptedAt: now, termsVersion: version } });
    await this.audit.record({ ...ctx, workspace: undefined }, { action: "account.terms_accepted", targetType: "user", targetId: id.userId, metadata: { version } }, "user");
    return { acceptedAt: now, version };
  }

  async close(ctx: RequestContext, input: { confirmEmail: string; password?: string }) {
    const id = me(ctx);
    const user = await this.prisma.db.user.findUniqueOrThrow({ where: { id: id.userId } });
    if (input.confirmEmail !== user.email) throw badRequest("Type your email address exactly to confirm.", { confirmEmail: "Does not match your email address" });
    if (user.passwordHash) {
      if (!input.password) throw badRequest("Enter your password to confirm.", { password: "Required" });
      if (!(await verifyPassword(input.password, user.passwordHash))) throw badRequest("That password is not right.", { password: "Incorrect password" });
    }
    if (user.platformRole !== "none") throw forbidden("Platform staff accounts can't be closed here. Ask a platform owner to change your platform role first.");
    const blockers = await this.blockers(user.id);
    if (blockers.length) {
      const names = blockers.map((b) => b.name).join(", ");
      throw conflict(`You still own ${names}. Transfer ownership to another member or delete the workspace first.`, undefined, { blockers });
    }

    // Every workspace of the accounts they own is deleted, so their subscriptions were cancelled then. Belt and braces for one that is still billing.
    const live = await this.prisma.db.subscription.findMany({
      where: { billingAccount: { ownerId: user.id }, status: { in: [...LIVE_STATUSES] }, cancelAtPeriodEnd: false, provider: { notIn: ["none", "manual"] } },
      select: { billingAccountId: true },
    });
    for (const s of live) await this.billing.cancelAccount(s.billingAccountId, { ...ctx, workspace: undefined });

    // Told before the address is erased; sendTemplate never throws.
    await this.mail.sendTemplate("account_deleted", user.email, { name: user.name }, { userId: user.id });
    const now = new Date();
    const memberships = await this.prisma.db.membership.findMany({ where: { userId: user.id }, include: { workspace: { select: { deletedAt: true } } } });
    await this.prisma.db.$transaction(async (tx) => {
      for (const m of memberships) {
        // The owner row of a deleted workspace stays until the purge, so a restore still has an owner of record.
        if (m.role === "owner" && m.workspace.deletedAt) continue;
        const workspaceId = m.workspaceId;
        // As when someone leaves (WorkspacesService.remove): their records stay, released from them.
        await tx.contact.updateMany({ where: { workspaceId, ownerId: user.id }, data: { ownerId: null } });
        await tx.deal.updateMany({ where: { workspaceId, ownerId: user.id }, data: { ownerId: null } });
        await tx.task.updateMany({ where: { workspaceId, assigneeId: user.id, status: "open" }, data: { assigneeId: null } });
        await tx.conversation.updateMany({ where: { workspaceId, assigneeId: user.id }, data: { assigneeId: null } });
        await tx.membership.delete({ where: { id: m.id } });
      }
      await eraseUserIdentity(tx, user, now, { reason: "Account closed by its owner", closedBySelf: true });
    });
    // ApiKey is not a guarded tenant model, so the cross-workspace update is allowed.
    const keys = await this.prisma.db.apiKey.updateMany({ where: { createdById: user.id, revokedAt: null }, data: { revokedAt: now } });
    await this.audit.record(
      { ...ctx, workspace: undefined },
      { action: "account.closed", targetType: "user", targetId: user.id, metadata: { workspacesLeft: memberships.length, apiKeysRevoked: keys.count } },
      "user",
    );
    this.log.log(`account ${user.id} closed by its owner`);
    return { closed: true, workspacesLeft: memberships.length, apiKeysRevoked: keys.count };
  }
}
