import { Inject, Injectable, Logger } from "@nestjs/common";
import { readLimits, type BillingInterval, type LimitKey, isUnlimited, LIMIT_LABELS } from "@growthdesk/shared";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { PlatformSettingsService } from "../core/platform-settings.service.js";
import { AuditService } from "../core/audit.service.js";
import { MailService } from "../core/mail.service.js";
import { EntitlementsService } from "./entitlements.service.js";
import { recordSubscriptionChange } from "./subscription-history.js";
import { StripeProvider } from "./providers/stripe.provider.js";
import type { NormalizedEvent, NormalizedInvoice, NormalizedSubscription, PaymentProvider } from "./providers/payment-provider.js";
import { badRequest, conflict, notFound, unavailable } from "../common/errors.js";
import { ws, type RequestContext } from "../common/context.js";
import type { Plan } from "../generated/prisma/client.js";

/** Statuses in which a provider subscription is still billing (or about to). */
const LIVE_STATUSES: readonly string[] = ["active", "trialing", "past_due", "incomplete", "paused"];

const daysLeft = (until: Date, now = new Date()) => Math.max(0, Math.ceil((until.getTime() - now.getTime()) / 86_400_000));
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const priceFor = (plan: Plan, provider: string, interval: BillingInterval): string | null => {
  const prices = (plan.providerPrices ?? {}) as Record<string, Record<string, string>>;
  return prices[provider]?.[interval] ?? null;
};

@Injectable()
export class BillingService {
  private readonly log = new Logger("billing");
  private readonly providers: Record<string, PaymentProvider>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly platform: PlatformSettingsService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    stripe: StripeProvider,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.providers = { stripe };
  }

  provider(id: string): PaymentProvider {
    const p = this.providers[id];
    if (!p) throw notFound("That payment provider");
    return p;
  }

  /** The checkout provider for this install: the first configured one. */
  private checkoutProvider(): PaymentProvider | null {
    return Object.values(this.providers).find((p) => p.isConfigured()) ?? null;
  }

  async publicPlans() {
    const plans = await this.prisma.db.plan.findMany({ where: { isActive: true, isPublic: true }, orderBy: { sortOrder: "asc" } });
    return plans.map((p) => ({
      key: p.key,
      name: p.name,
      description: p.description,
      currency: p.currency,
      monthlyPriceCents: p.monthlyPriceCents,
      annualPriceCents: p.annualPriceCents,
      trialDays: p.trialDays,
      limits: p.limits,
      features: p.features,
    }));
  }

  async overview(ctx: RequestContext) {
    const w = ws(ctx);
    const summary = await this.entitlements.summary(w.billingAccountId);
    const account = await this.prisma.db.billingAccount.findUniqueOrThrow({ where: { id: w.billingAccountId } });
    const invoices = await this.prisma.db.invoice.findMany({
      where: { billingAccountId: w.billingAccountId },
      orderBy: { issuedAt: "desc" },
      take: 50,
    });
    const checkout = this.checkoutProvider();
    const sub = summary.subscription;
    return {
      account: { id: account.id, name: account.name, billingEmail: account.billingEmail, country: account.country, taxId: account.taxId, address: account.address },
      plan: { key: summary.plan.key, name: summary.plan.name },
      effectivePlan: { key: summary.effectivePlan.key, name: summary.effectivePlan.name },
      subscription: sub
        ? {
            status: sub.status,
            interval: sub.interval,
            provider: sub.provider,
            currentPeriodEnd: sub.currentPeriodEnd,
            trialEndsAt: sub.trialEndsAt,
            cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
            graceUntil: sub.graceUntil,
            managedByProvider: Boolean(sub.providerSubscriptionId),
          }
        : null,
      access: summary.access,
      reason: summary.reason,
      usage: summary.usage,
      features: summary.features,
      invoices: invoices.map((i) => ({
        id: i.id,
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
      payments: { available: Boolean(checkout), provider: checkout?.label ?? null },
      plans: await this.publicPlans(),
    };
  }

  async updateDetails(ctx: RequestContext, input: { name?: string; billingEmail?: string; country?: string; taxId?: string; address?: string }) {
    const w = ws(ctx);
    await this.prisma.db.billingAccount.update({ where: { id: w.billingAccountId }, data: input });
    await this.audit.record(ctx, { action: "billing.details_updated", targetType: "billing_account", targetId: w.billingAccountId });
    return { ok: true };
  }

  /** Refuses a downgrade the account's current usage would not fit into. */
  private async assertFits(billingAccountId: string, plan: Plan) {
    const limits = readLimits(plan.limits);
    const over: string[] = [];
    // Every counted limit; metered monthly allowances simply apply from the next send.
    for (const key of ["seats", "mailboxes", "workspaces", "contacts", "activeCampaigns", "channelIntegrations", "sendingDomains", "marketingContacts"] as LimitKey[]) {
      if (isUnlimited(limits[key])) continue;
      const used = await this.entitlements.usage(billingAccountId, key);
      if (used > limits[key]) over.push(`${LIMIT_LABELS[key]}: ${used} in use, ${plan.name} allows ${limits[key]}`);
    }
    if (over.length) throw conflict(`Reduce usage before moving to ${plan.name} — ${over.join("; ")}.`);
  }

  /**
   * Starts a paid subscription (hosted checkout) or, when one already exists
   * at the provider, asks the provider to change its price. Either way the
   * plan in our database only changes when the provider's webhook says so.
   */
  async checkout(ctx: RequestContext, planKey: string, interval: BillingInterval) {
    const w = ws(ctx);
    const provider = this.checkoutProvider();
    if (!provider) throw unavailable("Online payments are not set up on this installation yet. Contact support to change plans.");
    const plan = await this.prisma.db.plan.findUnique({ where: { key: planKey } });
    if (!plan || !plan.isActive) throw notFound("That plan");
    const priceId = priceFor(plan, provider.id, interval);
    if (!priceId) throw badRequest(`${plan.name} has no ${interval === "year" ? "annual" : "monthly"} price configured for ${provider.label}.`);
    await this.assertFits(w.billingAccountId, plan);

    const account = await this.prisma.db.billingAccount.findUniqueOrThrow({
      where: { id: w.billingAccountId },
      include: { subscription: true, owner: true },
    });
    const sub = account.subscription;
    // A second checkout while one subscription is already live would bill twice (two tabs, a double click,
    // a checkout whose webhook has not arrived yet): change the live one's price instead.
    let liveId = sub?.providerSubscriptionId && sub.provider === provider.id && !["canceled", "expired"].includes(sub.status) ? sub.providerSubscriptionId : null;
    if (!liveId && sub?.provider === provider.id && sub.providerCustomerId) liveId = await provider.findLiveSubscription(sub.providerCustomerId);
    if (liveId) {
      await provider.changePrice(liveId, priceId);
      await this.audit.record(ctx, { action: "billing.plan_change_requested", targetType: "plan", targetId: plan.key, metadata: { interval } });
      return { changed: true as const, url: null };
    }
    const base = this.config.PUBLIC_APP_URL.replace(/\/$/, "");
    const { url } = await provider.createCheckout({
      billingAccountId: account.id,
      priceId,
      customerEmail: account.billingEmail || account.owner.email,
      providerCustomerId: sub?.provider === provider.id ? (sub.providerCustomerId ?? null) : null,
      // The free trial is granted at sign-up without a card, so paid checkout starts billing immediately.
      trialDays: 0,
      successUrl: `${base}/w/${w.id}/billing?checkout=success`,
      cancelUrl: `${base}/w/${w.id}/billing?checkout=canceled`,
    });
    await this.audit.record(ctx, { action: "billing.checkout_started", targetType: "plan", targetId: plan.key, metadata: { interval } });
    return { changed: false as const, url };
  }

  async portal(ctx: RequestContext) {
    const w = ws(ctx);
    const sub = await this.prisma.db.subscription.findUnique({ where: { billingAccountId: w.billingAccountId } });
    if (!sub?.providerCustomerId || sub.provider === "none" || sub.provider === "manual") {
      throw badRequest("There is no payment account to manage yet — choose a paid plan first.");
    }
    const base = this.config.PUBLIC_APP_URL.replace(/\/$/, "");
    return this.provider(sub.provider).createPortal({ providerCustomerId: sub.providerCustomerId, returnUrl: `${base}/w/${w.id}/billing` });
  }

  /** Cancel at period end (provider-managed) or end now (trial / no provider). Data is never deleted. */
  async cancel(ctx: RequestContext, resume = false) {
    return this.cancelAccount(ws(ctx).billingAccountId, ctx, resume);
  }

  /**
   * cancel() for a billing account named directly. Also used when the
   * account's last workspace is deleted (docs/PRIVACY_OPS.md), so a deleted
   * customer is not charged again; a paid period runs out as usual.
   */
  async cancelAccount(billingAccountId: string, ctx: RequestContext | null, resume = false) {
    const sub = await this.prisma.db.subscription.findUnique({ where: { billingAccountId } });
    if (!sub) throw notFound("A subscription");
    if (sub.providerSubscriptionId && sub.provider !== "manual" && sub.provider !== "none") {
      await this.provider(sub.provider).setCancelAtPeriodEnd(sub.providerSubscriptionId, !resume);
      await this.audit.record(ctx, { action: resume ? "billing.resume_requested" : "billing.cancel_requested" });
      return { pending: true };
    }
    if (resume) throw badRequest("Nothing to resume — choose a plan instead.");
    await this.prisma.db.$transaction(async (tx) => {
      const after = await tx.subscription.update({
        where: { id: sub.id },
        data: { status: "canceled", canceledAt: new Date(), cancelAtPeriodEnd: false },
      });
      await recordSubscriptionChange(tx, sub, after);
    });
    await this.audit.record(ctx, { action: "billing.canceled" });
    return { pending: false };
  }

  // ─── Webhooks ──────────────────────────────────────────────────────────────

  /**
   * Verifies, records and applies one provider webhook. A redelivered event
   * that was already applied is acknowledged and ignored; one that failed
   * before is applied again. An error propagates as a 500 so the provider
   * retries.
   */
  async handleWebhook(providerId: string, rawBody: Buffer, headers: Record<string, string | string[] | undefined>) {
    const provider = this.provider(providerId);
    const event = provider.parseWebhook(rawBody, headers);

    const existing = await this.prisma.db.billingEvent.findUnique({
      where: { provider_providerEventId: { provider: providerId, providerEventId: event.id } },
    });
    if (existing?.processedAt) return { received: true, duplicate: true };

    const row =
      existing ??
      (await this.prisma.db.billingEvent
        .create({ data: { provider: providerId, providerEventId: event.id, type: event.type, payload: event.raw as never } })
        .catch(async (e: { code?: string }) => {
          // Two deliveries racing: the other one owns it.
          if (e.code === "P2002") return null;
          throw e;
        }));
    if (!row) return { received: true, duplicate: true };

    try {
      const accountId = await this.apply(providerId, event);
      await this.prisma.db.billingEvent.update({
        where: { id: row.id },
        data: { processedAt: new Date(), error: "", attempts: { increment: 1 }, billingAccountId: accountId },
      });
      return { received: true, duplicate: false };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await this.prisma.db.billingEvent.update({ where: { id: row.id }, data: { error: message.slice(0, 1000), attempts: { increment: 1 } } });
      this.log.error(`webhook ${event.type} ${event.id} failed: ${message}`);
      throw e;
    }
  }

  private async accountFor(providerId: string, ref: { billingAccountId?: string | null; providerSubscriptionId?: string | null; providerCustomerId?: string | null }) {
    if (ref.billingAccountId) {
      const a = await this.prisma.db.billingAccount.findUnique({ where: { id: ref.billingAccountId } });
      if (a) return a.id;
    }
    if (ref.providerSubscriptionId) {
      const s = await this.prisma.db.subscription.findUnique({ where: { providerSubscriptionId: ref.providerSubscriptionId } });
      if (s) return s.billingAccountId;
    }
    if (ref.providerCustomerId) {
      const s = await this.prisma.db.subscription.findFirst({ where: { provider: providerId, providerCustomerId: ref.providerCustomerId } });
      if (s) return s.billingAccountId;
    }
    return null;
  }

  private async planForPrice(providerId: string, priceId: string): Promise<{ plan: Plan; interval: BillingInterval } | null> {
    const plans = await this.prisma.db.plan.findMany();
    for (const plan of plans) {
      for (const interval of ["month", "year"] as const) {
        if (priceFor(plan, providerId, interval) === priceId) return { plan, interval };
      }
    }
    return null;
  }

  private async apply(providerId: string, event: NormalizedEvent): Promise<string | null> {
    if (event.checkout) {
      const { billingAccountId, providerCustomerId } = event.checkout;
      const sub = await this.prisma.db.subscription.findUnique({ where: { billingAccountId } });
      if (sub) {
        await this.prisma.db.subscription.update({ where: { id: sub.id }, data: { providerCustomerId } });
      }
      return billingAccountId;
    }

    if (event.subscription) {
      // Apply the provider's current state, not the payload: events can arrive out of order within the
      // same second, and only a fresh read says which one is newest (docs/GAP_PLAN.md §0.9).
      const fresh = await this.provider(providerId).fetchSubscription(event.subscription.providerSubscriptionId);
      return this.applySubscription(providerId, { ...fresh, billingAccountId: event.subscription.billingAccountId ?? fresh.billingAccountId }, event.createdAt, false);
    }

    if (event.invoice) {
      const inv = event.invoice;
      const accountId = await this.accountFor(providerId, {
        billingAccountId: inv.billingAccountId,
        providerSubscriptionId: inv.providerSubscriptionId,
        providerCustomerId: inv.providerCustomerId,
      });
      if (!accountId) {
        this.log.warn(`invoice ${inv.providerInvoiceId} belongs to no known account; ignored`);
        return null;
      }
      const data = {
        billingAccountId: accountId,
        number: inv.number,
        status: inv.status,
        currency: inv.currency,
        amountDueCents: inv.amountDueCents,
        amountPaidCents: inv.amountPaidCents,
        hostedUrl: inv.hostedUrl,
        pdfUrl: inv.pdfUrl,
        periodStart: inv.periodStart,
        periodEnd: inv.periodEnd,
        issuedAt: inv.issuedAt,
        paidAt: inv.paidAt,
      };
      await this.prisma.db.invoice.upsert({
        where: { provider_providerInvoiceId: { provider: providerId, providerInvoiceId: inv.providerInvoiceId } },
        create: { provider: providerId, providerInvoiceId: inv.providerInvoiceId, ...data },
        update: data,
      });
      if (event.paymentFailed) await this.paymentFailed(providerId, accountId, inv);
      return accountId;
    }
    return null;
  }

  async applySubscription(providerId: string, s: NormalizedSubscription, eventAt: Date, deleted: boolean): Promise<string | null> {
    const accountId = await this.accountFor(providerId, {
      billingAccountId: s.billingAccountId,
      providerSubscriptionId: s.providerSubscriptionId,
      providerCustomerId: s.providerCustomerId,
    });
    if (!accountId) {
      this.log.warn(`subscription ${s.providerSubscriptionId} belongs to no known account; ignored`);
      return null;
    }
    const mapped = await this.planForPrice(providerId, s.priceId);
    if (!mapped) this.log.error(`price ${s.priceId} is not mapped to any plan; plan left unchanged`);
    const settings = await this.platform.get();
    const status = deleted ? "canceled" : s.status;

    const outcome = await this.prisma.db.$transaction(async (tx) => {
      // One writer per account at a time: concurrent deliveries for the same subscription queue up here.
      await tx.$queryRaw`SELECT 1 FROM "Subscription" WHERE "billingAccountId" = ${accountId}::uuid FOR UPDATE`;
      const current = await tx.subscription.findUnique({ where: { billingAccountId: accountId } });

      // An event about a different subscription than the account's live one: a duplicate checkout, or a
      // stale event for an old subscription. It must not overwrite the live one (docs/GAP_PLAN.md §0.8).
      if (current?.provider === providerId && current.providerSubscriptionId && current.providerSubscriptionId !== s.providerSubscriptionId && LIVE_STATUSES.includes(current.status)) {
        return { kind: "foreign" as const, current };
      }

      const graceUntil =
        status === "past_due"
          ? current?.status === "past_due" && current.graceUntil
            ? current.graceUntil
            : new Date(eventAt.getTime() + settings.graceDays * 86_400_000)
          : null;
      const data = {
        status,
        provider: providerId,
        providerSubscriptionId: s.providerSubscriptionId,
        providerCustomerId: s.providerCustomerId,
        interval: mapped?.interval ?? s.interval,
        // The provider's real price (reconciliation fills it in for rows written before it was captured).
        priceCents: s.priceCents,
        priceCurrency: s.priceCents === null ? null : s.priceCurrency,
        currentPeriodStart: s.currentPeriodStart,
        currentPeriodEnd: s.currentPeriodEnd,
        trialEndsAt: s.trialEndsAt,
        cancelAtPeriodEnd: s.cancelAtPeriodEnd,
        canceledAt: s.canceledAt ?? (deleted ? eventAt : null),
        graceUntil,
        providerEventAt: current?.providerEventAt && current.providerEventAt > eventAt ? current.providerEventAt : eventAt,
        ...(mapped ? { planId: mapped.plan.id } : {}),
      };
      const after = current
        ? await tx.subscription.update({ where: { id: current.id }, data })
        : mapped
          ? await tx.subscription.create({ data: { billingAccountId: accountId, planId: mapped.plan.id, ...data } })
          : null;
      if (after) await recordSubscriptionChange(tx, current, after);
      return { kind: "applied" as const, before: current?.status ?? null, after };
    });

    if (outcome.kind === "foreign") {
      const live = outcome.current;
      // Our row may be the stale one: if the provider says it has ended, the new subscription replaces it.
      const liveFresh = await this.provider(providerId).fetchSubscription(live.providerSubscriptionId!).catch(() => null);
      if (liveFresh && !LIVE_STATUSES.includes(liveFresh.status)) {
        await this.applySubscription(providerId, { ...liveFresh, billingAccountId: accountId }, eventAt, false);
        return this.applySubscription(providerId, s, eventAt, deleted);
      }
      this.log.error(`account ${accountId} has a second ${providerId} subscription ${s.providerSubscriptionId} (${s.status}) besides ${live.providerSubscriptionId}; not applied`);
      await this.audit.record(
        null,
        { action: "billing.duplicate_subscription", targetType: "billing_account", targetId: accountId, metadata: { live: live.providerSubscriptionId, other: s.providerSubscriptionId, otherStatus: s.status } },
        "system",
      );
      return accountId;
    }

    if (outcome.before === "past_due" && outcome.after?.status === "active") await this.notifyOwner(accountId, "Payment received, thank you", "Your Growthdesk subscription is paid up and everything is running normally again.");
    await this.audit.record(null, { action: `billing.subscription_${status}`, targetType: "billing_account", targetId: accountId, metadata: { plan: mapped?.plan.key, provider: providerId } }, "system");
    return accountId;
  }

  /**
   * invoice.payment_failed. Ignored when the invoice is already paid or belongs
   * to another subscription (a late or retried delivery after a successful
   * retry must not put a paying account back to past due). Otherwise the
   * subscription's current state is read from the provider and applied, and
   * the owner is told how long the grace period really has left.
   */
  private async paymentFailed(providerId: string, billingAccountId: string, inv: NormalizedInvoice) {
    if (inv.status === "paid" || (inv.amountDueCents > 0 && inv.amountPaidCents >= inv.amountDueCents)) return;
    const sub = await this.prisma.db.subscription.findUnique({ where: { billingAccountId } });
    if (!sub?.providerSubscriptionId || sub.provider !== providerId) return;
    if (inv.providerSubscriptionId && inv.providerSubscriptionId !== sub.providerSubscriptionId) return;
    const fresh = await this.provider(providerId).fetchSubscription(sub.providerSubscriptionId);
    await this.applySubscription(providerId, { ...fresh, billingAccountId }, new Date(), false);
    const after = await this.prisma.db.subscription.findUniqueOrThrow({ where: { billingAccountId } });
    if (after.status !== "past_due" || !after.graceUntil) return;
    const left = daysLeft(after.graceUntil);
    await this.notifyOwner(
      billingAccountId,
      "Payment failed for your Growthdesk subscription",
      left > 0
        ? `We could not take the latest payment. Your workspace keeps working for ${plural(left, "more day")}; after that, sending pauses until the invoice is paid. Update your payment method from Billing.`
        : "We could not take the latest payment, and the grace period has ended: sending is paused until the invoice is paid. Update your payment method from Billing.",
    );
  }

  /** Emails the billing contact (billing email, or the account owner). */
  private async notifyOwner(billingAccountId: string, title: string, body: string) {
    const account = await this.prisma.db.billingAccount.findUnique({ where: { id: billingAccountId }, include: { owner: true, workspaces: { select: { id: true }, take: 1, orderBy: { createdAt: "asc" } } } });
    if (!account) return;
    const ws = account.workspaces[0];
    await this.mail.notification(account.billingEmail || account.owner.email, title, body, ws ? `/w/${ws.id}/settings/billing` : "/");
  }

  /**
   * Hourly billing notices, each sent once per occasion (Subscription.noticesSent):
   *   trial_ending  a trial ends within 3 days
   *   grace_ending  a past-due account's grace period ends within 24 hours
   *   restricted    the grace period has ended (sending is paused)
   * "Payment received" is sent when a past-due subscription becomes active (applySubscription).
   */
  async sendNotices(now = new Date()) {
    const soon = new Date(now.getTime() + 3 * 86_400_000);
    const subs = await this.prisma.db.subscription.findMany({
      where: {
        OR: [
          { status: "trialing", trialEndsAt: { gt: now, lte: soon } },
          { status: "past_due", graceUntil: { not: null, lte: new Date(now.getTime() + 86_400_000) } },
        ],
      },
    });
    let sent = 0;
    for (const sub of subs) {
      const notices = (sub.noticesSent ?? {}) as Record<string, string>;
      let key: string | null = null;
      let about: Date | null = null;
      let title = "";
      let body = "";
      if (sub.status === "trialing" && sub.trialEndsAt) {
        key = "trial_ending";
        about = sub.trialEndsAt;
        const left = daysLeft(sub.trialEndsAt, now);
        title = `Your Growthdesk trial ends in ${plural(left, "day")}`;
        body = sub.providerSubscriptionId
          ? "Your paid plan starts automatically when the trial ends. Check your payment details in Billing if anything has changed."
          : "Choose a plan in Billing to keep your current limits. Nothing is deleted if you don't; the free allowance applies.";
      } else if (sub.status === "past_due" && sub.graceUntil) {
        about = sub.graceUntil;
        if (sub.graceUntil > now) {
          key = "grace_ending";
          title = "Sending pauses tomorrow unless the invoice is paid";
          body = "The latest payment for your Growthdesk subscription still hasn't gone through. Update your payment method in Billing to keep campaigns sending.";
        } else {
          key = "restricted";
          title = "Sending is paused: your Growthdesk invoice is unpaid";
          body = "Your workspace is read-only for sending and imports until the invoice is paid. Your data is safe. Update your payment method in Billing to resume.";
        }
      }
      if (!key || !about || notices[key] === about.toISOString()) continue;
      await this.notifyOwner(sub.billingAccountId, title, body);
      await this.prisma.db.subscription.update({ where: { id: sub.id }, data: { noticesSent: { ...notices, [key]: about.toISOString() } } });
      sent++;
    }
    return sent;
  }

  // ─── Platform admin ────────────────────────────────────────────────────────

  /** Assigns a plan without a payment provider (invoiced customers, the operator's own workspace). Audited. */
  async adminAssign(ctx: RequestContext, billingAccountId: string, input: { planKey: string; interval: BillingInterval; status: "active" | "trialing"; periodEnd?: Date | null; reason: string }) {
    const plan = await this.prisma.db.plan.findUnique({ where: { key: input.planKey } });
    if (!plan) throw notFound("That plan");
    const sub = await this.prisma.db.subscription.findUnique({ where: { billingAccountId } });
    if (sub?.provider === "stripe" && sub.providerSubscriptionId && ["active", "trialing", "past_due"].includes(sub.status)) {
      throw conflict("This account pays through Stripe. Change or cancel it there; an override here would leave Stripe billing for a plan they no longer have.");
    }
    const data = {
      planId: plan.id,
      status: input.status,
      interval: input.interval,
      provider: "manual",
      currentPeriodStart: new Date(),
      currentPeriodEnd: input.periodEnd ?? null,
      trialEndsAt: input.status === "trialing" ? (input.periodEnd ?? new Date(Date.now() + 14 * 86_400_000)) : null,
      cancelAtPeriodEnd: false,
      canceledAt: null,
      graceUntil: null,
      // No provider charges this: revenue reporting uses the plan's list price, marked estimated.
      priceCents: null,
      priceCurrency: null,
    };
    await this.prisma.db.$transaction(async (tx) => {
      const after = sub ? await tx.subscription.update({ where: { id: sub.id }, data }) : await tx.subscription.create({ data: { billingAccountId, ...data } });
      await recordSubscriptionChange(tx, sub, after);
    });
    const workspaces = await this.prisma.db.workspace.findMany({ where: { billingAccountId }, select: { id: true } });
    for (const w of workspaces) {
      await this.audit.record(ctx, { workspaceId: w.id, action: "platform.plan_assigned", targetType: "billing_account", targetId: billingAccountId, metadata: { plan: plan.key, reason: input.reason } }, "platform_admin");
    }
    return { ok: true };
  }

  /** Daily: an unpaid trial with no provider ends; the owner is told. Entitlements already treat it as ended. */
  async expireTrials(now = new Date()) {
    const due = await this.prisma.db.subscription.findMany({
      where: { status: "trialing", trialEndsAt: { lte: now }, providerSubscriptionId: null },
      include: { billingAccount: { include: { owner: true } } },
    });
    for (const sub of due) {
      await this.prisma.db.$transaction(async (tx) => {
        const after = await tx.subscription.update({ where: { id: sub.id }, data: { status: "expired" } });
        await recordSubscriptionChange(tx, sub, after);
      });
      await this.mail.sendTemplate("trial_ended", sub.billingAccount.billingEmail || sub.billingAccount.owner.email, { action_url: this.mail.link("/") }, { userId: sub.billingAccount.owner.id });
    }
    return due.length;
  }

  /**
   * Daily: re-read provider-managed subscriptions to correct any missed webhook.
   * This also backfills Subscription.priceCents for rows written before the
   * price was captured (applySubscription stores the fetched price).
   */
  async reconcile() {
    const subs = await this.prisma.db.subscription.findMany({
      where: { providerSubscriptionId: { not: null }, provider: { notIn: ["none", "manual"] }, status: { notIn: ["canceled", "expired"] } },
    });
    let fixed = 0;
    for (const sub of subs) {
      const provider = this.providers[sub.provider];
      if (!provider?.isConfigured() || !sub.providerSubscriptionId) continue;
      try {
        const fresh = await provider.fetchSubscription(sub.providerSubscriptionId);
        await this.applySubscription(sub.provider, { ...fresh, billingAccountId: sub.billingAccountId }, new Date(), false);
        fixed += 1;
      } catch (e) {
        this.log.warn(`reconcile ${sub.providerSubscriptionId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return fixed;
  }
}
