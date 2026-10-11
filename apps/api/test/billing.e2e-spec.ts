import Stripe from "stripe";
import { addMember, bootApp, createWorkspace, setPlan, signUp, type Agent, type TestApp } from "./helpers.js";
import { ImportsService } from "../src/crm/imports.service.js";
import { APP_CONFIG, type AppConfig } from "../src/config/config.js";
import { hashToken } from "../src/common/crypto.js";
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

describe("Billing correctness (docs/GAP_PLAN.md §3.1.4–3.1.11)", () => {
  let t: TestApp;
  const post = (event: { created?: number; data?: { object?: Record<string, unknown> } }) => {
    stripe.remember(event);
    const { payload, header } = signed(event);
    return t.http().post("/v1/webhooks/billing/stripe").set("content-type", "application/json").set("stripe-signature", header).send(payload);
  };
  const account = async (key: string, email = `fix-${key}@acme.test`) => {
    const agent = await signUp(t, email);
    const w = await createWorkspace(agent, `Fix ${key}`);
    const accountId = (await t.prisma.db.workspace.findUniqueOrThrow({ where: { id: w } })).billingAccountId;
    return { agent, w, accountId };
  };
  const subOf = (accountId: string) => t.prisma.db.subscription.findUniqueOrThrow({ where: { billingAccountId: accountId }, include: { plan: true } });
  const inviteToken = (email: string) => {
    const mail = t.mail.outbox.filter((m) => m.to === email && m.template === "invitation").at(-1);
    const token = mail?.text.match(/invite\/([A-Za-z0-9_%-]+)/)?.[1];
    if (!token) throw new Error(`no invitation email for ${email}`);
    return decodeURIComponent(token);
  };
  const withLimits = async (planKey: string, patch: Record<string, number>, fn: () => Promise<void>) => {
    const plan = await t.prisma.db.plan.findUniqueOrThrow({ where: { key: planKey } });
    await t.prisma.db.plan.update({ where: { id: plan.id }, data: { limits: { ...(plan.limits as object), ...patch } } });
    try {
      await fn();
    } finally {
      await t.prisma.db.plan.update({ where: { id: plan.id }, data: { limits: plan.limits as object } });
    }
  };
  const invoiceEvent = (type: string, accountId: string, opts: { id: string; customer: string; subscription: string; status?: string; hostedUrl?: string }) => ({
    id: `evt_${type}_${opts.id}`,
    object: "event",
    type,
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: opts.id,
        object: "invoice",
        customer: opts.customer,
        number: `GD-${opts.id}`,
        status: opts.status ?? "open",
        currency: "usd",
        amount_due: 7900,
        amount_paid: 0,
        hosted_invoice_url: opts.hostedUrl ?? null,
        created: Math.floor(Date.now() / 1000),
        status_transitions: { paid_at: null },
        parent: { subscription_details: { subscription: opts.subscription, metadata: { billingAccountId: accountId } } },
      },
    },
  });

  beforeAll(async () => {
    t = await bootApp();
    stripe.install(t.app.get(StripeProvider));
    for (const [key, price] of [["growth", PRICE_GROWTH_MONTH], ["starter", PRICE_STARTER_MONTH]] as const) {
      await t.prisma.db.plan.update({ where: { key }, data: { providerPrices: { stripe: { month: price, year: `${price}_year` } } } });
    }
  });
  afterAll(async () => t.close());

  it("3.1.4: re-checks seats when an expired invitation is resent and when an invitation is accepted", async () => {
    const { agent: owner, w } = await account("seats"); // Starter trial: 2 seats, the owner holds one
    const invitee = await signUp(t, "seat-invitee@acme.test");
    await owner.post(`/v1/workspaces/${w}/invitations`).send({ email: "seat-invitee@acme.test", role: "member" }).expect(201);

    // The plan shrinks after the invitation went out: accepting it is refused.
    await setPlan(t, w, "free");
    const refused = await invitee.post(`/v1/invitations/${inviteToken("seat-invitee@acme.test")}/accept`).expect(402);
    expect(refused.body.error.details).toMatchObject({ limit: "seats", allowed: 1 });
    expect(await t.prisma.db.membership.count({ where: { workspaceId: w } })).toBe(1);

    // Back on Starter: the invitation expires (stops holding a seat), another fills the seat, and resending the old one is refused.
    await setPlan(t, w, "starter");
    const old = await t.prisma.db.invitation.findFirstOrThrow({ where: { workspaceId: w, email: "seat-invitee@acme.test" } });
    await t.prisma.db.invitation.update({ where: { id: old.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await owner.post(`/v1/workspaces/${w}/invitations`).send({ email: "seat-second@acme.test", role: "member" }).expect(201);
    await owner.post(`/v1/workspaces/${w}/invitations/${old.id}/resend`).expect(402);

    // Accepting at exactly the limit is fine: the pending invitation already held its seat.
    await t.http().post(`/v1/invitations/${inviteToken("seat-second@acme.test")}/register`).send({ name: "Second", password: "Correct-horse-9" }).expect(201);
    expect(await t.prisma.db.membership.count({ where: { workspaceId: w } })).toBe(2);

    // Registering through an invitation the plan has no seat for is refused before the account is created.
    const token = "seat-third-token";
    await t.prisma.db.invitation.create({ data: { workspaceId: w, email: "seat-third@acme.test", role: "member", tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 86_400_000) } });
    await t.http().post(`/v1/invitations/${token}/register`).send({ name: "Third", password: "Correct-horse-9" }).expect(402);
    expect(await t.prisma.db.user.count({ where: { email: "seat-third@acme.test" } })).toBe(0);
  });

  it("3.1.5: parallel contact creates and imports cannot overshoot the contact limit", async () => {
    const { agent, w } = await account("race");
    await withLimits("starter", { contacts: 3 }, async () => {
      const results = await Promise.all(Array.from({ length: 8 }, (_, i) => agent.post(`/v1/workspaces/${w}/contacts`).send({ fullName: `Racer ${i}`, email: `racer${i}@race.test` })));
      expect(results.filter((r) => r.status === 201)).toHaveLength(3);
      expect(results.filter((r) => r.status === 402)).toHaveLength(5);
    });
    await withLimits("starter", { contacts: 5 }, async () => {
      const csv = (n: string) => ["email", ...[1, 2, 3, 4].map((i) => `import${n}-${i}@race.test`)].join("\n");
      const a = await agent.post(`/v1/workspaces/${w}/imports`).send({ fileName: "a.csv", csv: csv("a"), mapping: { email: "email" }, tags: [], onDuplicate: "update" }).expect(201);
      const b = await agent.post(`/v1/workspaces/${w}/imports`).send({ fileName: "b.csv", csv: csv("b"), mapping: { email: "email" }, tags: [], onDuplicate: "update" }).expect(201);
      const imports = t.app.get(ImportsService);
      await Promise.all([imports.process(w, a.body.data.id), imports.process(w, b.body.data.id)]);
      expect(await t.prisma.db.contact.count({ where: { workspaceId: w, deletedAt: null } })).toBe(5);
      const rows = await t.prisma.db.import.findMany({ where: { workspaceId: w } });
      expect(rows.reduce((n, r) => n + r.createdCount, 0)).toBe(2);
    });
  });

  it("3.1.6: an assigned plan clears the old Stripe ids, ignores late Stripe news, and lapses at its end date", async () => {
    const { accountId } = await account("manual");
    await post(subscriptionEvent("customer.subscription.created", accountId, { status: "active", price: PRICE_STARTER_MONTH, subId: "sub_manual_old", customer: "cus_manual_old" })).expect(200);
    stripe.says("sub_manual_old", { status: "canceled" });
    await post(subscriptionEvent("customer.subscription.deleted", accountId, { status: "canceled", price: PRICE_STARTER_MONTH, subId: "sub_manual_old", customer: "cus_manual_old" })).expect(200);

    const billing = t.app.get(BillingService);
    await billing.adminAssign(null as never, accountId, { planKey: "growth", interval: "month", status: "active", periodEnd: new Date(Date.now() + 3_600_000), reason: "Invoiced" });
    let sub = await subOf(accountId);
    expect(sub).toMatchObject({ provider: "manual", status: "active", providerSubscriptionId: null, providerCustomerId: null });

    // A late delivery about the old subscription must not undo the assignment.
    await post(subscriptionEvent("customer.subscription.deleted", accountId, { status: "canceled", price: PRICE_STARTER_MONTH, subId: "sub_manual_old", customer: "cus_manual_old", created: Math.floor(Date.now() / 1000) + 30 })).expect(200);
    sub = await subOf(accountId);
    expect(sub).toMatchObject({ provider: "manual", status: "active" });
    expect(sub.plan.key).toBe("growth");

    // Past its end date the plan lapses at once, and the hourly job records it and tells the owner.
    await t.prisma.db.subscription.update({ where: { id: sub.id }, data: { currentPeriodEnd: new Date(Date.now() - 1000) } });
    expect((await t.app.get(EntitlementsService).forAccount(accountId)).effectivePlan.key).toBe("free");
    await billing.expireTrials();
    expect((await subOf(accountId)).status).toBe("expired");
    expect(t.mail.outbox.some((m) => m.to === "fix-manual@acme.test" && m.subject === "Your Growth plan has ended")).toBe(true);
  });

  it("3.1.7: saving a plan checks the Stripe prices and copies their amounts", async () => {
    const billing = t.app.get(BillingService);
    stripe.prices.set("price_ok_month", { amountCents: 4500, currency: "EUR", interval: "month" });
    stripe.prices.set("price_ok_year", { amountCents: 45000, currency: "EUR", interval: "year" });
    stripe.prices.set("price_weekly", { amountCents: 900, currency: "EUR", interval: "week" });
    const typed = { currency: "USD", monthlyPriceCents: 1, annualPriceCents: 2 };
    expect(await billing.verifyPlanPrices({ stripe: { month: "price_ok_month", year: "price_ok_year" } }, typed)).toEqual({ currency: "EUR", monthlyPriceCents: 4500, annualPriceCents: 45000, notices: [] });
    await expect(billing.verifyPlanPrices({ stripe: { month: "price_weekly" } }, typed)).rejects.toThrow(/must bill every 1 month/);
    await expect(billing.verifyPlanPrices({ stripe: { month: "price_missing" } }, typed)).rejects.toThrow(/does not exist/);

    const provider = t.app.get(StripeProvider);
    const configured = provider.isConfigured;
    provider.isConfigured = () => false;
    try {
      const unchecked = await billing.verifyPlanPrices({ stripe: { month: "price_missing" } }, typed);
      expect(unchecked).toMatchObject(typed);
      expect(unchecked.notices[0]).toMatch(/not configured/);
    } finally {
      provider.isConfigured = configured;
    }
  });

  it("3.1.8: a workspace admin who does not own the billing account sees only this workspace", async () => {
    const { agent: owner, w, accountId } = await account("agency");
    await setPlan(t, w, "agency");
    const client = await owner.post("/v1/workspaces").send({ name: "Client WS", businessType: "agency", timezone: "UTC" }).expect(201);
    await owner.post(`/v1/workspaces/${client.body.data.id}/contacts`).send({ fullName: "Client Lead", email: "lead@client.test" }).expect(201);
    await t.prisma.db.billingAccount.update({ where: { id: accountId }, data: { taxId: "DE123456789" } });
    await t.prisma.db.invoice.create({ data: { billingAccountId: accountId, provider: "stripe", providerInvoiceId: "in_agency", status: "paid", issuedAt: new Date() } });
    const admin = await addMember(t, owner, w, "agency-admin@acme.test", "admin");

    const mine = await owner.get(`/v1/workspaces/${w}/billing`).expect(200);
    expect(mine.body.data).toMatchObject({ scope: "account", account: { taxId: "DE123456789" } });
    expect(mine.body.data.invoices).toHaveLength(1);
    expect(mine.body.data.usage.contacts.used).toBe(1);

    const theirs = await admin.get(`/v1/workspaces/${w}/billing`).expect(200);
    expect(theirs.body.data).toMatchObject({ scope: "workspace", account: { taxId: "", billingEmail: "", address: "" }, invoices: [] });
    expect(theirs.body.data.usage.contacts.used).toBe(0);
    expect(theirs.body.data.usage.workspaces.used).toBe(1);
  });

  it("3.1.9: one trial per person (plus-addresses and Gmail dots included) and a few per IP a day", async () => {
    const first = await account("trial-1", "trial.abuser@gmail.com");
    expect((await subOf(first.accountId)).status).toBe("trialing");

    const again = await account("trial-2", "trialabuser+again@googlemail.com");
    const sub = await subOf(again.accountId);
    expect(sub.status).toBe("active");
    expect(sub.plan.key).toBe("free");
    expect(sub.trialEndsAt).toBeNull();
    expect(await t.prisma.db.auditEvent.count({ where: { action: "billing.trial_withheld", targetId: again.accountId } })).toBe(1);
    // Login still uses the address exactly as typed.
    expect(await t.prisma.db.user.count({ where: { email: "trialabuser+again@googlemail.com" } })).toBe(1);

    const config = t.app.get<AppConfig>(APP_CONFIG);
    const ip = (await t.prisma.db.billingAccount.findUniqueOrThrow({ where: { id: first.accountId } })).signupIp!;
    config.TRIALS_PER_IP_PER_DAY = await t.prisma.db.billingAccount.count({ where: { signupIp: ip, trialGrantedAt: { gte: new Date(Date.now() - 86_400_000) } } });
    try {
      const capped = await account("trial-3", "someone-new@acme.test");
      expect((await subOf(capped.accountId)).plan.key).toBe("free");
      const [row] = await t.prisma.db.auditEvent.findMany({ where: { action: "billing.trial_withheld", targetId: capped.accountId } });
      expect(row!.metadata).toMatchObject({ reason: "ip" });
    } finally {
      config.TRIALS_PER_IP_PER_DAY = 0;
    }
  });

  it("3.1.10: SCA, refunds, disputes and uncollectible invoices", async () => {
    const { accountId } = await account("events");
    await post(subscriptionEvent("customer.subscription.created", accountId, { status: "active", price: PRICE_GROWTH_MONTH, subId: "sub_events", customer: "cus_events" })).expect(200);
    const to = (subject: string) => t.mail.outbox.filter((m) => m.to === "fix-events@acme.test" && m.subject === subject);

    await post(invoiceEvent("invoice.payment_action_required", accountId, { id: "in_sca", customer: "cus_events", subscription: "sub_events", hostedUrl: "https://invoice.stripe.test/i/sca" })).expect(200);
    const sca = to("Confirm your Growthdesk payment");
    expect(sca).toHaveLength(1);
    expect(sca[0]!.html + sca[0]!.text).toContain("https://invoice.stripe.test/i/sca");
    expect((await subOf(accountId)).status).toBe("active");

    const refund = { id: "evt_refund_1", object: "event", type: "charge.refunded", created: Math.floor(Date.now() / 1000), data: { object: { id: "ch_events", object: "charge", customer: "cus_events", amount_refunded: 2500, currency: "usd", refunded: false } } };
    await post(refund).expect(200);
    expect(await t.prisma.db.auditEvent.count({ where: { action: "billing.refunded", targetId: accountId } })).toBe(1);
    expect(to("Refund issued")[0]!.text).toContain("$25.00");

    const ops = await signUp(t, "ops-billing@acme.test");
    await t.prisma.db.user.update({ where: { id: ops.userId }, data: { platformRole: "admin" } });
    stripe.chargeCustomers.set("ch_events", "cus_events");
    const dispute = { id: "evt_dispute_1", object: "event", type: "charge.dispute.created", created: Math.floor(Date.now() / 1000), data: { object: { id: "dp_events", object: "dispute", charge: "ch_events", amount: 7900, currency: "usd", reason: "fraudulent" } } };
    await post(dispute).expect(200);
    expect(await t.prisma.db.auditEvent.count({ where: { action: "billing.dispute_opened", targetId: accountId } })).toBe(1);
    expect(t.mail.outbox.some((m) => m.to === "ops-billing@acme.test" && m.subject.startsWith("Payment disputed: $79.00"))).toBe(true);
    expect((await subOf(accountId)).status).toBe("active");

    // Stripe has stopped retrying: no point waiting out the grace period.
    stripe.says("sub_events", { status: "past_due" });
    await post(invoiceEvent("invoice.marked_uncollectible", accountId, { id: "in_uncollectible", customer: "cus_events", subscription: "sub_events", status: "uncollectible" })).expect(200);
    const sub = await subOf(accountId);
    expect(sub.status).toBe("past_due");
    expect(sub.graceUntil!.getTime()).toBeLessThanOrEqual(Date.now());
    expect((await t.app.get(EntitlementsService).forAccount(accountId)).access).toBe("restricted");
    expect(to("Sending is paused: your Growthdesk invoice is unpaid")).toHaveLength(1);
    await t.app.get(BillingService).sendNotices();
    expect(to("Sending is paused: your Growthdesk invoice is unpaid")).toHaveLength(1);
  });

  it("3.1.11: hidden plans are not for sale, resuming an ended subscription is a 400, refunds use the period counted", async () => {
    const { agent, w, accountId } = await account("small");
    await t.prisma.db.plan.update({ where: { key: "growth" }, data: { isPublic: false } });
    try {
      await agent.post(`/v1/workspaces/${w}/billing/checkout`).send({ planKey: "growth", interval: "month" }).expect(404);
    } finally {
      await t.prisma.db.plan.update({ where: { key: "growth" }, data: { isPublic: true } });
    }

    await t.prisma.db.subscription.update({ where: { billingAccountId: accountId }, data: { provider: "stripe", providerSubscriptionId: "sub_small_ended", status: "canceled" } });
    const res = await agent.post(`/v1/workspaces/${w}/billing/resume`).expect(400);
    expect(res.body.error.message).toMatch(/ended/);

    const ent = t.app.get(EntitlementsService);
    const period = await ent.consume(w, accountId, "monthlyAiCredits", 1);
    expect(period).toBe((await ent.meterPeriodFor(accountId)).key);
  });
});
