import { Injectable } from "@nestjs/common";
import {
  type FeatureKey,
  FEATURE_LABELS,
  type LimitKey,
  LIMIT_LABELS,
  type PlanFeatures,
  type PlanLimits,
  isUnlimited,
  readFeatures,
  readLimits,
} from "@growthdesk/shared";
import { PrismaService } from "../prisma/prisma.service.js";
import { PlatformSettingsService } from "../core/platform-settings.service.js";
import { limitReached, locked } from "../common/errors.js";
import type { Plan, Subscription } from "../generated/prisma/client.js";

export type AccessLevel = "full" | "restricted";

export type Entitlements = {
  billingAccountId: string;
  plan: Plan;
  /** The plan whose limits apply right now (the expired-plan fallback once a subscription lapses). */
  effectivePlan: Plan;
  subscription: Subscription | null;
  state: Subscription["status"] | "none";
  access: AccessLevel;
  limits: PlanLimits;
  features: PlanFeatures;
  reason: string;
};

/** "YYYY-MM" in UTC — the metering period. */
export const periodOf = (d = new Date()) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

/** Metered limits map to UsageCounter metrics. */
const METRIC: Partial<Record<LimitKey, string>> = { monthlyEmails: "emails", monthlyAiCredits: "ai_credits", monthlyMarketingEmails: "marketing_emails" };

/** Metered allowances that consume() can draw from. */
export type MeteredKey = "monthlyEmails" | "monthlyAiCredits" | "monthlyMarketingEmails";

/*
 * What a billing account may do, decided from its subscription — the policy
 * documented in docs/BILLING.md:
 *
 *   trialing (in trial) / active        → full access to the plan
 *   past_due inside the grace period    → full access, with a banner
 *   past_due after grace / incomplete   → restricted: CRM stays usable, but
 *                                          sending, launching, importing and
 *                                          connecting are refused
 *   canceled / expired / trial ended    → the "expired" plan (Free) applies;
 *                                          nothing is deleted, but creating
 *                                          beyond its limits is refused
 *
 * Every limit is enforced here, server-side, never only in the UI. Limits
 * apply to the whole billing account (summed across its workspaces).
 * Adapted from LinkDesk's entitlementsFor/subscriptionState.
 */
@Injectable()
export class EntitlementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly platform: PlatformSettingsService,
  ) {}

  async forAccount(billingAccountId: string, now = new Date()): Promise<Entitlements> {
    const settings = await this.platform.get();
    const sub = await this.prisma.db.subscription.findUnique({ where: { billingAccountId }, include: { plan: true } });
    const fallback =
      (await this.prisma.db.plan.findUnique({ where: { key: settings.expiredPlanKey } })) ??
      (await this.prisma.db.plan.findFirst({ orderBy: { sortOrder: "asc" } }));
    if (!fallback) throw new Error("No plans exist — run the seed (pnpm db:seed).");

    let effective: Plan = sub?.plan ?? fallback;
    let access: AccessLevel = "full";
    let reason = "";
    const state = sub?.status ?? "none";

    if (!sub) {
      effective = fallback;
      reason = "No subscription — the free allowance applies.";
    } else if (sub.status === "canceled" || sub.status === "expired") {
      effective = fallback;
      reason = "The subscription has ended — the free allowance applies until you choose a plan.";
    } else if (sub.status === "trialing" && sub.trialEndsAt && sub.trialEndsAt <= now) {
      effective = fallback;
      reason = "The trial has ended — choose a plan to keep your full allowance.";
    } else if (sub.status === "past_due") {
      if (!sub.graceUntil || sub.graceUntil <= now) {
        access = "restricted";
        reason = "Payment is overdue — sending and imports are paused until the invoice is paid.";
      } else {
        reason = "Payment is overdue — update your payment method to avoid interruption.";
      }
    } else if (sub.status === "incomplete") {
      access = "restricted";
      reason = "The subscription is waiting for its first payment.";
    } else if (sub.cancelAtPeriodEnd && sub.currentPeriodEnd && sub.currentPeriodEnd <= now) {
      effective = fallback;
      reason = "The subscription has ended — the free allowance applies until you choose a plan.";
    }

    return {
      billingAccountId,
      plan: sub?.plan ?? fallback,
      effectivePlan: effective,
      subscription: sub,
      state,
      access,
      limits: readLimits(effective.limits),
      features: readFeatures(effective.features),
      reason,
    };
  }

  private async accountWorkspaceIds(billingAccountId: string): Promise<string[]> {
    const rows = await this.prisma.db.workspace.findMany({ where: { billingAccountId }, select: { id: true } });
    return rows.map((r) => r.id);
  }

  /** Current usage of one limit, summed across the account's workspaces. */
  async usage(billingAccountId: string, key: LimitKey): Promise<number> {
    const ids = await this.accountWorkspaceIds(billingAccountId);
    if (!ids.length) return 0;
    const inIds = { in: ids };
    switch (key) {
      case "contacts":
        return this.prisma.db.contact.count({ where: { workspaceId: inIds, deletedAt: null } });
      case "mailboxes":
        return this.prisma.db.mailbox.count({ where: { workspaceId: inIds, deletedAt: null } });
      case "workspaces":
        return ids.length;
      case "activeCampaigns":
        return this.prisma.db.campaign.count({ where: { workspaceId: inIds, deletedAt: null, status: { in: ["scheduled", "running"] } } });
      case "channelIntegrations":
        return this.prisma.db.channelIntegration.count({ where: { workspaceId: inIds, deletedAt: null } });
      case "seats": {
        const members = await this.prisma.db.membership.findMany({ where: { workspaceId: { in: ids } }, select: { userId: true, user: { select: { email: true } } } });
        const emails = new Set(members.map((m) => m.user.email));
        const invites = await this.prisma.db.invitation.findMany({
          where: { workspaceId: { in: ids }, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
          select: { email: true },
        });
        for (const i of invites) emails.add(i.email);
        return emails.size;
      }
      case "sendingDomains":
        return this.prisma.db.sendingDomain.count({ where: { workspaceId: inIds, deletedAt: null } });
      case "marketingContacts": {
        // A contact counts once however many lists it is subscribed to.
        const rows = await this.prisma.db.listMembership.findMany({
          where: { workspaceId: inIds, status: "subscribed", contact: { deletedAt: null } },
          distinct: ["contactId"],
          select: { contactId: true },
        });
        return rows.length;
      }
      case "monthlyEmails":
      case "monthlyAiCredits":
      case "monthlyMarketingEmails": {
        const agg = await this.prisma.db.usageCounter.aggregate({
          where: { billingAccountId, metric: METRIC[key]!, period: periodOf() },
          _sum: { value: true },
        });
        return agg._sum.value ?? 0;
      }
    }
  }

  async summary(billingAccountId: string) {
    const ent = await this.forAccount(billingAccountId);
    const usage = {} as Record<LimitKey, { used: number; limit: number; label: string }>;
    for (const key of Object.keys(ent.limits) as LimitKey[]) {
      usage[key] = { used: await this.usage(billingAccountId, key), limit: ent.limits[key], label: LIMIT_LABELS[key] };
    }
    return { ...ent, usage };
  }

  /** Refuses unless the plan includes a feature. */
  async assertFeature(billingAccountId: string, feature: FeatureKey) {
    const ent = await this.forAccount(billingAccountId);
    if (!ent.features[feature]) {
      throw limitReached(`${FEATURE_LABELS[feature]} is not included in the ${ent.effectivePlan.name} plan. Upgrade to use it.`, {
        feature,
        plan: ent.effectivePlan.name,
      });
    }
    return ent;
  }

  /** Refuses unless `adding` more of a counted resource stays within the plan. */
  async assertCapacity(billingAccountId: string, key: LimitKey, adding = 1) {
    const ent = await this.forAccount(billingAccountId);
    const allowed = ent.limits[key];
    if (isUnlimited(allowed)) return ent;
    const used = await this.usage(billingAccountId, key);
    if (used + adding > allowed) {
      throw limitReached(
        `Your ${ent.effectivePlan.name} plan allows ${allowed.toLocaleString()} ${LIMIT_LABELS[key].toLowerCase()} and ${used.toLocaleString()} are in use. Upgrade to add more.`,
        { limit: key, used, allowed, plan: ent.effectivePlan.name },
      );
    }
    return ent;
  }

  /** How many more of a counted resource fit (Infinity when unlimited). */
  async remaining(billingAccountId: string, key: LimitKey): Promise<number> {
    const ent = await this.forAccount(billingAccountId);
    const allowed = ent.limits[key];
    if (isUnlimited(allowed)) return Number.POSITIVE_INFINITY;
    return Math.max(0, allowed - (await this.usage(billingAccountId, key)));
  }

  /** Refuses when the account is restricted (overdue) — used by everything that sends, launches, imports or connects. */
  async assertFullAccess(billingAccountId: string, what: string) {
    const ent = await this.forAccount(billingAccountId);
    if (ent.access !== "full") throw locked(`${ent.reason} (${what} is unavailable)`);
    return ent;
  }

  /**
   * Atomically consumes a metered allowance (emails, AI credits). An advisory
   * transaction lock per account+metric serialises concurrent workers, so the
   * monthly allowance cannot be overshot by a race. Returns false — rather
   * than throwing — when the allowance is exhausted, for callers that park
   * work instead of failing it.
   */
  async consume(workspaceId: string, billingAccountId: string, key: MeteredKey, n = 1): Promise<boolean> {
    const ent = await this.forAccount(billingAccountId);
    const allowed = ent.limits[key];
    const metric = METRIC[key]!;
    const period = periodOf();
    return this.prisma.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`usage:${billingAccountId}:${metric}`}))`;
      if (!isUnlimited(allowed)) {
        const agg = await tx.usageCounter.aggregate({ where: { billingAccountId, metric, period }, _sum: { value: true } });
        if ((agg._sum.value ?? 0) + n > allowed) return false;
      }
      await tx.usageCounter.upsert({
        where: { workspaceId_metric_period: { workspaceId, metric, period } },
        create: { workspaceId, billingAccountId, metric, period, value: n },
        update: { value: { increment: n } },
      });
      return true;
    });
  }

  async assertConsume(workspaceId: string, billingAccountId: string, key: MeteredKey, n = 1) {
    if (!(await this.consume(workspaceId, billingAccountId, key, n))) {
      const ent = await this.forAccount(billingAccountId);
      throw limitReached(`This month's ${LIMIT_LABELS[key].toLowerCase()} allowance on the ${ent.effectivePlan.name} plan is used up. It renews on the 1st, or upgrade for more.`, {
        limit: key,
        allowed: ent.limits[key],
        plan: ent.effectivePlan.name,
      });
    }
  }
}
