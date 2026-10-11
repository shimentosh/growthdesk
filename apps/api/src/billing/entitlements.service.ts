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
import { PrismaService, type Tx } from "../prisma/prisma.service.js";
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

const DAY_MS = 86_400_000;
const ymd = (y: number, m: number, d: number) => `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

/**
 * The metering period a moment falls in. Monthly allowances renew on the
 * subscription's billing day (the UTC day of month its current period started;
 * annual plans renew their monthly allowance on the same day each month), not
 * on the calendar 1st. A billing day past the end of a short month falls on
 * its last day. `key` is the period's first day ("YYYY-MM-DD"), which is what
 * UsageCounter.period stores; `resetsAt` is when the next period starts.
 * Without an anchor the calendar month applies.
 */
export function meterPeriod(anchor: Date | null | undefined, now = new Date()): { key: string; resetsAt: Date } {
  const day = anchor ? anchor.getUTCDate() : 1;
  let y = now.getUTCFullYear();
  let m = now.getUTCMonth();
  if (now.getUTCDate() < Math.min(day, daysIn(y, m))) {
    m -= 1;
    if (m < 0) {
      m = 11;
      y -= 1;
    }
  }
  const ny = m === 11 ? y + 1 : y;
  const nm = (m + 1) % 12;
  return {
    key: ymd(y, m, Math.min(day, daysIn(y, m))),
    resetsAt: new Date(Date.UTC(ny, nm, Math.min(day, daysIn(ny, nm)))),
  };
}

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
 *   / an assigned (manual) plan whose     nothing is deleted, but creating
 *     end date has passed                 beyond its limits is refused
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
    } else if (sub.provider === "manual" && sub.currentPeriodEnd && sub.currentPeriodEnd <= now) {
      // An assigned plan with an end date lapses on it, even before the hourly job marks it expired.
      effective = fallback;
      reason = "The assigned plan has ended — the free allowance applies until you choose a plan.";
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

  private async accountWorkspaceIds(billingAccountId: string, db: Tx = this.prisma.db): Promise<string[]> {
    // A deleted workspace awaiting its purge no longer counts against the plan.
    const rows = await db.workspace.findMany({ where: { billingAccountId, deletedAt: null }, select: { id: true } });
    return rows.map((r) => r.id);
  }

  /** The account's current metering period (its subscription's billing day; see meterPeriod). */
  async meterPeriodFor(billingAccountId: string, now = new Date(), db: Tx = this.prisma.db) {
    const sub = await db.subscription.findUnique({ where: { billingAccountId }, select: { currentPeriodStart: true } });
    return meterPeriod(sub?.currentPeriodStart, now);
  }

  /** The emails holding a seat: members plus unexpired pending invitations, across the given workspaces. */
  private async seatEmails(ids: string[], db: Tx = this.prisma.db) {
    const members = await db.membership.findMany({ where: { workspaceId: { in: ids } }, select: { user: { select: { email: true } } } });
    const memberEmails = new Set(members.map((m) => m.user.email));
    const invites = await db.invitation.findMany({
      where: { workspaceId: { in: ids }, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { email: true },
    });
    return { memberEmails, all: new Set([...memberEmails, ...invites.map((i) => i.email)]) };
  }

  /**
   * Current usage of one limit, summed across the account's workspaces — or,
   * with `workspaceId`, counted in that workspace only (what a workspace admin
   * who does not own the billing account is shown). `db` lets a caller count
   * inside its own transaction.
   */
  async usage(billingAccountId: string, key: LimitKey, opts: { db?: Tx; workspaceId?: string } = {}): Promise<number> {
    const db = opts.db ?? this.prisma.db;
    const ids = opts.workspaceId ? [opts.workspaceId] : await this.accountWorkspaceIds(billingAccountId, db);
    if (!ids.length) return 0;
    const inIds = { in: ids };
    switch (key) {
      case "contacts":
        return db.contact.count({ where: { workspaceId: inIds, deletedAt: null } });
      case "mailboxes":
        return db.mailbox.count({ where: { workspaceId: inIds, deletedAt: null } });
      case "workspaces":
        return ids.length;
      case "activeCampaigns":
        return db.campaign.count({ where: { workspaceId: inIds, deletedAt: null, status: { in: ["scheduled", "running"] } } });
      case "channelIntegrations":
        return db.channelIntegration.count({ where: { workspaceId: inIds, deletedAt: null } });
      case "seats":
        return (await this.seatEmails(ids, db)).all.size;
      case "sendingDomains":
        return db.sendingDomain.count({ where: { workspaceId: inIds, deletedAt: null } });
      case "marketingContacts": {
        // A contact counts once however many lists it is subscribed to.
        const rows = await db.listMembership.findMany({
          where: { workspaceId: inIds, status: "subscribed", contact: { deletedAt: null } },
          distinct: ["contactId"],
          select: { contactId: true },
        });
        return rows.length;
      }
      case "monthlyEmails":
      case "monthlyAiCredits":
      case "monthlyMarketingEmails": {
        const { key: period } = await this.meterPeriodFor(billingAccountId, new Date(), db);
        const agg = await db.usageCounter.aggregate({
          where: { billingAccountId, metric: METRIC[key]!, period, ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}) },
          _sum: { value: true },
        });
        return agg._sum.value ?? 0;
      }
    }
  }

  async summary(billingAccountId: string, workspaceId?: string) {
    const ent = await this.forAccount(billingAccountId);
    const usage = {} as Record<LimitKey, { used: number; limit: number; label: string }>;
    for (const key of Object.keys(ent.limits) as LimitKey[]) {
      usage[key] = { used: await this.usage(billingAccountId, key, { workspaceId }), limit: ent.limits[key], label: LIMIT_LABELS[key] };
    }
    const { resetsAt } = await this.meterPeriodFor(billingAccountId);
    return { ...ent, usage, meterResetsAt: resetsAt };
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
    if (used + adding > allowed) throw this.overCapacity(ent, key, used);
    return ent;
  }

  private overCapacity(ent: Entitlements, key: LimitKey, used: number) {
    const allowed = ent.limits[key];
    return limitReached(
      `Your ${ent.effectivePlan.name} plan allows ${allowed.toLocaleString()} ${LIMIT_LABELS[key].toLowerCase()} and ${used.toLocaleString()} are in use. Upgrade to add more.`,
      { limit: key, used, allowed, plan: ent.effectivePlan.name },
    );
  }

  /**
   * assertCapacity inside the caller's transaction, under an advisory lock per
   * account and limit (as consume() does), for the transaction that creates the
   * resource. Parallel creators queue on the lock and each counts what the
   * others committed, so concurrent imports and API calls cannot overshoot the
   * limit. The lock is held until the caller's transaction ends.
   */
  async assertCapacityIn(tx: Tx, billingAccountId: string, key: LimitKey, adding = 1) {
    const ent = await this.forAccount(billingAccountId);
    if (isUnlimited(ent.limits[key])) return ent;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`capacity:${billingAccountId}:${key}`}))`;
    const used = await this.usage(billingAccountId, key, { db: tx });
    if (used + adding > ent.limits[key]) throw this.overCapacity(ent, key, used);
    return ent;
  }

  /**
   * Refuses unless `email` can hold a seat. Seats are distinct emails (members
   * and unexpired invitations), so someone who is already a member somewhere
   * in the account costs nothing; anyone else is refused when the account,
   * counted with them, would exceed the plan. Used when inviting, when
   * resending an invitation (an expired one stopped counting) and when an
   * invitation is accepted (the plan may have shrunk since it was sent).
   */
  async assertSeat(billingAccountId: string, email: string) {
    const ent = await this.forAccount(billingAccountId);
    const allowed = ent.limits.seats;
    if (isUnlimited(allowed)) return ent;
    const seats = await this.seatEmails(await this.accountWorkspaceIds(billingAccountId));
    if (seats.memberEmails.has(email)) return ent;
    const used = seats.all.size;
    if (new Set([...seats.all, email]).size > allowed) throw this.overCapacity(ent, "seats", used);
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
   * work instead of failing it. On success it returns the metering period the
   * use was counted in: a caller that gives it back later (a send that failed)
   * refunds that period, not whichever one is current by then.
   */
  async consume(workspaceId: string, billingAccountId: string, key: MeteredKey, n = 1): Promise<string | false> {
    const ent = await this.forAccount(billingAccountId);
    const allowed = ent.limits[key];
    const metric = METRIC[key]!;
    const { key: period } = meterPeriod(ent.subscription?.currentPeriodStart);
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
      return period;
    });
  }

  /** consume(), refusing with a 402 when the allowance is used up. Returns the period it was counted in. */
  async assertConsume(workspaceId: string, billingAccountId: string, key: MeteredKey, n = 1): Promise<string> {
    const period = await this.consume(workspaceId, billingAccountId, key, n);
    if (period) return period;
    const ent = await this.forAccount(billingAccountId);
    const renews = meterPeriod(ent.subscription?.currentPeriodStart).resetsAt.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
    throw limitReached(`This month's ${LIMIT_LABELS[key].toLowerCase()} allowance on the ${ent.effectivePlan.name} plan is used up. It renews on ${renews}, or upgrade for more.`, {
      limit: key,
      allowed: ent.limits[key],
      plan: ent.effectivePlan.name,
    });
  }
}
