import { Inject, Injectable } from "@nestjs/common";
import {
  DEFAULT_ROLE_PERMISSIONS,
  ROLE_RANK,
  type RolePermissionOverrides,
  type WorkspaceRole,
  permissionsFor,
  rolePermissionTrouble,
  type UpdateWorkspaceInput,
} from "@growthdesk/shared";
import type { z } from "zod";
import { PrismaService, type Tx } from "../prisma/prisma.service.js";
import { EntitlementsService } from "../billing/entitlements.service.js";
import { recordSubscriptionChange } from "../billing/subscription-history.js";
import { trialEmailKey } from "../billing/trial-guard.js";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { PlatformSettingsService } from "../core/platform-settings.service.js";
import { AuditService } from "../core/audit.service.js";
import { MailService } from "../core/mail.service.js";
import { hashToken, newToken } from "../common/crypto.js";
import { badRequest, conflict, forbidden, notFound } from "../common/errors.js";
import { me, ws, type RequestContext } from "../common/context.js";

export const DEFAULT_STAGES: { name: string; kind: "open" | "won" | "lost"; probability: number; color: string }[] = [
  { name: "New Lead", kind: "open", probability: 5, color: "gray" },
  { name: "Ready to Contact", kind: "open", probability: 10, color: "slate" },
  { name: "Contacted", kind: "open", probability: 15, color: "blue" },
  { name: "Replied", kind: "open", probability: 25, color: "indigo" },
  { name: "Qualified", kind: "open", probability: 40, color: "violet" },
  { name: "Meeting Booked", kind: "open", probability: 60, color: "purple" },
  { name: "Proposal Sent", kind: "open", probability: 70, color: "amber" },
  { name: "Negotiation", kind: "open", probability: 80, color: "orange" },
  { name: "Won", kind: "won", probability: 100, color: "green" },
  { name: "Lost", kind: "lost", probability: 0, color: "red" },
];

export const DEFAULT_WORKSPACE_SETTINGS = {
  defaultCountry: "",
  campaignDefaults: {
    schedule: { timezone: "UTC", days: [1, 2, 3, 4, 5], from: "09:00", to: "17:00" },
    settings: { dailyNewLimit: 50, stopOnReply: true, stopOnAutoReply: false, stopOnMeeting: true, trackOpens: false, trackClicks: false, unsubscribeLink: true, gapSeconds: 120 },
  },
  notifications: { replyReceived: true, taskAssigned: true, taskReminder: true, email: true },
  aiAutoClassify: true,
};

const INVITE_TTL_MS = 7 * 86_400_000;

const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "workspace";

@Injectable()
export class WorkspacesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly platform: PlatformSettingsService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Creates a workspace. The first workspace a person creates also creates
   * their billing account and starts the install's default plan (a trial
   * where that plan has one). Later workspaces join the same account and
   * count against its plan's workspace limit.
   */
  async create(ctx: RequestContext, input: { name: string; businessType: string; timezone: string; currency: string; billingAccountId?: string | null }) {
    const user = me(ctx);
    const settings = await this.platform.get();
    if (!user.emailVerified && settings.requireEmailVerification) throw forbidden("Confirm your email address first — check your inbox for the link.");
    let account = input.billingAccountId
      ? await this.prisma.db.billingAccount.findFirst({ where: { id: input.billingAccountId, ownerId: user.userId } })
      : await this.prisma.db.billingAccount.findFirst({ where: { ownerId: user.userId }, orderBy: { createdAt: "asc" } });
    if (input.billingAccountId && !account) throw notFound("That billing account");
    if (account) await this.entitlements.assertCapacity(account.id, "workspaces");

    const plan =
      (await this.prisma.db.plan.findUnique({ where: { key: settings.defaultPlanKey } })) ??
      (await this.prisma.db.plan.findFirst({ where: { isActive: true }, orderBy: { sortOrder: "asc" } }));
    if (!plan) throw new Error("No plans exist — run the seed (pnpm db:seed).");

    // The platform's defaultTrialDays, when set, overrides the plan's own trial length.
    const trialDays = settings.defaultTrialDays ?? plan.trialDays;
    const emailKey = trialEmailKey(user.email);
    const withheld = !account && trialDays > 0 ? await this.trialWithheld(emailKey, ctx.ip) : null;
    // A withheld trial starts the account on the expired-plan fallback (Free), not on a paid plan for free.
    const startPlan = withheld ? ((await this.prisma.db.plan.findUnique({ where: { key: settings.expiredPlanKey } })) ?? plan) : plan;

    const workspace = await this.prisma.db.$transaction(async (tx) => {
      if (!account) {
        const trial = trialDays > 0 && !withheld;
        account = await tx.billingAccount.create({
          data: { name: input.name, ownerId: user.userId, billingEmail: user.email, trialEmailKey: emailKey, signupIp: ctx.ip || null, trialGrantedAt: trial ? new Date() : null },
        });
        const subscription = await tx.subscription.create({
          data: {
            billingAccountId: account.id,
            planId: startPlan.id,
            status: trial ? "trialing" : "active",
            provider: "none",
            trialEndsAt: trial ? new Date(Date.now() + trialDays * 86_400_000) : null,
            currentPeriodStart: new Date(),
          },
        });
        await recordSubscriptionChange(tx, null, subscription);
      }
      const w = await tx.workspace.create({
        data: {
          billingAccountId: account.id,
          name: input.name,
          slug: `${slugify(input.name)}-${newToken(3).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 4) || "ws"}`,
          businessType: input.businessType,
          timezone: input.timezone,
          currency: input.currency,
          createdById: user.userId,
          settings: {
            ...DEFAULT_WORKSPACE_SETTINGS,
            campaignDefaults: {
              ...DEFAULT_WORKSPACE_SETTINGS.campaignDefaults,
              schedule: { ...DEFAULT_WORKSPACE_SETTINGS.campaignDefaults.schedule, timezone: input.timezone },
            },
          },
        },
      });
      await tx.membership.create({ data: { workspaceId: w.id, userId: user.userId, role: "owner" } });
      await this.createDefaultPipeline(tx, w.id);
      return w;
    });
    await this.audit.record({ ...ctx, workspace: undefined }, { workspaceId: workspace.id, action: "workspace.created", targetType: "workspace", targetId: workspace.id });
    if (withheld) {
      await this.audit.record(
        { ...ctx, workspace: undefined },
        { workspaceId: workspace.id, action: "billing.trial_withheld", targetType: "billing_account", targetId: workspace.billingAccountId, metadata: { reason: withheld, plan: startPlan.key } },
      );
    }
    return { id: workspace.id, name: workspace.name, slug: workspace.slug };
  }

  /**
   * Why a new billing account gets no free trial, or null when it does
   * (docs/GAP_PLAN.md §3.1.9): the same person already had one (compared by
   * normalised email, so plus-addresses and Gmail dots do not count as new
   * people), or the signup IP has had TRIALS_PER_IP_PER_DAY trials in the last day.
   */
  private async trialWithheld(emailKey: string, ip: string): Promise<"email" | "ip" | null> {
    if (await this.prisma.db.billingAccount.findFirst({ where: { trialEmailKey: emailKey, trialGrantedAt: { not: null } }, select: { id: true } })) return "email";
    const perIp = this.config.TRIALS_PER_IP_PER_DAY;
    if (perIp > 0 && ip) {
      const recent = await this.prisma.db.billingAccount.count({ where: { signupIp: ip, trialGrantedAt: { gte: new Date(Date.now() - 86_400_000) } } });
      if (recent >= perIp) return "ip";
    }
    return null;
  }

  async createDefaultPipeline(tx: Tx, workspaceId: string) {
    const pipeline = await tx.pipeline.create({ data: { workspaceId, name: "Sales pipeline", isDefault: true } });
    await tx.pipelineStage.createMany({
      data: DEFAULT_STAGES.map((s, i) => ({ workspaceId, pipelineId: pipeline.id, position: i, ...s })),
    });
    return pipeline;
  }

  async detail(ctx: RequestContext) {
    const w = ws(ctx);
    const row = await this.prisma.db.workspace.findUniqueOrThrow({ where: { id: w.id } });
    const ent = await this.entitlements.forAccount(w.billingAccountId);
    const [mailboxes, contacts, campaigns, members] = await Promise.all([
      this.prisma.db.mailbox.count({ where: { workspaceId: w.id, deletedAt: null } }),
      this.prisma.db.contact.count({ where: { workspaceId: w.id, deletedAt: null } }),
      this.prisma.db.campaign.count({ where: { workspaceId: w.id, deletedAt: null } }),
      this.prisma.db.membership.count({ where: { workspaceId: w.id } }),
    ]);
    const onboarding = (row.onboarding ?? {}) as Record<string, unknown>;
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      businessType: row.businessType,
      timezone: row.timezone,
      currency: row.currency,
      status: row.status,
      suspendedReason: row.suspendedReason,
      settings: row.settings,
      profile: {
        legalName: row.legalName,
        postalAddress: row.postalAddress,
        marketingFromName: row.marketingFromName,
        marketingReplyTo: row.marketingReplyTo,
      },
      role: w.role,
      permissions: w.permissions,
      rolePermissions: row.rolePermissions ?? {},
      plan: {
        key: ent.effectivePlan.key,
        name: ent.effectivePlan.name,
        state: ent.state,
        access: ent.access,
        reason: ent.reason,
        features: ent.features,
        limits: ent.limits,
        trialEndsAt: ent.subscription?.trialEndsAt ?? null,
      },
      onboarding: {
        dismissed: Boolean(onboarding.dismissed),
        steps: {
          mailbox: mailboxes > 0,
          contacts: contacts > 0,
          campaign: campaigns > 0,
          team: members > 1 || (await this.prisma.db.invitation.count({ where: { workspaceId: w.id } })) > 0,
        },
      },
    };
  }

  async update(ctx: RequestContext, input: z.infer<typeof UpdateWorkspaceInput>) {
    const w = ws(ctx);
    const current = await this.prisma.db.workspace.findUniqueOrThrow({ where: { id: w.id } });
    const data: Record<string, unknown> = {};
    for (const k of ["name", "businessType", "timezone", "currency", "legalName", "postalAddress", "marketingFromName", "marketingReplyTo"] as const) {
      if (input[k] !== undefined) data[k] = input[k];
    }
    if (input.settings) data.settings = { ...(current.settings as object), ...input.settings };
    if (input.onboarding) data.onboarding = { ...(current.onboarding as object), ...input.onboarding };
    await this.prisma.db.workspace.update({ where: { id: w.id }, data });
    await this.audit.record(ctx, { action: "workspace.updated", targetType: "workspace", targetId: w.id, metadata: { fields: Object.keys(data) } });
    return this.detail(ctx);
  }

  // ─── Members ───────────────────────────────────────────────────────────────

  async members(ctx: RequestContext) {
    const w = ws(ctx);
    const [rows, invites] = await Promise.all([
      this.prisma.db.membership.findMany({
        where: { workspaceId: w.id },
        include: { user: { select: { id: true, email: true, name: true, lastLoginAt: true } } },
        orderBy: { createdAt: "asc" },
      }),
      this.prisma.db.invitation.findMany({
        where: { workspaceId: w.id, acceptedAt: null, revokedAt: null },
        orderBy: { createdAt: "desc" },
      }),
    ]);
    return {
      members: rows.map((m) => ({ id: m.id, userId: m.userId, email: m.user.email, name: m.user.name, role: m.role, lastLoginAt: m.user.lastLoginAt, joinedAt: m.createdAt })),
      invitations: invites.map((i) => ({ id: i.id, email: i.email, role: i.role, expiresAt: i.expiresAt, expired: i.expiresAt.getTime() < Date.now(), createdAt: i.createdAt })),
    };
  }

  private assertCanAssign(ctx: RequestContext, role: WorkspaceRole) {
    const w = ws(ctx);
    if (role === "owner") throw forbidden("Ownership cannot be assigned here.");
    const mine = w.role === "api" ? 0 : ROLE_RANK[w.role];
    // An admin can manage managers and below; only the owner can create admins.
    if (ROLE_RANK[role] >= mine) throw forbidden(`Your role (${w.role}) cannot grant the ${role} role.`);
  }

  async invite(ctx: RequestContext, email: string, role: WorkspaceRole) {
    const w = ws(ctx);
    this.assertCanAssign(ctx, role);
    const existingMember = await this.prisma.db.membership.findFirst({ where: { workspaceId: w.id, user: { email } } });
    if (existingMember) throw conflict("That person is already a member of this workspace.", { email: "Already a member" });
    const pending = await this.prisma.db.invitation.findFirst({
      where: { workspaceId: w.id, email, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
    });
    if (pending) throw conflict("An invitation to that address is already pending — resend it instead.", { email: "Already invited" });
    await this.entitlements.assertFullAccess(w.billingAccountId, "Inviting teammates");
    await this.entitlements.assertSeat(w.billingAccountId, email);

    const token = newToken();
    const invitation = await this.prisma.db.invitation.create({
      data: { workspaceId: w.id, email, role, tokenHash: hashToken(token), invitedById: ctx.identity?.userId, expiresAt: new Date(Date.now() + INVITE_TTL_MS) },
    });
    await this.mail.invitation(email, ctx.identity?.name || ctx.identity?.email || "A teammate", w.name, token);
    await this.audit.record(ctx, { action: "member.invited", targetType: "invitation", targetId: invitation.id, metadata: { email, role } });
    return { id: invitation.id, email, role, expiresAt: invitation.expiresAt };
  }

  async resendInvitation(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    const inv = await this.prisma.db.invitation.findFirst({ where: { id, workspaceId: w.id, acceptedAt: null, revokedAt: null } });
    if (!inv) throw notFound("That invitation");
    // An expired invitation stopped holding a seat, so renewing it takes one again (docs/GAP_PLAN.md §3.1.4).
    await this.entitlements.assertFullAccess(w.billingAccountId, "Inviting teammates");
    await this.entitlements.assertSeat(w.billingAccountId, inv.email);
    const token = newToken();
    await this.prisma.db.invitation.update({
      where: { id: inv.id },
      data: { tokenHash: hashToken(token), expiresAt: new Date(Date.now() + INVITE_TTL_MS) },
    });
    await this.mail.invitation(inv.email, ctx.identity?.name || "A teammate", w.name, token);
    return { resent: true };
  }

  async revokeInvitation(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    const res = await this.prisma.db.invitation.updateMany({ where: { id, workspaceId: w.id, acceptedAt: null }, data: { revokedAt: new Date() } });
    if (!res.count) throw notFound("That invitation");
    await this.audit.record(ctx, { action: "member.invitation_revoked", targetType: "invitation", targetId: id });
  }

  async changeRole(ctx: RequestContext, membershipId: string, role: WorkspaceRole) {
    const w = ws(ctx);
    const target = await this.prisma.db.membership.findFirst({ where: { id: membershipId, workspaceId: w.id } });
    if (!target) throw notFound("That member");
    if (target.role === "owner") throw forbidden("The owner's role cannot be changed.");
    if (target.userId === ctx.identity?.userId) throw forbidden("You cannot change your own role.");
    const mine = w.role === "api" ? 0 : ROLE_RANK[w.role];
    if (ROLE_RANK[target.role] >= mine) throw forbidden("You cannot change the role of someone at or above your own level.");
    this.assertCanAssign(ctx, role);
    await this.prisma.db.membership.update({ where: { id: target.id }, data: { role } });
    await this.audit.record(ctx, { action: "member.role_changed", targetType: "membership", targetId: target.id, metadata: { from: target.role, to: role } });
    return { id: target.id, role };
  }

  async remove(ctx: RequestContext, membershipId: string) {
    const w = ws(ctx);
    const target = await this.prisma.db.membership.findFirst({ where: { id: membershipId, workspaceId: w.id } });
    if (!target) throw notFound("That member");
    if (target.role === "owner") throw forbidden("The owner cannot be removed.");
    const self = target.userId === ctx.identity?.userId;
    if (!self) {
      if (!w.permissions.includes("members.manage")) throw forbidden();
      const mine = w.role === "api" ? 0 : ROLE_RANK[w.role];
      if (ROLE_RANK[target.role] >= mine) throw forbidden("You cannot remove someone at or above your own level.");
    }
    await this.prisma.db.$transaction(async (tx) => {
      // Their records stay; ownership and assignments are released so nothing points at someone who cannot see it.
      await tx.contact.updateMany({ where: { workspaceId: w.id, ownerId: target.userId }, data: { ownerId: null } });
      await tx.deal.updateMany({ where: { workspaceId: w.id, ownerId: target.userId }, data: { ownerId: null } });
      await tx.task.updateMany({ where: { workspaceId: w.id, assigneeId: target.userId, status: "open" }, data: { assigneeId: null } });
      await tx.conversation.updateMany({ where: { workspaceId: w.id, assigneeId: target.userId }, data: { assigneeId: null } });
      await tx.membership.delete({ where: { id: target.id } });
    });
    // Sessions are not revoked: they may still work in other workspaces, and every request re-checks membership.
    await this.audit.record(ctx, { action: self ? "member.left" : "member.removed", targetType: "membership", targetId: target.id });
  }

  async setRolePermissions(ctx: RequestContext, role: Exclude<WorkspaceRole, "owner">, permissions: string[] | null) {
    const w = ws(ctx);
    await this.entitlements.assertFeature(w.billingAccountId, "customRoles");
    if (permissions) {
      const trouble = rolePermissionTrouble(permissions);
      if (trouble) throw badRequest(trouble);
      // Nobody grants what they do not hold.
      const beyond = permissions.filter((p) => !w.permissions.includes(p));
      if (beyond.length) throw forbidden(`You cannot grant permissions you do not hold: ${beyond.join(", ")}`);
    }
    const row = await this.prisma.db.workspace.findUniqueOrThrow({ where: { id: w.id } });
    const overrides = { ...((row.rolePermissions ?? {}) as RolePermissionOverrides) };
    if (permissions) overrides[role] = permissions;
    else delete overrides[role];
    await this.prisma.db.workspace.update({ where: { id: w.id }, data: { rolePermissions: overrides } });
    await this.audit.record(ctx, { action: "workspace.role_permissions_changed", targetType: "role", targetId: role, metadata: { permissions } });
    return { role, permissions: permissionsFor(role, overrides), isDefault: !permissions, defaults: DEFAULT_ROLE_PERMISSIONS[role] };
  }

  // ─── Invitations (accepting) ───────────────────────────────────────────────

  async readInvitation(token: string) {
    const inv = await this.prisma.db.invitation.findUnique({ where: { tokenHash: hashToken(token) }, include: { workspace: true } });
    if (!inv || inv.revokedAt || inv.acceptedAt || inv.expiresAt.getTime() < Date.now()) {
      throw notFound("That invitation (it may have expired or been withdrawn)");
    }
    const existing = await this.prisma.db.user.findUnique({ where: { email: inv.email } });
    return { email: inv.email, role: inv.role, workspaceName: inv.workspace.name, accountExists: Boolean(existing) };
  }

  /** Accepts as the signed-in user, whose email must be the one invited. */
  async acceptInvitation(ctx: RequestContext, token: string) {
    const user = me(ctx);
    const inv = await this.prisma.db.invitation.findUnique({ where: { tokenHash: hashToken(token) }, include: { workspace: true } });
    if (!inv || inv.revokedAt || inv.acceptedAt || inv.expiresAt.getTime() < Date.now()) throw notFound("That invitation");
    if (inv.email !== user.email) throw forbidden(`This invitation was sent to ${inv.email}. Sign in with that address to accept it.`);
    return this.join(inv.id, inv.workspaceId, user.userId, inv.role);
  }

  /**
   * Refuses to accept an invitation the account's plan no longer has a seat
   * for (it was downgraded, or the trial ended, after the invitation was
   * sent). Called before an invitee's account is created, and again by join().
   */
  async assertInviteSeat(workspaceId: string, email: string) {
    const workspace = await this.prisma.db.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { billingAccountId: true } });
    await this.entitlements.assertSeat(workspace.billingAccountId, email);
  }

  async join(invitationId: string, workspaceId: string, userId: string, role: WorkspaceRole) {
    const invited = await this.prisma.db.invitation.findUniqueOrThrow({ where: { id: invitationId }, select: { email: true } });
    await this.assertInviteSeat(workspaceId, invited.email);
    await this.prisma.db.$transaction(async (tx) => {
      const claimed = await tx.invitation.updateMany({ where: { id: invitationId, acceptedAt: null }, data: { acceptedAt: new Date() } });
      if (!claimed.count) throw conflict("That invitation has already been used.");
      await tx.membership.upsert({
        where: { workspaceId_userId: { workspaceId, userId } },
        create: { workspaceId, userId, role },
        update: {},
      });
      // Following the emailed link proves the address.
      await tx.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
    });
    await this.audit.record(null, { workspaceId, action: "member.joined", targetType: "user", targetId: userId }, "user");
    return { workspaceId };
  }

  async auditLog(ctx: RequestContext, page: number, pageSize: number) {
    const w = ws(ctx);
    const where = { workspaceId: w.id };
    const [rows, total] = await Promise.all([
      this.prisma.db.auditEvent.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize }),
      this.prisma.db.auditEvent.count({ where }),
    ]);
    const actorIds = [...new Set(rows.map((r) => r.actorUserId).filter(Boolean))] as string[];
    const actors = await this.prisma.db.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true, email: true } });
    const byId = new Map(actors.map((a) => [a.id, a]));
    return {
      items: rows.map((r) => ({ ...r, actor: r.actorUserId ? (byId.get(r.actorUserId) ?? null) : null })),
      total,
      page,
      pageSize,
    };
  }

  async grantSupportAccess(ctx: RequestContext, hours: number, reason: string) {
    const w = ws(ctx);
    if (w.role !== "owner") throw forbidden("Only the owner can grant support access.");
    const grant = await this.prisma.db.supportAccessGrant.create({
      data: { workspaceId: w.id, grantedById: me(ctx).userId, reason, expiresAt: new Date(Date.now() + hours * 3600_000) },
    });
    await this.audit.record(ctx, { action: "support.access_granted", targetType: "support_grant", targetId: grant.id, metadata: { hours, reason } });
    return grant;
  }

  async revokeSupportAccess(ctx: RequestContext) {
    const w = ws(ctx);
    await this.prisma.db.supportAccessGrant.updateMany({ where: { workspaceId: w.id, revokedAt: null, expiresAt: { gt: new Date() } }, data: { revokedAt: new Date() } });
    await this.audit.record(ctx, { action: "support.access_revoked" });
  }

  async supportAccess(ctx: RequestContext) {
    const w = ws(ctx);
    return this.prisma.db.supportAccessGrant.findFirst({
      where: { workspaceId: w.id, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { expiresAt: "desc" },
    });
  }
}
