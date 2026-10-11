import { Injectable } from "@nestjs/common";
import {
  addLocalDays,
  localDayDiff,
  PLATFORM_REVENUE_DEFAULT_DAYS,
  PLATFORM_REVENUE_MAX_DAYS,
  type PlatformMrrHeadline,
  type PlatformRevenueCurrency,
  type PlatformRevenueQueryT,
  type PlatformRevenueReport,
  type PlatformRevenueSource,
} from "@growthdesk/shared";
import { PrismaService } from "../prisma/prisma.service.js";
import { subscriptionMrr, type Mrr } from "../billing/subscription-history.js";
import { classifyMovements, payingAtStart, ratio, sumMovements, trialConversion, type HistoryRow } from "./revenue-math.js";

/*
 * Platform revenue: MRR, ARR, ARPA, movement, trial conversion, churn,
 * collected revenue and the daily MRR series. Platform admin only
 * (RevenueController, @Platform("admin")).
 *
 * Sources of truth, and nothing else:
 * - Current MRR: today's Subscription rows (subscription-history.ts rules:
 *   provider price when known, else plan list price flagged "estimated").
 * - Movement / trial conversion / churn: SubscriptionStatusChange, which only
 *   exists from the moment tracking began — reported as "since <first row>".
 * - Collected revenue: paid Invoice rows mirrored from the provider.
 * - Daily series: PlatformRevenueSnapshot, written by the daily maintenance
 *   job. Days without a snapshot are absent, never back-filled.
 * Every figure is per currency; nothing is converted.
 *
 * Subscriptions, billing accounts, invoices and the history are platform
 * (non-tenant) models, so the guarded client reads them across customers.
 */

const dayKey = (d: Date) => d.toISOString().slice(0, 10);
const utcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const dayStart = (day: string) => new Date(`${day}T00:00:00.000Z`);
const PROVIDER_ORDER = ["stripe", "manual", "none"];

type LiveSub = {
  billingAccountId: string;
  accountName: string;
  status: string;
  interval: "month" | "year";
  provider: string;
  plan: { id: string; key: string; name: string };
  mrr: Mrr;
};

type Bucket = { mrrCents: number; payingCount: number; trialingCount: number; unpricedCount: number };
const emptyBucket = (): Bucket => ({ mrrCents: 0, payingCount: 0, trialingCount: 0, unpricedCount: 0 });

function addTo(b: Bucket, s: LiveSub) {
  if (s.mrr.mrrCents > 0) {
    b.mrrCents += s.mrr.mrrCents;
    b.payingCount += 1;
    if (s.mrr.estimated) b.unpricedCount += 1;
  }
  if (s.status === "trialing") b.trialingCount += 1;
}

const headlineOf = (currency: string, b: Bucket): PlatformMrrHeadline => ({ currency, ...b, estimated: b.unpricedCount > 0 });

/** Per-currency totals over live subscriptions. Pure; exported for the unit tests. */
export function aggregateLive(subs: LiveSub[]) {
  const byCurrency = new Map<string, { total: Bucket; sources: Map<string, Bucket>; plans: Map<string, Bucket & { plan: LiveSub["plan"] }>; subs: LiveSub[] }>();
  for (const s of subs) {
    const c = s.mrr.currency;
    let entry = byCurrency.get(c);
    if (!entry) byCurrency.set(c, (entry = { total: emptyBucket(), sources: new Map(), plans: new Map(), subs: [] }));
    addTo(entry.total, s);
    const src = entry.sources.get(s.provider) ?? emptyBucket();
    addTo(src, s);
    entry.sources.set(s.provider, src);
    const plan = entry.plans.get(s.plan.id) ?? { ...emptyBucket(), plan: s.plan };
    addTo(plan, s);
    entry.plans.set(s.plan.id, plan);
    entry.subs.push(s);
  }
  return byCurrency;
}

@Injectable()
export class RevenueService {
  constructor(private readonly prisma: PrismaService) {}

  private async liveSubscriptions(): Promise<LiveSub[]> {
    const rows = await this.prisma.db.subscription.findMany({
      select: {
        billingAccountId: true,
        status: true,
        interval: true,
        provider: true,
        priceCents: true,
        priceCurrency: true,
        plan: { select: { id: true, key: true, name: true, monthlyPriceCents: true, annualPriceCents: true, currency: true } },
        billingAccount: { select: { name: true } },
      },
    });
    return rows.map((r) => ({
      billingAccountId: r.billingAccountId,
      accountName: r.billingAccount.name,
      status: r.status,
      interval: r.interval,
      provider: r.provider,
      plan: { id: r.plan.id, key: r.plan.key, name: r.plan.name },
      mrr: subscriptionMrr(r, r.plan),
    }));
  }

  /** Current MRR per currency (the admin overview headline and the daily snapshot). */
  async headline(): Promise<PlatformMrrHeadline[]> {
    const live = aggregateLive(await this.liveSubscriptions());
    return [...live.entries()].map(([currency, e]) => headlineOf(currency, e.total)).sort((a, b) => b.mrrCents - a.mrrCents || a.currency.localeCompare(b.currency));
  }

  /**
   * Daily (maintenance queue): upserts today's row per currency. Safe to run
   * twice — a re-run replaces today's figures with the current ones. A
   * currency that had a row on the previous snapshot day (or earlier today)
   * but has no subscriptions now gets a true zero row so the series shows
   * the drop. Never writes any day but today.
   */
  async snapshot(now = new Date()) {
    const day = utcDay(now);
    const db = this.prisma.db;
    const current = await this.headline();
    const previous = await db.platformRevenueSnapshot.findFirst({ where: { day: { lt: day } }, orderBy: { day: "desc" }, select: { day: true } });
    const carried = await db.platformRevenueSnapshot.findMany({
      where: { day: { in: previous ? [previous.day, day] : [day] } },
      select: { currency: true },
      distinct: ["currency"],
    });
    const figures = new Map(current.map((h) => [h.currency, h]));
    for (const { currency } of carried) if (!figures.has(currency)) figures.set(currency, headlineOf(currency, emptyBucket()));
    await db.$transaction(
      [...figures.values()].map((h) =>
        db.platformRevenueSnapshot.upsert({
          where: { day_currency: { day, currency: h.currency } },
          create: { day, currency: h.currency, mrrCents: h.mrrCents, payingCount: h.payingCount, trialingCount: h.trialingCount },
          update: { mrrCents: h.mrrCents, payingCount: h.payingCount, trialingCount: h.trialingCount },
        }),
      ),
    );
    return { day: dayKey(day), currencies: figures.size };
  }

  /** UTC days, both inclusive; default the last 30 days. */
  resolveRange(q: PlatformRevenueQueryT, now = new Date()) {
    const today = dayKey(now);
    let to = q.to ?? (q.from && localDayDiff(q.from, today) < 0 ? q.from : today);
    let from = q.from ?? addLocalDays(to, -(PLATFORM_REVENUE_DEFAULT_DAYS - 1));
    if (localDayDiff(from, to) < 0) [from, to] = [to, from];
    if (localDayDiff(from, to) + 1 > PLATFORM_REVENUE_MAX_DAYS) from = addLocalDays(to, -(PLATFORM_REVENUE_MAX_DAYS - 1));
    return { from, to, days: localDayDiff(from, to) + 1, start: dayStart(from), end: dayStart(addLocalDays(to, 1)) };
  }

  async report(q: PlatformRevenueQueryT, now = new Date()): Promise<PlatformRevenueReport> {
    const db = this.prisma.db;
    const range = this.resolveRange(q, now);
    const monthsStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1));

    const [live, first, firstSnapshot, touched, snapshots, collectedRows] = await Promise.all([
      this.liveSubscriptions(),
      db.subscriptionStatusChange.findFirst({ orderBy: { at: "asc" }, select: { at: true } }),
      db.platformRevenueSnapshot.findFirst({ orderBy: { day: "asc" }, select: { day: true } }),
      db.subscriptionStatusChange.findMany({ where: { at: { gte: range.start } }, distinct: ["billingAccountId"], select: { billingAccountId: true } }),
      db.platformRevenueSnapshot.findMany({ where: { day: { gte: range.start, lt: range.end } }, orderBy: { day: "asc" } }),
      db.$queryRaw<{ currency: string; month: string; cents: bigint; n: number }[]>`
        SELECT "currency", to_char(date_trunc('month', COALESCE("paidAt", "issuedAt")), 'YYYY-MM') AS "month",
               SUM("amountPaidCents")::bigint AS "cents", COUNT(*)::int AS "n"
        FROM "Invoice"
        WHERE "status" = 'paid' AND COALESCE("paidAt", "issuedAt") >= ${monthsStart}
        GROUP BY 1, 2`,
    ]);

    // Full history of every account that changed since the range began: earlier rows decide the previous MRR.
    const history: HistoryRow[] = touched.length
      ? await db.subscriptionStatusChange.findMany({
          where: { billingAccountId: { in: touched.map((t) => t.billingAccountId) } },
          select: { billingAccountId: true, at: true, fromStatus: true, toStatus: true, mrrCents: true, currency: true },
          orderBy: { at: "asc" },
        })
      : [];
    const { movements, unclassified } = classifyMovements(history);
    const inRange = (at: Date) => at >= range.start && at < range.end;
    const trials = trialConversion(history, range.start, range.end);
    const liveByCurrency = aggregateLive(live);

    const months = Array.from({ length: 12 }, (_, i) => new Date(Date.UTC(monthsStart.getUTCFullYear(), monthsStart.getUTCMonth() + i, 1)).toISOString().slice(0, 7));

    const currencies = new Set<string>([
      ...liveByCurrency.keys(),
      ...movements.filter((m) => inRange(m.at)).map((m) => m.currency),
      ...trials.map((t) => t.currency),
      ...collectedRows.map((r) => r.currency),
      ...snapshots.map((s) => s.currency),
    ]);

    const covered = first !== null && first.at < range.end;
    const out: PlatformRevenueCurrency[] = [...currencies].map((currency) => {
      const entry = liveByCurrency.get(currency);
      const total = entry?.total ?? emptyBucket();
      const head = headlineOf(currency, total);
      const sources: PlatformRevenueSource[] = [...(entry?.sources ?? new Map<string, Bucket>()).entries()]
        .filter(([, b]) => b.payingCount > 0 || b.trialingCount > 0)
        .map(([provider, b]) => ({ provider, ...headlineOf(currency, b) }))
        .sort((a, b) => (PROVIDER_ORDER.indexOf(a.provider) + 1 || 99) - (PROVIDER_ORDER.indexOf(b.provider) + 1 || 99) || a.provider.localeCompare(b.provider));

      const mine = movements.filter((m) => m.currency === currency);
      const rangeMoves = mine.filter((m) => inRange(m.at));
      const churned = new Set(rangeMoves.filter((m) => m.kind === "churn").map((m) => m.billingAccountId)).size;
      const atStart = payingAtStart(total.payingCount, mine.filter((m) => m.at >= range.start));
      const myTrials = trials.filter((t) => t.currency === currency);
      const converted = myTrials.filter((t) => t.converted).length;

      const collected = new Map(collectedRows.filter((r) => r.currency === currency).map((r) => [r.month, r]));
      const plans = [...(entry?.plans.values() ?? [])]
        .filter((p) => p.payingCount > 0 || p.trialingCount > 0)
        .map((p) => ({ planId: p.plan.id, key: p.plan.key, name: p.plan.name, subscribers: p.payingCount, trialing: p.trialingCount, mrrCents: p.mrrCents, estimated: p.unpricedCount > 0 }))
        .sort((a, b) => b.mrrCents - a.mrrCents || b.subscribers - a.subscribers);
      const topAccounts = (entry?.subs ?? [])
        .filter((s) => s.mrr.mrrCents > 0)
        .sort((a, b) => b.mrr.mrrCents - a.mrr.mrrCents || a.accountName.localeCompare(b.accountName))
        .slice(0, 10)
        .map((s) => ({
          billingAccountId: s.billingAccountId,
          name: s.accountName,
          plan: { key: s.plan.key, name: s.plan.name },
          provider: s.provider,
          status: s.status,
          interval: s.interval,
          mrrCents: s.mrr.mrrCents,
          estimated: s.mrr.estimated,
        }));

      return {
        ...head,
        arrCents: total.mrrCents * 12,
        arpaCents: total.payingCount > 0 ? Math.round(total.mrrCents / total.payingCount) : null,
        sources,
        movement: { ...sumMovements(rangeMoves), unclassified: unclassified.filter((r) => r.currency === currency && inRange(r.at)).length },
        trialConversion: { started: myTrials.length, converted, rate: ratio(converted, myTrials.length) },
        // Without history covering the range there is nothing to measure churn with: no rate rather than a false 0%.
        logoChurn: { payingAtStart: atStart, churned, rate: covered ? ratio(churned, atStart) : null },
        collected: months.map((month) => ({ month, amountCents: Number(collected.get(month)?.cents ?? 0), invoices: collected.get(month)?.n ?? 0 })),
        daily: snapshots.filter((s) => s.currency === currency).map((s) => ({ day: dayKey(s.day), mrrCents: s.mrrCents, payingCount: s.payingCount, trialingCount: s.trialingCount })),
        plans,
        topAccounts,
      };
    });
    out.sort((a, b) => b.mrrCents - a.mrrCents || a.currency.localeCompare(b.currency));

    const trackingSince = first?.at ?? null;
    const effectiveFrom = trackingSince ? new Date(Math.max(trackingSince.getTime(), range.start.getTime())) : null;
    return {
      generatedAt: now.toISOString(),
      range: { from: range.from, to: range.to, days: range.days },
      trackingSince: trackingSince?.toISOString() ?? null,
      // Null when tracking began after the range ended: nothing in it is covered.
      effectiveFrom: effectiveFrom && effectiveFrom < range.end ? effectiveFrom.toISOString() : null,
      snapshotsSince: firstSnapshot ? dayKey(firstSnapshot.day) : null,
      currencies: out,
    };
  }
}
