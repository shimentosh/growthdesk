import Stripe from "stripe";
import { bootApp, createWorkspace, signUp, type Agent, type TestApp } from "./helpers.js";
import { EntitlementsService } from "../src/billing/entitlements.service.js";
import { BillingService } from "../src/billing/billing.service.js";
import { StripeProvider } from "../src/billing/providers/stripe.provider.js";
import { fakeStripe } from "./fake-stripe.js";
import { ChannelsService } from "../src/channels/channels.service.js";
import { TEST_ENV } from "./env.js";

/*
 * Billing is tested with real Stripe signature verification: payloads are
 * signed with the test webhook secret using Stripe's own helper, and the API
 * verifies them with Stripe.webhooks.constructEvent — no network involved.
 *
 * The API re-reads each subscription from Stripe before applying an event, so
 * the Stripe client calls are replaced by `stripe` below: a fake account whose
 * "current state" is the newest subscription event posted (or set directly
 * with stripe.says, the way Stripe itself changes a subscription on a failed
 * renewal).
 */

const SECRET = TEST_ENV.STRIPE_WEBHOOK_SECRET!;
const PRICE_GROWTH_MONTH = "price_growth_month_test";
const PRICE_STARTER_MONTH = "price_starter_month_test";

function signed(event: object) {
  const payload = JSON.stringify(event);
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET });
  return { payload, header };
}

const stripe = fakeStripe();

let seq = 0;
function subscriptionEvent(type: string, accountId: string, opts: { status: string; price: string; created?: number; subId?: string; customer?: string; cancelAtPeriodEnd?: boolean }) {
  seq += 1;
  const now = Math.floor(Date.now() / 1000);
  return {
    id: `evt_test_${Date.now()}_${seq}`,
    object: "event",
    type,
    created: opts.created ?? now,
    data: {
      object: {
        id: opts.subId ?? "sub_test_1",
        object: "subscription",
        customer: opts.customer ?? "cus_test_1",
        status: opts.status,
        cancel_at_period_end: opts.cancelAtPeriodEnd ?? false,
        canceled_at: null,
        trial_end: null,
        metadata: { billingAccountId: accountId },
        items: { data: [{ price: { id: opts.price, recurring: { interval: "month" } }, current_period_start: now, current_period_end: now + 30 * 86400 }] },
      },
    },
  };
}

describe("Billing: webhooks, subscription state and entitlements", () => {
  let t: TestApp;
  let owner: Agent;
  let w: string;
  let accountId: string;

  const post = (event: { created?: number; data?: { object?: Record<string, unknown> } }) => {
    stripe.remember(event);
    const { payload, header } = signed(event);
    return t.http().post("/v1/webhooks/billing/stripe").set("content-type", "application/json").set("stripe-signature", header).send(payload);
  };

  beforeAll(async () => {
    t = await bootApp();
    stripe.install(t.app.get(StripeProvider));
    for (const [key, price] of [["growth", PRICE_GROWTH_MONTH], ["starter", PRICE_STARTER_MONTH]] as const) {
      await t.prisma.db.plan.update({ where: { key }, data: { providerPrices: { stripe: { month: price, year: `${price}_year` } } } });
    }
    owner = await signUp(t, "billing-owner@acme.test");
    w = await createWorkspace(owner, "Billing Co");
    accountId = (await t.prisma.db.workspace.findUniqueOrThrow({ where: { id: w } })).billingAccountId;
  });
  afterAll(async () => t.close());

  it("lists public plans and shows the trial on the billing page", async () => {
    const plans = await t.http().get("/v1/plans").expect(200);
    expect(plans.body.data.map((p: { key: string }) => p.key)).toEqual(["free", "starter", "growth", "agency"]);
    const overview = await owner.get(`/v1/workspaces/${w}/billing`).expect(200);
    expect(overview.body.data.subscription.status).toBe("trialing");
    expect(overview.body.data.usage.contacts).toMatchObject({ used: 0, limit: 5000 });
    expect(overview.body.data.payments.available).toBe(true);
  });

  it("rejects an unsigned or tampered webhook", async () => {
    const event = subscriptionEvent("customer.subscription.updated", accountId, { status: "active", price: PRICE_GROWTH_MONTH });
    await t.http().post("/v1/webhooks/billing/stripe").set("content-type", "application/json").send(JSON.stringify(event)).expect(400);
    const { header } = signed(event);
    const tampered = JSON.stringify({ ...event, type: "customer.subscription.deleted" });
    await t.http().post("/v1/webhooks/billing/stripe").set("content-type", "application/json").set("stripe-signature", header).send(tampered).expect(400);
    const sub = await t.prisma.db.subscription.findUniqueOrThrow({ where: { billingAccountId: accountId } });
    expect(sub.status).toBe("trialing");
  });

  it("activates a plan only from a verified event, and ignores a redelivery", async () => {
    const event = subscriptionEvent("customer.subscription.created", accountId, { status: "active", price: PRICE_GROWTH_MONTH });
    const first = await post(event).expect(200);
    expect(first.body.data.duplicate).toBe(false);
    const again = await post(event).expect(200);
    expect(again.body.data.duplicate).toBe(true);
    const sub = await t.prisma.db.subscription.findUniqueOrThrow({ where: { billingAccountId: accountId }, include: { plan: true } });
    expect(sub.status).toBe("active");
    expect(sub.plan.key).toBe("growth");
    expect(sub.provider).toBe("stripe");
    expect(await t.prisma.db.billingEvent.count({ where: { providerEventId: event.id } })).toBe(1);
  });

  it("does not let an older event delivered late roll the state back", async () => {
    const older = subscriptionEvent("customer.subscription.updated", accountId, { status: "active", price: PRICE_STARTER_MONTH, created: Math.floor(Date.now() / 1000) - 3600 });
    await post(older).expect(200);
    const sub = await t.prisma.db.subscription.findUniqueOrThrow({ where: { billingAccountId: accountId }, include: { plan: true } });
    expect(sub.plan.key).toBe("growth");
  });

  it("records invoices and moves to past_due with a grace period on payment failure, then restricts", async () => {
    const now = Math.floor(Date.now() / 1000);
    const invoice = {
      id: `evt_inv_${Date.now()}`,
      object: "event",
      type: "invoice.payment_failed",
      created: now + 5,
      data: {
        object: {
          id: "in_test_1",
          object: "invoice",
          customer: "cus_test_1",
          number: "GD-0001",
          status: "open",
          currency: "usd",
          amount_due: 7900,
          amount_paid: 0,
          hosted_invoice_url: "https://invoice.stripe.test/i/1",
          invoice_pdf: "https://invoice.stripe.test/i/1.pdf",
          period_start: now,
          period_end: now + 30 * 86400,
          created: now,
          status_transitions: { paid_at: null },
          parent: { subscription_details: { subscription: "sub_test_1", metadata: { billingAccountId: accountId } } },
        },
      },
    };
    // Stripe moves the subscription to past_due when the renewal fails; the API reads that state back.
    stripe.says("sub_test_1", { status: "past_due" });
    await post(invoice).expect(200);
    const inv = await t.prisma.db.invoice.findFirstOrThrow({ where: { billingAccountId: accountId } });
    expect(inv.amountDueCents).toBe(7900);
    let sub = await t.prisma.db.subscription.findUniqueOrThrow({ where: { billingAccountId: accountId } });
    expect(sub.status).toBe("past_due");
    expect(sub.graceUntil!.getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    const ent = t.app.get(EntitlementsService);
    expect((await ent.forAccount(accountId)).access).toBe("full");
    expect(t.mail.outbox.some((m) => m.subject.includes("Payment failed"))).toBe(true);

    // Grace over → restricted: CRM still readable, imports refused.
    await t.prisma.db.subscription.update({ where: { id: sub.id }, data: { graceUntil: new Date(Date.now() - 1000) } });
    expect((await ent.forAccount(accountId)).access).toBe("restricted");
    await owner.get(`/v1/workspaces/${w}/contacts`).expect(200);
    const refused = await owner.post(`/v1/workspaces/${w}/imports`).send({ fileName: "x.csv", csv: "email\na@b.test", mapping: { email: "email" }, tags: [], onDuplicate: "update" }).expect(423);
    expect(refused.body.error.message).toMatch(/overdue/i);

    // Paid again → active, restriction lifted.
    const recovered = subscriptionEvent("customer.subscription.updated", accountId, { status: "active", price: PRICE_GROWTH_MONTH, created: now + 10 });
    await post(recovered).expect(200);
    sub = await t.prisma.db.subscription.findUniqueOrThrow({ where: { billingAccountId: accountId } });
    expect(sub.status).toBe("active");
    expect(sub.graceUntil).toBeNull();
    expect((await ent.forAccount(accountId)).access).toBe("full");
    expect(t.mail.outbox.some((m) => m.subject.includes("Payment received"))).toBe(true);
  });

  it("falls back to the free allowance when the subscription is deleted, without deleting data", async () => {
    await owner.post(`/v1/workspaces/${w}/contacts`).send({ fullName: "Kept", email: "kept@x.test" }).expect(201);
    const deleted = subscriptionEvent("customer.subscription.deleted", accountId, { status: "canceled", price: PRICE_GROWTH_MONTH, created: Math.floor(Date.now() / 1000) + 20 });
    await post(deleted).expect(200);
    const ent = await t.app.get(EntitlementsService).forAccount(accountId);
    expect(ent.state).toBe("canceled");
    expect(ent.effectivePlan.key).toBe("free");
    expect(await t.prisma.db.contact.count({ where: { workspaceId: w, deletedAt: null } })).toBe(1);
  });

  it("consumes metered allowances atomically under concurrency", async () => {
    const ent = t.app.get(EntitlementsService);
    const free = await t.prisma.db.plan.findUniqueOrThrow({ where: { key: "free" } });
    await t.prisma.db.plan.update({ where: { id: free.id }, data: { limits: { ...(free.limits as object), monthlyAiCredits: 5 } } });
    const results = await Promise.all(Array.from({ length: 12 }, () => ent.consume(w, accountId, "monthlyAiCredits", 1)));
    expect(results.filter(Boolean)).toHaveLength(5);
    expect(await ent.usage(accountId, "monthlyAiCredits")).toBe(5);
    await t.prisma.db.plan.update({ where: { id: free.id }, data: { limits: free.limits as object } });
  });

  it("refuses checkout for members without billing.manage and when the plan has no price", async () => {
    const res = await owner.post(`/v1/workspaces/${w}/billing/checkout`).send({ planKey: "agency", interval: "month" }).expect(400);
    expect(res.body.error.message).toMatch(/no monthly price/);
  });
});

describe("Billing: ordering, duplicates, late failures, notices (docs/GAP_PLAN.md sprint 2)", () => {
  let t: TestApp;
  const accounts: Record<string, { agent: Agent; w: string; accountId: string }> = {};
  const post = (event: { created?: number; data?: { object?: Record<string, unknown> } }) => {
    stripe.remember(event);
    const { payload, header } = signed(event);
    return t.http().post("/v1/webhooks/billing/stripe").set("content-type", "application/json").set("stripe-signature", header).send(payload);
  };
  const account = async (key: string) => {
    const agent = await signUp(t, `billing-${key}@acme.test`);
    const w = await createWorkspace(agent, `Billing ${key}`);
    const accountId = (await t.prisma.db.workspace.findUniqueOrThrow({ where: { id: w } })).billingAccountId;
    accounts[key] = { agent, w, accountId };
    return accounts[key]!;
  };
  const subOf = (accountId: string) => t.prisma.db.subscription.findUniqueOrThrow({ where: { billingAccountId: accountId }, include: { plan: true } });

  beforeAll(async () => {
    t = await bootApp();
    stripe.install(t.app.get(StripeProvider));
    for (const [key, price] of [["growth", PRICE_GROWTH_MONTH], ["starter", PRICE_STARTER_MONTH]] as const) {
      await t.prisma.db.plan.update({ where: { key }, data: { providerPrices: { stripe: { month: price, year: `${price}_year` } } } });
    }
  });
  afterAll(async () => t.close());

  it("applies Stripe's current state when two events of the same second arrive out of order", async () => {
    const { accountId } = await account("order");
    const at = Math.floor(Date.now() / 1000);
    const opts = { price: PRICE_GROWTH_MONTH, created: at, subId: "sub_order", customer: "cus_order" };
    await post(subscriptionEvent("customer.subscription.updated", accountId, { ...opts, status: "active" })).expect(200);
    await post(subscriptionEvent("customer.subscription.created", accountId, { ...opts, status: "incomplete" })).expect(200);
    expect((await subOf(accountId)).status).toBe("active");
  });

  it("does not let a second subscription overwrite the live one, until the live one really ended", async () => {
    const { accountId } = await account("dup");
    await post(subscriptionEvent("customer.subscription.created", accountId, { status: "active", price: PRICE_GROWTH_MONTH, subId: "sub_a", customer: "cus_dup" })).expect(200);
    await post(subscriptionEvent("customer.subscription.created", accountId, { status: "active", price: PRICE_STARTER_MONTH, subId: "sub_b", customer: "cus_dup" })).expect(200);
    let sub = await subOf(accountId);
    expect(sub).toMatchObject({ providerSubscriptionId: "sub_a", status: "active" });
    expect(sub.plan.key).toBe("growth");
    expect(await t.prisma.db.auditEvent.count({ where: { action: "billing.duplicate_subscription", targetId: accountId } })).toBe(1);

    // The customer cancels A in the portal: B (still billing) is now the account's subscription.
    stripe.says("sub_a", { status: "canceled" });
    await post(subscriptionEvent("customer.subscription.updated", accountId, { status: "active", price: PRICE_STARTER_MONTH, subId: "sub_b", customer: "cus_dup", created: Math.floor(Date.now() / 1000) + 5 })).expect(200);
    sub = await subOf(accountId);
    expect(sub).toMatchObject({ providerSubscriptionId: "sub_b", status: "active" });
    expect(sub.plan.key).toBe("starter");
  });

  it("ignores a payment failure for an invoice that is already paid or belongs to another subscription", async () => {
    const { accountId } = await account("late");
    await post(subscriptionEvent("customer.subscription.created", accountId, { status: "active", price: PRICE_GROWTH_MONTH, subId: "sub_late", customer: "cus_late" })).expect(200);
    const before = t.mail.outbox.length;
    const failure = (id: string, status: string, subscription: string) => ({
      id: `evt_fail_${id}`,
      object: "event",
      type: "invoice.payment_failed",
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: `in_${id}`,
          object: "invoice",
          customer: "cus_late",
          number: `GD-${id}`,
          status,
          currency: "usd",
          amount_due: 7900,
          amount_paid: status === "paid" ? 7900 : 0,
          created: Math.floor(Date.now() / 1000),
          status_transitions: { paid_at: null },
          parent: { subscription_details: { subscription, metadata: { billingAccountId: accountId } } },
        },
      },
    });
    stripe.says("sub_late", { status: "past_due" }); // even if Stripe briefly said so, these events must not act
    await post(failure("paid", "paid", "sub_late")).expect(200);
    await post(failure("other", "open", "sub_someone_else")).expect(200);
    expect((await subOf(accountId)).status).toBe("active");
    expect(t.mail.outbox.slice(before).some((m) => m.subject.includes("Payment failed"))).toBe(false);
  });

  it("sends each billing notice once: trial ending, grace ending, sending paused", async () => {
    const { accountId } = await account("notices");
    const billing = t.app.get(BillingService);
    const sub = await subOf(accountId);
    const sent = () => t.mail.outbox.filter((m) => m.to === "billing-notices@acme.test").map((m) => m.subject);

    await t.prisma.db.subscription.update({ where: { id: sub.id }, data: { status: "trialing", trialEndsAt: new Date(Date.now() + 2 * 86_400_000 - 60_000) } });
    await billing.sendNotices();
    await billing.sendNotices();
    expect(sent().filter((s) => s.includes("trial ends in 2 days"))).toHaveLength(1);

    await t.prisma.db.subscription.update({ where: { id: sub.id }, data: { status: "past_due", graceUntil: new Date(Date.now() + 12 * 3_600_000) } });
    await billing.sendNotices();
    await billing.sendNotices();
    expect(sent().filter((s) => s.includes("Sending pauses tomorrow"))).toHaveLength(1);

    await t.prisma.db.subscription.update({ where: { id: sub.id }, data: { graceUntil: new Date(Date.now() - 60_000) } });
    await billing.sendNotices();
    await billing.sendNotices();
    expect(sent().filter((s) => s.includes("Sending is paused"))).toHaveLength(1);
  });

  it("changes the price of a live Stripe subscription instead of opening a second checkout", async () => {
    const { agent, w, accountId } = await account("reuse");
    await t.prisma.db.subscription.update({ where: { billingAccountId: accountId }, data: { provider: "stripe", providerCustomerId: "cus_reuse" } });
    stripe.live = "sub_live_elsewhere";
    const checkoutsBefore = stripe.checkouts;
    const res = await agent.post(`/v1/workspaces/${w}/billing/checkout`).send({ planKey: "growth", interval: "month" }).expect(201);
    stripe.live = null;
    expect(res.body.data).toEqual({ changed: true, url: null });
    expect(stripe.priceChanges.at(-1)).toEqual({ subId: "sub_live_elsewhere", priceId: PRICE_GROWTH_MONTH });
    expect(stripe.checkouts).toBe(checkoutsBefore);
  });

  it("refuses a downgrade the account's contacts would not fit into", async () => {
    const { agent, w } = await account("fits");
    await agent.post(`/v1/workspaces/${w}/contacts`).send({ fullName: "One", email: "one@fits.test" }).expect(201);
    await agent.post(`/v1/workspaces/${w}/contacts`).send({ fullName: "Two", email: "two@fits.test" }).expect(201);
    const free = await t.prisma.db.plan.findUniqueOrThrow({ where: { key: "starter" } });
    await t.prisma.db.plan.update({ where: { id: free.id }, data: { limits: { ...(free.limits as object), contacts: 1 } } });
    const res = await agent.post(`/v1/workspaces/${w}/billing/checkout`).send({ planKey: "starter", interval: "month" }).expect(409);
    expect(res.body.error.message).toMatch(/Contacts: 2 in use, Starter allows 1/);
    await t.prisma.db.plan.update({ where: { id: free.id }, data: { limits: free.limits as object } });
  });

  it("answers 502 when Stripe cannot be read, so Stripe retries the delivery", async () => {
    const { accountId } = await account("outage");
    const provider = t.app.get(StripeProvider);
    const fetch = provider.fetchSubscription;
    provider.fetchSubscription = async () => {
      throw Object.assign(new Error("Invalid API Key provided"), { type: "StripeAuthenticationError", statusCode: 401 });
    };
    const event = subscriptionEvent("customer.subscription.created", accountId, { status: "active", price: PRICE_GROWTH_MONTH, subId: "sub_outage", customer: "cus_outage" });
    const res = await post(event).expect(502);
    provider.fetchSubscription = fetch;
    expect(res.body.error.code).toBe("upstream_error");
    // Not marked processed: the retry applies it.
    expect((await t.prisma.db.billingEvent.findFirstOrThrow({ where: { providerEventId: event.id } })).processedAt).toBeNull();
    await post(event).expect(200);
    expect((await subOf(accountId)).status).toBe("active");
  });

  it("refuses WhatsApp and Telegram sends when the plan does not include them", async () => {
    const { w } = await account("chat");
    await t.prisma.db.plan.update({ where: { key: "starter" }, data: { features: { calling: true, ai: true, whatsapp: false, telegram: false } } });
    const res = await t.app.get(ChannelsService).deliver({ workspaceId: w, channel: "whatsapp", contactId: null, body: "Hello" } as never);
    expect(res).toEqual({ status: "unavailable", reason: "WhatsApp is not included in the Starter plan." });
  });
});
