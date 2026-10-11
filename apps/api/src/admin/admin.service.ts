import { Injectable } from "@nestjs/common";
import {
  FEATURE_KEYS,
  LIMIT_KEYS,
  type BillingInterval,
  type PlatformRole,
  readFeatures,
  readLimits,
} from "@growthdesk/shared";
import type { Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { AuditService, type AuditInput } from "../core/audit.service.js";
import { CredentialReleaseService } from "../core/credential-release.service.js";
import { PlatformSettingsService, type PlatformSettings } from "../core/platform-settings.service.js";
import { SessionService } from "../auth/session.service.js";
import { EntitlementsService } from "../billing/entitlements.service.js";
import { BillingService } from "../billing/billing.service.js";
import { RevenueService } from "../revenue/revenue.service.js";
import { PLATFORM_RANK, me, type Identity, type RequestContext } from "../common/context.js";
import { badRequest, conflict, forbidden, notFound } from "../common/errors.js";
import { filteredUserIds, profileDetail, profilesFor, profileSummary, type ProfileRow, type UserFilter } from "./user-profile.js";

/*
 * Platform super-admin: the operator's view across every customer.
 *
 * Authorisation is the route's @Platform(min) rank (checked by AccessGuard);
 * this service adds the rules that depend on the target — nobody manages
 * their own account here, and only a platform owner manages someone at or
 * above their own rank.
 *
 * Identity, workspace, billing and platform models are not tenant models, so
 * the guarded client (`prisma.db`) reads them across customers as they are.
 * Usage counts go through EntitlementsService, which scopes by the account's
 * workspace ids. Only the overview's cross-customer message count needs
 * `prisma.unscoped` (said so at the call site).
 *
 * Every change is recorded with AuditService as a platform_admin action,
 * filed under the customer's workspace when it concerns one, so it also
 * appears in that customer's own audit log.
 */

type Paged<T> = { items: T[]; total: number; page: number; pageSize: number };
const paged = <T>(items: T[], total: number, page: number, pageSize: number): Paged<T> => ({ items, total, page, pageSize });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const insensitive = (q: string) => ({ contains: q, mode: "insensitive" as const });
const DAY = 86_400_000;

type UserRow = Prisma.UserGetPayload<{ include: { _count: { select: { memberships: true } } } }>;

function userDto(u: UserRow, profile?: ProfileRow | null) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    platformRole: u.platformRole,
    emailVerified: Boolean(u.emailVerifiedAt),
    disabledAt: u.suspendedAt,
    disabledReason: u.suspendedReason,
    lastLoginAt: u.lastLoginAt,
    createdAt: u.createdAt,
    workspaceCount: u._count.memberships,
    // PlatformUserProfile (Phase 3): signupSource, utmSource, tags, marketingConsent, anonymisedAt.
    ...profileSummary(profile),
  };
}

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly platform: PlatformSettingsService,
    private readonly sessions: SessionService,
    private readonly entitlements: EntitlementsService,
    private readonly billing: BillingService,
    private readonly revenue: RevenueService,
    private readonly credentials: CredentialReleaseService,
  ) {}

  private record(ctx: RequestContext, input: AuditInput) {
    return this.audit.record(ctx, { workspaceId: null, ...input }, "platform_admin");
  }

  // ─── Overview ──────────────────────────────────────────────────────────────

  /** `ctx` decides whether the MRR headline is included: revenue is admin-and-above (GET /admin/revenue's rank), support gets null. */
  async overview(ctx?: RequestContext) {
    const now = Date.now();
    const weekAgo = new Date(now - 7 * DAY);
    const dayAgo = new Date(now - DAY);
    const db = this.prisma.db;
    const [
      users,
      newUsers,
      disabledUsers,
      staff,
      workspaces,
      newWorkspaces,
      suspended,
      accounts,
      subs,
      openCases,
      pendingCases,
      activeGrants,
      mailSent,
      mailFailed,
      messagesSent,
      settings,
    ] = await Promise.all([
      db.user.count(),
      db.user.count({ where: { createdAt: { gte: weekAgo } } }),
      db.user.count({ where: { suspendedAt: { not: null } } }),
      db.user.count({ where: { platformRole: { not: "none" } } }),
      db.workspace.count(),
      db.workspace.count({ where: { createdAt: { gte: weekAgo } } }),
      db.workspace.count({ where: { status: "suspended" } }),
      db.billingAccount.count(),
      db.subscription.groupBy({ by: ["status"], _count: { _all: true } }),
      db.supportCase.count({ where: { status: "open" } }),
      db.supportCase.count({ where: { status: "pending" } }),
      db.supportAccessGrant.count({ where: { revokedAt: null, expiresAt: { gt: new Date() } } }),
      db.emailLog.count({ where: { createdAt: { gte: dayAgo }, status: "sent" } }),
      db.emailLog.count({ where: { createdAt: { gte: dayAgo }, status: "failed" } }),
      // Unscoped: a platform-wide total across every customer's workspaces (platform admin).
      this.prisma.unscoped.message.count({ where: { direction: "outbound", sentAt: { gte: dayAgo } } }),
      this.platform.get(),
    ]);
    const byStatus = Object.fromEntries(subs.map((s) => [s.status, s._count._all])) as Record<string, number>;
    const withSub = subs.reduce((n, s) => n + s._count._all, 0);
    return {
      users: { total: users, newThisWeek: newUsers, disabled: disabledUsers, staff },
      workspaces: { total: workspaces, newThisWeek: newWorkspaces, suspended },
      billing: { accounts, subscriptions: { ...byStatus, none: Math.max(0, accounts - withSub) } },
      support: { open: openCases, pending: pendingCases, activeGrants },
      platformMail: { sent24h: mailSent, failed24h: mailFailed },
      outreach: { messagesSent24h: messagesSent },
      settings: { maintenanceMode: settings.maintenanceMode, outreachEnabled: settings.outreachEnabled, signupsOpen: settings.signupsOpen, signupMode: settings.signupMode },
      revenue: ctx && PLATFORM_RANK[me(ctx).platformRole] >= PLATFORM_RANK.admin ? { mrr: await this.revenue.headline() } : null,
    };
  }

  // ─── Users ─────────────────────────────────────────────────────────────────

  /** Filters: see user-profile.ts (the profile filters need a join Prisma cannot express without a relation). */
  async listUsers(q: UserFilter & { page: number; pageSize: number }) {
    const { ids, total } = await filteredUserIds(this.prisma, q, q.page, q.pageSize);
    const [rows, profiles] = await Promise.all([
      this.prisma.db.user.findMany({ where: { id: { in: ids } }, include: { _count: { select: { memberships: true } } } }),
      profilesFor(this.prisma, ids),
    ]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const items = ids.flatMap((id) => {
      const u = byId.get(id);
      return u ? [userDto(u, profiles.get(id))] : [];
    });
    return paged(items, total, q.page, q.pageSize);
  }

  async userDetail(id: string) {
    const user = await this.findUser(id);
    const [memberships, accounts, sessions, audit, profile] = await Promise.all([
      this.prisma.db.membership.findMany({
        where: { userId: id },
        include: { workspace: { select: { id: true, name: true, status: true } } },
        orderBy: { createdAt: "asc" },
      }),
      this.prisma.db.billingAccount.findMany({ where: { ownerId: id }, select: { id: true, name: true }, orderBy: { createdAt: "asc" } }),
      this.prisma.db.session.findMany({
        where: { userId: id, revokedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { lastSeenAt: "desc" },
        select: { id: true, ip: true, userAgent: true, createdAt: true, lastSeenAt: true },
      }),
      this.prisma.db.auditEvent.findMany({
        where: { OR: [{ actorUserId: id }, { targetType: "user", targetId: id }] },
        orderBy: { createdAt: "desc" },
        take: 20,
      }),
      this.prisma.db.platformUserProfile.findUnique({ where: { userId: id } }),
    ]);
    return {
      ...userDto(user, profile),
      profile: profileDetail(profile),
      hasPassword: Boolean(user.passwordHash),
      googleLinked: Boolean(user.googleSub),
      twoFactorEnabledAt: user.totpEnabledAt,
      memberships: memberships.map((m) => ({ workspaceId: m.workspace.id, workspaceName: m.workspace.name, workspaceStatus: m.workspace.status, role: m.role, joinedAt: m.createdAt })),
      billingAccounts: accounts,
      sessions,
      recentAudit: audit,
    };
  }

  private async findUser(id: string) {
    if (!UUID.test(id)) throw notFound("That user");
    const user = await this.prisma.db.user.findUnique({ where: { id }, include: { _count: { select: { memberships: true } } } });
    if (!user) throw notFound("That user");
    return user;
  }

  /**
   * Nobody manages their own account from here, and only a platform owner
   * manages someone at or above their own rank.
   */
  assertMayManage(actor: Identity, target: { id: string; platformRole: PlatformRole }, verb: string) {
    if (actor.userId === target.id) throw forbidden(`You cannot ${verb} your own account from platform admin.`);
    if (actor.platformRole === "owner") return;
    if (PLATFORM_RANK[target.platformRole] >= PLATFORM_RANK[actor.platformRole]) {
      throw forbidden(`Only a platform owner can ${verb} a platform ${target.platformRole}.`);
    }
  }

  async disableUser(ctx: RequestContext, id: string, reason: string) {
    const actor = me(ctx);
    const user = await this.findUser(id);
    this.assertMayManage(actor, user, "disable");
    await this.prisma.db.user.update({ where: { id }, data: { suspendedAt: user.suspendedAt ?? new Date(), suspendedReason: reason } });
    await this.sessions.revokeAllFor(id);
    // Sessions alone are not enough: their API keys would keep working. Re-enabling the account does not bring them back.
    await this.credentials.releaseEverywhere(ctx, id, "user_disabled", "platform_admin");
    await this.record(ctx, { action: "platform.user_disabled", targetType: "user", targetId: id, metadata: { email: user.email, reason } });
    return this.userDetail(id);
  }

  async enableUser(ctx: RequestContext, id: string) {
    const actor = me(ctx);
    const user = await this.findUser(id);
    this.assertMayManage(actor, user, "enable");
    if (!user.suspendedAt) throw conflict("This account is not disabled.");
    await this.prisma.db.user.update({ where: { id }, data: { suspendedAt: null, suspendedReason: "" } });
    await this.record(ctx, { action: "platform.user_enabled", targetType: "user", targetId: id, metadata: { email: user.email } });
    return this.userDetail(id);
  }

  async setPlatformRole(ctx: RequestContext, id: string, role: PlatformRole) {
    const actor = me(ctx);
    const user = await this.findUser(id);
    this.assertMayManage(actor, user, "change the platform role of");
    if (actor.platformRole !== "owner" && PLATFORM_RANK[role] >= PLATFORM_RANK[actor.platformRole]) {
      throw forbidden("Only a platform owner can make someone a platform admin or owner.");
    }
    if (role === user.platformRole) return this.userDetail(id);
    await this.prisma.db.user.update({ where: { id }, data: { platformRole: role } });
    await this.record(ctx, { action: "platform.role_changed", targetType: "user", targetId: id, metadata: { email: user.email, from: user.platformRole, to: role } });
    return this.userDetail(id);
  }

  async signOutUser(ctx: RequestContext, id: string) {
    const actor = me(ctx);
    const user = await this.findUser(id);
    this.assertMayManage(actor, user, "sign out");
    const { count } = await this.prisma.db.session.updateMany({
      where: { userId: id, revokedAt: null, expiresAt: { gt: new Date() } },
      data: { revokedAt: new Date() },
    });
    await this.record(ctx, { action: "platform.user_signed_out", targetType: "user", targetId: id, metadata: { email: user.email, sessions: count } });
    return { sessionsEnded: count };
  }

  // ─── Workspaces ────────────────────────────────────────────────────────────

  async listWorkspaces(q: { page: number; pageSize: number; q?: string; status?: "active" | "suspended" }) {
    const where: Prisma.WorkspaceWhereInput = {};
    if (q.q) {
      where.OR = [
        { name: insensitive(q.q) },
        { slug: insensitive(q.q) },
        { billingAccount: { owner: { email: insensitive(q.q) } } },
        ...(UUID.test(q.q) ? [{ id: q.q }, { billingAccountId: q.q }] : []),
      ];
    }
    if (q.status) where.status = q.status;
    const [rows, total] = await Promise.all([
      this.prisma.db.workspace.findMany({
        where,
        include: {
          billingAccount: {
            select: { id: true, name: true, owner: { select: { id: true, email: true, name: true } }, subscription: { select: { status: true, provider: true, plan: { select: { key: true, name: true } } } } },
          },
          _count: { select: { memberships: true } },
        },
        orderBy: { createdAt: "desc" },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      this.prisma.db.workspace.count({ where }),
    ]);
    return paged(
      rows.map((w) => ({
        id: w.id,
        name: w.name,
        slug: w.slug,
        status: w.status,
        suspendedReason: w.suspendedReason,
        createdAt: w.createdAt,
        members: w._count.memberships,
        billingAccount: { id: w.billingAccount.id, name: w.billingAccount.name, owner: w.billingAccount.owner },
        subscription: w.billingAccount.subscription
          ? { status: w.billingAccount.subscription.status, provider: w.billingAccount.subscription.provider, plan: w.billingAccount.subscription.plan }
          : null,
      })),
      total,
      q.page,
      q.pageSize,
    );
  }

  private async findWorkspace(id: string) {
    if (!UUID.test(id)) throw notFound("That workspace");
    const w = await this.prisma.db.workspace.findUnique({ where: { id } });
    if (!w) throw notFound("That workspace");
    return w;
  }

  async workspaceDetail(id: string) {
    const w = await this.findWorkspace(id);
    const [account, members, invitations, grant, openCases, audit, summary] = await Promise.all([
      this.prisma.db.billingAccount.findUniqueOrThrow({
        where: { id: w.billingAccountId },
        include: { owner: { select: { id: true, email: true, name: true } }, _count: { select: { workspaces: true } } },
      }),
      this.prisma.db.membership.findMany({
        where: { workspaceId: id },
        include: { user: { select: { id: true, email: true, name: true, suspendedAt: true, lastLoginAt: true } } },
        orderBy: { createdAt: "asc" },
      }),
      this.prisma.db.invitation.count({ where: { workspaceId: id, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } } }),
      this.activeGrant(id),
      this.prisma.db.supportCase.count({ where: { workspaceId: id, status: { not: "closed" } } }),
      this.prisma.db.auditEvent.findMany({ where: { workspaceId: id }, orderBy: { createdAt: "desc" }, take: 15 }),
      this.entitlements.summary(w.billingAccountId),
    ]);
    return {
      id: w.id,
      name: w.name,
      slug: w.slug,
      businessType: w.businessType,
      timezone: w.timezone,
      currency: w.currency,
      status: w.status,
      suspendedReason: w.suspendedReason,
      suspendedAt: w.suspendedAt,
      createdAt: w.createdAt,
      billingAccount: { id: account.id, name: account.name, owner: account.owner, workspaces: account._count.workspaces },
      plan: this.planSummary(summary),
      members: members.map((m) => ({
        userId: m.user.id,
        email: m.user.email,
        name: m.user.name,
        role: m.role,
        disabled: Boolean(m.user.suspendedAt),
        lastLoginAt: m.user.lastLoginAt,
        joinedAt: m.createdAt,
      })),
      pendingInvitations: invitations,
      supportGrant: grant,
      openSupportCases: openCases,
      recentAudit: audit,
    };
  }

  async activeGrant(workspaceId: string) {
    const grant = await this.prisma.db.supportAccessGrant.findFirst({
      where: { workspaceId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { expiresAt: "desc" },
    });
    if (!grant) return null;
    const by = await this.prisma.db.user.findUnique({ where: { id: grant.grantedById }, select: { id: true, email: true, name: true } });
    return { id: grant.id, reason: grant.reason, expiresAt: grant.expiresAt, createdAt: grant.createdAt, grantedBy: by };
  }

  private planSummary(s: Awaited<ReturnType<EntitlementsService["summary"]>>) {
    const sub = s.subscription;
    return {
      key: s.plan.key,
      name: s.plan.name,
      effectiveKey: s.effectivePlan.key,
      effectiveName: s.effectivePlan.name,
      state: s.state,
      access: s.access,
      reason: s.reason,
      usage: s.usage,
      features: s.features,
      subscription: sub
        ? {
            status: sub.status,
            interval: sub.interval,
            provider: sub.provider,
            providerCustomerId: sub.providerCustomerId,
            providerSubscriptionId: sub.providerSubscriptionId,
            currentPeriodStart: sub.currentPeriodStart,
            currentPeriodEnd: sub.currentPeriodEnd,
            trialEndsAt: sub.trialEndsAt,
            cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
            canceledAt: sub.canceledAt,
            graceUntil: sub.graceUntil,
          }
        : null,
    };
  }

  async suspendWorkspace(ctx: RequestContext, id: string, reason: string) {
    const w = await this.findWorkspace(id);
    if (w.status === "suspended") throw conflict("This workspace is already suspended.");
    await this.prisma.db.workspace.update({ where: { id }, data: { status: "suspended", suspendedReason: reason, suspendedAt: new Date() } });
    await this.record(ctx, { workspaceId: id, action: "platform.workspace_suspended", targetType: "workspace", targetId: id, metadata: { reason } });
    return this.workspaceDetail(id);
  }

  async unsuspendWorkspace(ctx: RequestContext, id: string) {
    const w = await this.findWorkspace(id);
    if (w.status !== "suspended") throw conflict("This workspace is not suspended.");
    await this.prisma.db.workspace.update({ where: { id }, data: { status: "active", suspendedReason: "", suspendedAt: null } });
    await this.record(ctx, { workspaceId: id, action: "platform.workspace_unsuspended", targetType: "workspace", targetId: id, metadata: { previousReason: w.suspendedReason } });
    return this.workspaceDetail(id);
  }

  // ─── Billing accounts ──────────────────────────────────────────────────────

  async listBillingAccounts(q: { page: number; pageSize: number; q?: string; status?: string }) {
    const where: Prisma.BillingAccountWhereInput = {};
    if (q.q) {
      where.OR = [
        { name: insensitive(q.q) },
        { billingEmail: insensitive(q.q) },
        { owner: { email: insensitive(q.q) } },
        { workspaces: { some: { name: insensitive(q.q) } } },
        ...(UUID.test(q.q) ? [{ id: q.q }] : []),
      ];
    }
    if (q.status === "none") where.subscription = { is: null };
    else if (q.status) where.subscription = { is: { status: q.status as Prisma.EnumSubscriptionStatusFilter["equals"] } };
    const [rows, total] = await Promise.all([
      this.prisma.db.billingAccount.findMany({
        where,
        include: {
          owner: { select: { id: true, email: true, name: true } },
          subscription: { include: { plan: { select: { key: true, name: true } } } },
          _count: { select: { workspaces: true } },
        },
        orderBy: { createdAt: "desc" },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      this.prisma.db.billingAccount.count({ where }),
    ]);
    return paged(
      rows.map((a) => ({
        id: a.id,
        name: a.name,
        billingEmail: a.billingEmail,
        owner: a.owner,
        workspaces: a._count.workspaces,
        createdAt: a.createdAt,
        subscription: a.subscription
          ? {
              status: a.subscription.status,
              provider: a.subscription.provider,
              interval: a.subscription.interval,
              plan: a.subscription.plan,
              trialEndsAt: a.subscription.trialEndsAt,
              currentPeriodEnd: a.subscription.currentPeriodEnd,
            }
          : null,
      })),
      total,
      q.page,
      q.pageSize,
    );
  }

  async billingAccountDetail(id: string) {
    if (!UUID.test(id)) throw notFound("That billing account");
    const account = await this.prisma.db.billingAccount.findUnique({
      where: { id },
      include: {
        owner: { select: { id: true, email: true, name: true } },
        workspaces: { select: { id: true, name: true, status: true, createdAt: true }, orderBy: { createdAt: "asc" } },
      },
    });
    if (!account) throw notFound("That billing account");
    const [summary, invoices, events, plans] = await Promise.all([
      this.entitlements.summary(id),
      this.prisma.db.invoice.findMany({ where: { billingAccountId: id }, orderBy: { issuedAt: "desc" }, take: 24 }),
      this.prisma.db.billingEvent.findMany({
        where: { billingAccountId: id },
        orderBy: { receivedAt: "desc" },
        take: 20,
        select: { id: true, provider: true, type: true, receivedAt: true, processedAt: true, error: true, attempts: true },
      }),
      this.prisma.db.plan.findMany({ orderBy: { sortOrder: "asc" }, select: { key: true, name: true, isActive: true, isPublic: true } }),
    ]);
    const sub = summary.subscription;
    const stripeManaged = Boolean(sub && sub.provider === "stripe" && sub.providerSubscriptionId && ["active", "trialing", "past_due"].includes(sub.status));
    return {
      id: account.id,
      name: account.name,
      billingEmail: account.billingEmail,
      country: account.country,
      taxId: account.taxId,
      address: account.address,
      createdAt: account.createdAt,
      owner: account.owner,
      workspaces: account.workspaces,
      plan: this.planSummary(summary),
      invoices: invoices.map((i) => ({
        id: i.id,
        provider: i.provider,
        number: i.number,
        status: i.status,
        currency: i.currency,
        amountDueCents: i.amountDueCents,
        amountPaidCents: i.amountPaidCents,
        hostedUrl: i.hostedUrl,
        pdfUrl: i.pdfUrl,
        issuedAt: i.issuedAt,
        paidAt: i.paidAt,
      })),
      billingEvents: events,
      /** docs/BILLING.md: a manual plan never overrides an active Stripe subscription. */
      manualAssign: stripeManaged
        ? { allowed: false, reason: "This account pays through Stripe. Change or cancel the subscription in Stripe; the change arrives here by webhook." }
        : { allowed: true, reason: "" },
      plans,
    };
  }

  async assignPlan(
    ctx: RequestContext,
    id: string,
    input: { planKey: string; interval: BillingInterval; status: "active" | "trialing"; periodEnd?: Date | null; reason: string },
  ) {
    if (!UUID.test(id)) throw notFound("That billing account");
    const account = await this.prisma.db.billingAccount.findUnique({ where: { id }, include: { _count: { select: { workspaces: true } } } });
    if (!account) throw notFound("That billing account");
    if (input.periodEnd && input.periodEnd.getTime() <= Date.now()) throw badRequest("The end date must be in the future.", { periodEnd: "Must be in the future" });
    // BillingService refuses to override an active Stripe subscription and audits per workspace.
    await this.billing.adminAssign(ctx, id, input);
    if (!account._count.workspaces) {
      await this.record(ctx, { action: "platform.plan_assigned", targetType: "billing_account", targetId: id, metadata: { plan: input.planKey, reason: input.reason } });
    }
    return this.billingAccountDetail(id);
  }

  // ─── Plans ─────────────────────────────────────────────────────────────────

  async listPlans() {
    const [plans, counts, settings] = await Promise.all([
      this.prisma.db.plan.findMany({ orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] }),
      this.prisma.db.subscription.groupBy({ by: ["planId"], _count: { _all: true } }),
      this.platform.get(),
    ]);
    const byPlan = new Map(counts.map((c) => [c.planId, c._count._all]));
    return plans.map((p) => ({
      id: p.id,
      key: p.key,
      name: p.name,
      description: p.description,
      isActive: p.isActive,
      isPublic: p.isPublic,
      sortOrder: p.sortOrder,
      currency: p.currency,
      monthlyPriceCents: p.monthlyPriceCents,
      annualPriceCents: p.annualPriceCents,
      trialDays: p.trialDays,
      limits: readLimits(p.limits),
      features: readFeatures(p.features),
      providerPrices: p.providerPrices,
      subscriptions: byPlan.get(p.id) ?? 0,
      isDefault: p.key === settings.defaultPlanKey,
      isExpiredFallback: p.key === settings.expiredPlanKey,
      updatedAt: p.updatedAt,
    }));
  }

  private planData(input: {
    name: string;
    description?: string;
    isActive: boolean;
    isPublic: boolean;
    sortOrder: number;
    currency: string;
    monthlyPriceCents: number;
    annualPriceCents: number;
    trialDays: number;
    limits: Record<string, number>;
    features: Record<string, boolean>;
    providerPrices: Record<string, Record<string, string>>;
  }) {
    const unknownLimit = Object.keys(input.limits).find((k) => !(LIMIT_KEYS as readonly string[]).includes(k));
    if (unknownLimit) throw badRequest(`Unknown limit "${unknownLimit}"`, { limits: `Unknown limit "${unknownLimit}"` });
    const missing = LIMIT_KEYS.find((k) => input.limits[k] === undefined);
    if (missing) throw badRequest(`Set the "${missing}" limit (-1 for unlimited)`, { limits: `Missing "${missing}"` });
    const unknownFeature = Object.keys(input.features).find((k) => !(FEATURE_KEYS as readonly string[]).includes(k));
    if (unknownFeature) throw badRequest(`Unknown feature "${unknownFeature}"`, { features: `Unknown feature "${unknownFeature}"` });
    for (const [provider, prices] of Object.entries(input.providerPrices)) {
      const bad = Object.keys(prices).find((k) => k !== "month" && k !== "year");
      if (bad) throw badRequest(`Provider prices are per "month" or "year", not "${bad}"`, { providerPrices: `${provider}: unknown interval "${bad}"` });
    }
    // Empty price ids are dropped, so "no price" stays absent rather than "".
    const providerPrices = Object.fromEntries(
      Object.entries(input.providerPrices)
        .map(([provider, prices]) => [provider, Object.fromEntries(Object.entries(prices).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v))])
        .filter(([, prices]) => Object.keys(prices as object).length),
    );
    return {
      name: input.name,
      description: input.description ?? "",
      isActive: input.isActive,
      isPublic: input.isPublic,
      sortOrder: input.sortOrder,
      currency: input.currency,
      monthlyPriceCents: input.monthlyPriceCents,
      annualPriceCents: input.annualPriceCents,
      trialDays: input.trialDays,
      limits: readLimits(input.limits) as never,
      features: readFeatures(input.features) as never,
      providerPrices: providerPrices as never,
    };
  }

  async createPlan(ctx: RequestContext, input: Parameters<AdminService["planData"]>[0] & { key: string }) {
    if (await this.prisma.db.plan.findUnique({ where: { key: input.key } })) {
      throw conflict(`A plan with the key "${input.key}" already exists.`, { key: "Already used" });
    }
    const { data, notices } = await this.checkedPlanData(input);
    const plan = await this.prisma.db.plan.create({ data: { key: input.key, ...data } });
    await this.record(ctx, { action: "platform.plan_created", targetType: "plan", targetId: plan.id, metadata: { key: plan.key, name: plan.name } });
    return { ...(await this.listPlans()).find((p) => p.key === plan.key)!, priceNotices: notices };
  }

  /** planData, with the amounts and currency taken from the provider's prices (BillingService.verifyPlanPrices). */
  private async checkedPlanData(input: Parameters<AdminService["planData"]>[0]) {
    const data = this.planData(input);
    const { notices, ...prices } = await this.billing.verifyPlanPrices(data.providerPrices as Record<string, Record<string, string>>, data);
    return { data: { ...data, ...prices }, notices };
  }

  async updatePlan(ctx: RequestContext, key: string, input: Parameters<AdminService["planData"]>[0]) {
    const plan = await this.prisma.db.plan.findUnique({ where: { key } });
    if (!plan) throw notFound("That plan");
    const settings = await this.platform.get();
    if (!input.isActive && (key === settings.defaultPlanKey || key === settings.expiredPlanKey)) {
      throw conflict(
        key === settings.defaultPlanKey
          ? "New workspaces start on this plan. Choose another default plan in Settings before deactivating it."
          : "Lapsed subscriptions fall back to this plan. Choose another fallback plan in Settings before deactivating it.",
      );
    }
    const { data, notices } = await this.checkedPlanData(input);
    const changed = (Object.keys(data) as (keyof typeof data)[]).filter((k) => JSON.stringify(data[k]) !== JSON.stringify((plan as Record<string, unknown>)[k]));
    await this.prisma.db.plan.update({ where: { key }, data });
    await this.record(ctx, { action: "platform.plan_updated", targetType: "plan", targetId: plan.id, metadata: { key, changed } });
    return { ...(await this.listPlans()).find((p) => p.key === key)!, priceNotices: notices };
  }

  // ─── Platform settings ─────────────────────────────────────────────────────

  async settings() {
    const [view, plans] = await Promise.all([
      this.platform.publicView(),
      this.prisma.db.plan.findMany({ orderBy: { sortOrder: "asc" }, select: { key: true, name: true, isActive: true } }),
    ]);
    return { ...view, plans };
  }

  async updateSettings(ctx: RequestContext, patch: Partial<PlatformSettings> & { aiApiKey?: string; resendApiKey?: string; resendWebhookSecret?: string }) {
    for (const key of ["defaultPlanKey", "expiredPlanKey"] as const) {
      const value = patch[key];
      if (value === undefined) continue;
      const plan = await this.prisma.db.plan.findUnique({ where: { key: value } });
      if (!plan) throw badRequest("That plan does not exist", { [key]: "Unknown plan" });
      if (!plan.isActive) throw badRequest("Choose an active plan", { [key]: "This plan is not active" });
    }
    if (patch.extraBlockedDomains) {
      const domains = [...new Set(patch.extraBlockedDomains.map((d) => d.trim().toLowerCase().replace(/^@/, "")).filter(Boolean))];
      const bad = domains.find((d) => !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d));
      if (bad) throw badRequest(`"${bad}" is not a domain name`, { extraBlockedDomains: `"${bad}" is not a domain name` });
      patch.extraBlockedDomains = domains;
    }
    // signupMode is the source of truth; the older signupsOpen switch follows it (closed ⇔ !signupsOpen).
    // Turning signupsOpen on only reopens a closed install; it leaves invite-only or waitlist as they are.
    if (patch.signupMode !== undefined) {
      patch.signupsOpen = patch.signupMode !== "closed";
    } else if (patch.signupsOpen !== undefined) {
      const current = await this.platform.get();
      const mode = !current.signupsOpen && current.signupMode === "open" ? "closed" : current.signupMode;
      if (!patch.signupsOpen) patch.signupMode = "closed";
      else if (mode === "closed") patch.signupMode = "open";
    }
    if (patch.signupDomains) {
      const domains = [...new Set(patch.signupDomains.map((d) => d.trim().toLowerCase().replace(/^@/, "")).filter(Boolean))];
      const bad = domains.find((d) => !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d));
      if (bad) throw badRequest(`"${bad}" is not a domain name`, { signupDomains: `"${bad}" is not a domain name` });
      patch.signupDomains = domains;
    }
    const before = await this.platform.get();
    await this.platform.update(patch, me(ctx).userId);
    const changes: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) {
      // Secrets are never written to the audit trail, only that they changed.
      if (k === "aiApiKey" || k === "resendApiKey" || k === "resendWebhookSecret") changes[k] = v ? "replaced" : "cleared";
      else if (JSON.stringify(v) !== JSON.stringify(before[k as keyof PlatformSettings])) changes[k] = v;
    }
    if (Object.keys(changes).length) {
      await this.record(ctx, { action: "platform.settings_updated", targetType: "platform_settings", metadata: { changes } });
    }
    return this.settings();
  }

  // ─── Audit log ─────────────────────────────────────────────────────────────

  async auditLog(q: { page: number; pageSize: number; workspaceId?: string; actorUserId?: string; action?: string; actorType?: string }) {
    const where: Prisma.AuditEventWhereInput = {};
    if (q.workspaceId) where.workspaceId = q.workspaceId;
    if (q.actorUserId) where.actorUserId = q.actorUserId;
    if (q.action) where.action = { startsWith: q.action };
    if (q.actorType) where.actorType = q.actorType;
    const [rows, total] = await Promise.all([
      this.prisma.db.auditEvent.findMany({ where, orderBy: { createdAt: "desc" }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      this.prisma.db.auditEvent.count({ where }),
    ]);
    const actorIds = [...new Set(rows.map((r) => r.actorUserId).filter((v): v is string => Boolean(v)))];
    const workspaceIds = [...new Set(rows.map((r) => r.workspaceId).filter((v): v is string => Boolean(v)))];
    const [actors, workspaces] = await Promise.all([
      this.prisma.db.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true, email: true } }),
      this.prisma.db.workspace.findMany({ where: { id: { in: workspaceIds } }, select: { id: true, name: true } }),
    ]);
    const actorById = new Map(actors.map((a) => [a.id, a]));
    const wsById = new Map(workspaces.map((w) => [w.id, w]));
    return paged(
      rows.map((r) => ({
        ...r,
        actor: r.actorUserId ? (actorById.get(r.actorUserId) ?? null) : null,
        workspace: r.workspaceId ? (wsById.get(r.workspaceId) ?? null) : null,
      })),
      total,
      q.page,
      q.pageSize,
    );
  }

  // ─── Platform email log ────────────────────────────────────────────────────

  async emailLog(q: { page: number; pageSize: number; q?: string; status?: string; template?: string; stream?: string; provider?: string; userId?: string }) {
    const where: Prisma.EmailLogWhereInput = {};
    // q: recipient or subject (platform-mail adds subjects; older rows have "").
    if (q.q) where.OR = [{ to: insensitive(q.q) }, { subject: insensitive(q.q) }];
    if (q.status) where.status = q.status;
    if (q.template) where.template = q.template;
    if (q.stream) where.stream = q.stream;
    if (q.provider) where.provider = q.provider;
    if (q.userId) where.userId = q.userId;
    const [rows, total, templates] = await Promise.all([
      this.prisma.db.emailLog.findMany({ where, orderBy: { createdAt: "desc" }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      this.prisma.db.emailLog.count({ where }),
      this.prisma.db.emailLog.groupBy({ by: ["template"], _count: { _all: true }, orderBy: { template: "asc" } }),
    ]);
    return { ...paged(rows, total, q.page, q.pageSize), templates: templates.map((t) => t.template) };
  }
}
