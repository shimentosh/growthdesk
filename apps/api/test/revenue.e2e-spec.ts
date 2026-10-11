import Stripe from "stripe";
import { bootApp, createWorkspace, signUp, wait, type Agent, type TestApp } from "./helpers.js";
import { Queues } from "../src/queues/queues.js";
import { QUEUES } from "../src/queues/queues.js";
import { MaintenanceProcessorsModule } from "../src/worker/maintenance.processors.js";
import { BillingService } from "../src/billing/billing.service.js";
import { TEST_ENV } from "./env.js";
import { StripeProvider } from "../src/billing/providers/stripe.provider.js";
import { fakeStripe } from "./fake-stripe.js";

// The API re-reads subscriptions from Stripe before applying a webhook; this stands in for Stripe.
const stripe = fakeStripe();

/*
 * Platform revenue: Stripe webhooks capture the real price and write the
 * subscription status history; GET /v1/admin/revenue reports MRR, movement,
 * trial conversion, churn and collected revenue from it; the daily snapshot
 * job on the maintenance queue is idempotent; revenue is admin-only.
 * Webhooks are signed with Stripe's own helper exactly as in billing.e2e.
 */

const SECRET = TEST_ENV.STRIPE_WEBHOOK_SECRET!;
const PRICE_GROWTH_MONTH = "price_rev_growth_month";

function signed(event: object) {
  const payload = JSON.stringify(event);
  return { payload, header: Stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET }) };
}

let seq = 0;
function subscriptionEvent(type: string, accountId: string, opts: { status: string; unitAmount?: number | null; created: number; subId: string; customer: string }) {
  seq += 1;
  return {
    id: `evt_rev_${Date.now()}_${seq}`,
    object: "event",
    type,
    created: opts.created,
    data: {
      object: {
        id: opts.subId,
        object: "subscription",
        customer: opts.customer,
        status: opts.status,
        cancel_at_period_end: false,
        canceled_at: null,
        trial_end: null,
        metadata: { billingAccountId: accountId },
        items: {
          data: [
            {
              price: { id: PRICE_GROWTH_MONTH, unit_amount: opts.unitAmount === undefined ? 7500 : opts.unitAmount, currency: "usd", recurring: { interval: "month", interval_count: 1 } },
              quantity: 1,
              current_period_start: opts.created,
              current_period_end: opts.created + 30 * 86400,
            },
          ],
        },
      },
    },
  };
}

async function until<T>(read: () => Promise<T>, done: (v: T) => boolean, timeoutMs = 20_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await read();
    if (done(v)) return v;
    if (Date.now() > end) throw new Error(`timed out; last value: ${JSON.stringify(v)}`);
    await wait(150);
  }
}

type Currency = {
  currency: string;
  mrrCents: number;
  payingCount: number;
  estimated: boolean;
  unpricedCount: number;
  sources: { provider: string; mrrCents: number; payingCount: number; estimated: boolean }[];
  movement: { newCents: number; churnCents: number; counts: Record<string, number>; unclassified: number };
  trialConversion: { started: number; converted: number; rate: number | null };
  logoChurn: { payingAtStart: number; churned: number; rate: number | null };
  collected: { month: string; amountCents: number; invoices: number }[];
  daily: { day: string; mrrCents: number }[];
  plans: { key: string; subscribers: number; mrrCents: number }[];
  topAccounts: { billingAccountId: string; mrrCents: number; provider: string; estimated: boolean }[];
};

describe("Platform revenue", () => {
  let t: TestApp;
  let admin: Agent;
  let support: Agent;
  let stripeCustomer: Agent;
  let manualCustomer: Agent;
  let stripeAccount: string;
  let manualAccount: string;
  let queues: Queues;
  const now = Math.floor(Date.now() / 1000);

  const post = (event: { created?: number; data?: { object?: Record<string, unknown> } } & Record<string, unknown>) => {
    stripe.remember(event);
    const { payload, header } = signed(event);
    return t.http().post("/v1/webhooks/billing/stripe").set("content-type", "application/json").set("stripe-signature", header).send(payload);
  };
  const usd = async (): Promise<Currency> => {
    const res = await admin.get("/v1/admin/revenue").expect(200);
    return res.body.data.currencies.find((c: Currency) => c.currency === "USD");
  };
  const changes = (billingAccountId: string) => t.prisma.db.subscriptionStatusChange.findMany({ where: { billingAccountId }, orderBy: { at: "asc" } });

  async function runSnapshot() {
    const job = await queues.add(QUEUES.maintenance, "revenue-snapshot", {}, { attempts: 1 });
    const q = queues.queue(QUEUES.maintenance);
    const state = await until(() => q.getJob(job.id!).then((j) => j?.getState()), (s) => s === "completed" || s === "failed");
    const finished = await q.getJob(job.id!);
    if (state === "failed") throw new Error(`revenue-snapshot failed: ${finished?.failedReason}`);
    return finished?.returnvalue as { day: string; currencies: number };
  }

  beforeAll(async () => {
    t = await bootApp([MaintenanceProcessorsModule]);
    stripe.install(t.app.get(StripeProvider));
    queues = t.app.get(Queues);
    await t.prisma.db.plan.update({ where: { key: "growth" }, data: { providerPrices: { stripe: { month: PRICE_GROWTH_MONTH, year: `${PRICE_GROWTH_MONTH}_year` } } } });
    admin = await signUp(t, "rev-admin@platform.test", "Rev Admin");
    support = await signUp(t, "rev-support@platform.test", "Rev Support");
    await t.prisma.db.user.update({ where: { id: admin.userId }, data: { platformRole: "admin" } });
    await t.prisma.db.user.update({ where: { id: support.userId }, data: { platformRole: "support" } });
    stripeCustomer = await signUp(t, "rev-stripe@acme.test");
    manualCustomer = await signUp(t, "rev-manual@acme.test");
    const w1 = await createWorkspace(stripeCustomer, "Stripe Payer");
    const w2 = await createWorkspace(manualCustomer, "Invoiced Co");
    stripeAccount = (await t.prisma.db.workspace.findUniqueOrThrow({ where: { id: w1 } })).billingAccountId;
    manualAccount = (await t.prisma.db.workspace.findUniqueOrThrow({ where: { id: w2 } })).billingAccountId;
  });
  afterAll(async () => t.close());

  it("refuses revenue to support staff and customers, and leaves it out of their overview", async () => {
    await t.http().get("/v1/admin/revenue").expect(401);
    await stripeCustomer.get("/v1/admin/revenue").expect(403);
    const refused = await support.get("/v1/admin/revenue").expect(403);
    expect(refused.body.error.code).toBe("forbidden");
    const overview = await support.get("/v1/admin/overview").expect(200);
    expect(overview.body.data.revenue).toBeNull();
    expect(overview.body.data.users.total).toBe(4); // existing fields unchanged
  });

  it("records the sign-up trial as the first history row", async () => {
    const rows = await changes(stripeAccount);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ fromStatus: null, toStatus: "trialing", mrrCents: 0, provider: "none", currency: "USD" });
  });

  it("stores the Stripe price and writes one status change per real change", async () => {
    const created = subscriptionEvent("customer.subscription.created", stripeAccount, { status: "active", created: now, subId: "sub_rev_1", customer: "cus_rev_1" });
    await post(created).expect(200);
    await post(created).expect(200); // redelivery: ignored
    // The same state again (a later event, e.g. metadata edit): no new history row.
    await post(subscriptionEvent("customer.subscription.updated", stripeAccount, { status: "active", created: now + 1, subId: "sub_rev_1", customer: "cus_rev_1" })).expect(200);

    const sub = await t.prisma.db.subscription.findUniqueOrThrow({ where: { billingAccountId: stripeAccount }, include: { plan: true } });
    expect(sub).toMatchObject({ status: "active", provider: "stripe", priceCents: 7500, priceCurrency: "USD" });
    expect(sub.plan.key).toBe("growth");
    const rows = await changes(stripeAccount);
    expect(rows.map((r) => [r.fromStatus, r.toStatus, r.mrrCents, r.provider])).toEqual([
      [null, "trialing", 0, "none"],
      ["trialing", "active", 7500, "stripe"],
    ]);
  });

  it("reports manual plans separately, at the estimated list price", async () => {
    await admin.post(`/v1/admin/billing-accounts/${manualAccount}/assign-plan`).send({ planKey: "growth", interval: "year", status: "active", reason: "Invoiced annually" }).expect(200);
    const sub = await t.prisma.db.subscription.findUniqueOrThrow({ where: { billingAccountId: manualAccount } });
    expect(sub).toMatchObject({ provider: "manual", priceCents: null });
    const rows = await changes(manualAccount);
    expect(rows.at(-1)).toMatchObject({ fromStatus: "trialing", toStatus: "active", mrrCents: Math.round(79000 / 12), provider: "manual" });
  });

  it("reports MRR, movement and trial conversion per currency", async () => {
    const c = await usd();
    const manualMrr = Math.round(79000 / 12); // 6583
    expect(c).toMatchObject({ mrrCents: 7500 + manualMrr, payingCount: 2, estimated: true, unpricedCount: 1 });
    expect(c.sources.map((s) => [s.provider, s.mrrCents, s.payingCount, s.estimated])).toEqual([
      ["stripe", 7500, 1, false],
      ["manual", manualMrr, 1, true],
    ]);
    expect(c.movement).toMatchObject({ newCents: 7500 + manualMrr, churnCents: 0, counts: { new: 2, churn: 0 }, unclassified: 0 });
    expect(c.trialConversion).toEqual({ started: 2, converted: 2, rate: 1 });
    expect(c.plans).toEqual([expect.objectContaining({ key: "growth", subscribers: 2, mrrCents: 7500 + manualMrr })]);
    expect(c.topAccounts.map((a) => [a.billingAccountId, a.mrrCents, a.provider, a.estimated])).toEqual([
      [stripeAccount, 7500, "stripe", false],
      [manualAccount, manualMrr, "manual", true],
    ]);
    expect(c.collected).toHaveLength(12);

    const res = await admin.get("/v1/admin/revenue").expect(200);
    expect(res.body.data.trackingSince).toEqual(expect.any(String));
    expect(res.body.data.range.days).toBe(30);

    const overview = await admin.get("/v1/admin/overview").expect(200);
    expect(overview.body.data.revenue.mrr).toEqual([expect.objectContaining({ currency: "USD", mrrCents: 7500 + manualMrr, payingCount: 2, estimated: true })]);
  });

  it("counts a paid invoice in this month's collected revenue", async () => {
    await post({
      id: `evt_rev_inv_${Date.now()}`,
      object: "event",
      type: "invoice.paid",
      created: now + 2,
      data: {
        object: {
          id: "in_rev_1",
          object: "invoice",
          customer: "cus_rev_1",
          number: "GD-R-1",
          status: "paid",
          currency: "usd",
          amount_due: 7500,
          amount_paid: 7500,
          period_start: now,
          period_end: now + 30 * 86400,
          created: now,
          status_transitions: { paid_at: now + 2 },
          parent: { subscription_details: { subscription: "sub_rev_1", metadata: { billingAccountId: stripeAccount } } },
        },
      },
    }).expect(200);
    const c = await usd();
    expect(c.collected.at(-1)).toEqual({ month: new Date().toISOString().slice(0, 7), amountCents: 7500, invoices: 1 });
  });

  it("counts a cancellation as churn", async () => {
    await post(subscriptionEvent("customer.subscription.deleted", stripeAccount, { status: "canceled", created: now + 10, subId: "sub_rev_1", customer: "cus_rev_1" })).expect(200);
    expect((await changes(stripeAccount)).at(-1)).toMatchObject({ fromStatus: "active", toStatus: "canceled", mrrCents: 0 });
    const c = await usd();
    expect(c.mrrCents).toBe(Math.round(79000 / 12));
    expect(c.movement).toMatchObject({ churnCents: 7500, counts: { new: 2, churn: 1 } });
    // Paying at the start of the range: today 1, minus 2 won, plus 1 lost = 0 → no rate.
    expect(c.logoChurn).toEqual({ payingAtStart: 0, churned: 1, rate: null });
  });

  it("does not log a price that is merely read for the first time", async () => {
    // A row written before prices were captured, then a reconcile pass reads the price: stored, not logged.
    await t.prisma.db.subscription.update({ where: { billingAccountId: stripeAccount }, data: { priceCents: null, priceCurrency: null } });
    const before = (await changes(stripeAccount)).length;
    const billing = t.app.get(BillingService);
    await billing.applySubscription(
      "stripe",
      { providerSubscriptionId: "sub_rev_1", providerCustomerId: "cus_rev_1", status: "canceled", priceId: PRICE_GROWTH_MONTH, interval: "month", priceCents: 7500, priceCurrency: "USD", currentPeriodStart: null, currentPeriodEnd: null, trialEndsAt: null, cancelAtPeriodEnd: false, canceledAt: new Date(), billingAccountId: stripeAccount },
      new Date(Date.now() + 60_000), // newer than the last webhook applied above
      false,
    );
    expect((await changes(stripeAccount)).length).toBe(before);
    expect(await t.prisma.db.subscription.findUniqueOrThrow({ where: { billingAccountId: stripeAccount } })).toMatchObject({ priceCents: 7500, priceCurrency: "USD" });
  });

  it("snapshots today's MRR on the maintenance queue, idempotently", async () => {
    const first = await runSnapshot();
    const today = new Date().toISOString().slice(0, 10);
    expect(first).toEqual({ day: today, currencies: 1 });
    const second = await runSnapshot();
    expect(second).toEqual(first);
    const rows = await t.prisma.db.platformRevenueSnapshot.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ currency: "USD", mrrCents: Math.round(79000 / 12), payingCount: 1, trialingCount: 0 });
    const c = await usd();
    expect(c.daily).toEqual([{ day: today, mrrCents: Math.round(79000 / 12), payingCount: 1, trialingCount: 0 }]);
    const res = await admin.get("/v1/admin/revenue").expect(200);
    expect(res.body.data.snapshotsSince).toBe(today);
  });

  it("validates the range", async () => {
    await admin.get("/v1/admin/revenue?from=2026-02-30").expect(400);
    await admin.get("/v1/admin/revenue?from=2026-05-02&to=2026-05-01").expect(400);
    const res = await admin.get("/v1/admin/revenue?from=2020-01-01&to=2020-01-31").expect(200);
    const c = res.body.data.currencies.find((x: Currency) => x.currency === "USD");
    // A range before tracking began: no movement, no series — and nothing invented.
    expect(c.movement.counts).toEqual({ new: 0, expansion: 0, contraction: 0, churn: 0, reactivation: 0 });
    expect(c.daily).toEqual([]);
    expect(res.body.data.effectiveFrom).toBeNull();
  });
});
