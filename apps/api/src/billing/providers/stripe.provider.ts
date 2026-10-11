import { Inject, Injectable } from "@nestjs/common";
import Stripe from "stripe";
import type { SubscriptionStatus } from "@growthdesk/shared";
import { APP_CONFIG, type AppConfig } from "../../config/config.js";
import { badRequest, unavailable } from "../../common/errors.js";
import type { NormalizedCharge, NormalizedEvent, NormalizedInvoice, NormalizedSubscription, PaymentProvider, ProviderPrice } from "./payment-provider.js";

const toDate = (s: number | null | undefined) => (s ? new Date(s * 1000) : null);

/** Stripe statuses onto ours. "unpaid" and "paused" both mean money is owed. */
export function mapStripeStatus(status: string): SubscriptionStatus {
  switch (status) {
    case "trialing":
      return "trialing";
    case "active":
      return "active";
    case "past_due":
    case "unpaid":
    case "paused":
      return "past_due";
    case "canceled":
      return "canceled";
    case "incomplete":
      return "incomplete";
    case "incomplete_expired":
      return "expired";
    default:
      return "incomplete";
  }
}

type StripeSubLike = {
  id: string;
  customer: string | { id: string };
  status: string;
  cancel_at_period_end: boolean;
  canceled_at: number | null;
  trial_end: number | null;
  metadata?: Record<string, string> | null;
  current_period_start?: number;
  current_period_end?: number;
  items: {
    data: {
      price: { id: string; unit_amount?: number | null; currency?: string | null; recurring?: { interval?: string; interval_count?: number | null } | null };
      quantity?: number | null;
      current_period_start?: number;
      current_period_end?: number;
    }[];
  };
};

/**
 * The flat amount charged per month or year for this item, or null when the
 * price is not a flat month/year amount (tiered or metered prices, weekly
 * intervals) — revenue reporting then falls back to the plan's list price
 * and says it is estimated, rather than guessing.
 */
export function stripeItemPrice(item: StripeSubLike["items"]["data"][number] | undefined): { priceCents: number | null; priceCurrency: string | null } {
  const price = item?.price;
  const interval = price?.recurring?.interval;
  if (!price || typeof price.unit_amount !== "number" || !price.currency || (interval !== "month" && interval !== "year")) {
    return { priceCents: null, priceCurrency: null };
  }
  const every = Math.max(1, price.recurring?.interval_count ?? 1);
  const quantity = Math.max(1, item?.quantity ?? 1);
  return { priceCents: Math.round((price.unit_amount * quantity) / every), priceCurrency: price.currency.toUpperCase() };
}

export function normalizeStripeSubscription(sub: StripeSubLike): NormalizedSubscription {
  const item = sub.items.data[0];
  return {
    providerSubscriptionId: sub.id,
    providerCustomerId: typeof sub.customer === "string" ? sub.customer : sub.customer.id,
    status: mapStripeStatus(sub.status),
    priceId: item?.price.id ?? "",
    interval: item?.price.recurring?.interval === "year" ? "year" : "month",
    ...stripeItemPrice(item),
    // Newer API versions moved the period onto the item.
    currentPeriodStart: toDate(item?.current_period_start ?? sub.current_period_start),
    currentPeriodEnd: toDate(item?.current_period_end ?? sub.current_period_end),
    trialEndsAt: toDate(sub.trial_end),
    cancelAtPeriodEnd: sub.cancel_at_period_end,
    canceledAt: toDate(sub.canceled_at),
    billingAccountId: sub.metadata?.billingAccountId ?? null,
  };
}

type StripeInvoiceLike = {
  id: string;
  customer: string | { id: string } | null;
  number: string | null;
  status: string | null;
  currency: string;
  amount_due: number;
  amount_paid: number;
  hosted_invoice_url?: string | null;
  invoice_pdf?: string | null;
  period_start: number;
  period_end: number;
  created: number;
  status_transitions?: { paid_at?: number | null };
  subscription?: string | { id: string } | null;
  parent?: { subscription_details?: { subscription?: string | { id: string } | null; metadata?: Record<string, string> | null } | null } | null;
  metadata?: Record<string, string> | null;
};

export function normalizeStripeInvoice(inv: StripeInvoiceLike): NormalizedInvoice {
  const subRef = inv.subscription ?? inv.parent?.subscription_details?.subscription ?? null;
  return {
    providerInvoiceId: inv.id,
    providerCustomerId: typeof inv.customer === "string" ? inv.customer : (inv.customer?.id ?? ""),
    providerSubscriptionId: subRef ? (typeof subRef === "string" ? subRef : subRef.id) : null,
    number: inv.number ?? "",
    status: inv.status ?? "draft",
    currency: inv.currency.toUpperCase(),
    amountDueCents: inv.amount_due,
    amountPaidCents: inv.amount_paid,
    hostedUrl: inv.hosted_invoice_url ?? "",
    pdfUrl: inv.invoice_pdf ?? "",
    periodStart: toDate(inv.period_start),
    periodEnd: toDate(inv.period_end),
    issuedAt: new Date(inv.created * 1000),
    paidAt: toDate(inv.status_transitions?.paid_at ?? null),
    billingAccountId: inv.parent?.subscription_details?.metadata?.billingAccountId ?? inv.metadata?.billingAccountId ?? null,
  };
}

const idOf = (ref: unknown): string | null => (typeof ref === "string" ? ref : ref && typeof ref === "object" && "id" in ref ? String((ref as { id: unknown }).id) : null);

/** charge.refunded (a Charge) or charge.dispute.created (a Dispute, which names only its charge). */
export function normalizeStripeCharge(type: string, obj: Record<string, unknown>): NormalizedCharge {
  const metadata = (obj.metadata ?? null) as Record<string, string> | null;
  if (type === "charge.refunded") {
    return {
      kind: "refund",
      providerChargeId: String(obj.id),
      providerCustomerId: idOf(obj.customer),
      amountCents: Number(obj.amount_refunded ?? 0),
      currency: String(obj.currency ?? "").toUpperCase(),
      fullRefund: Boolean(obj.refunded),
      reason: "",
      billingAccountId: metadata?.billingAccountId ?? null,
    };
  }
  return {
    kind: "dispute",
    providerChargeId: idOf(obj.charge) ?? "",
    providerCustomerId: null,
    amountCents: Number(obj.amount ?? 0),
    currency: String(obj.currency ?? "").toUpperCase(),
    fullRefund: false,
    reason: String(obj.reason ?? ""),
    billingAccountId: metadata?.billingAccountId ?? null,
  };
}

@Injectable()
export class StripeProvider implements PaymentProvider {
  readonly id = "stripe";
  readonly label = "Stripe";
  private client: Stripe | null = null;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  isConfigured() {
    return Boolean(this.config.STRIPE_SECRET_KEY && this.config.STRIPE_WEBHOOK_SECRET);
  }

  private stripe(): Stripe {
    if (!this.config.STRIPE_SECRET_KEY) throw unavailable("Card payments are not configured on this installation yet.");
    this.client ??= new Stripe(this.config.STRIPE_SECRET_KEY, { maxNetworkRetries: 2, timeout: 20_000 });
    return this.client;
  }

  async createCheckout(input: Parameters<PaymentProvider["createCheckout"]>[0]) {
    const session = await this.stripe().checkout.sessions.create({
      mode: "subscription",
      client_reference_id: input.billingAccountId,
      ...(input.providerCustomerId ? { customer: input.providerCustomerId } : { customer_email: input.customerEmail || undefined }),
      line_items: [{ price: input.priceId, quantity: 1 }],
      subscription_data: {
        metadata: { billingAccountId: input.billingAccountId },
        ...(input.trialDays > 0 ? { trial_period_days: input.trialDays } : {}),
      },
      metadata: { billingAccountId: input.billingAccountId },
      allow_promotion_codes: true,
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
    });
    if (!session.url) throw badRequest("Stripe did not return a checkout link");
    return { url: session.url };
  }

  private portalConfigId: string | null = null;

  /**
   * A portal for payment methods, invoices and cancelling — but not for
   * switching plans, which goes through checkout() so the downgrade check
   * (assertFits) and immediate upgrade invoicing apply (docs/GAP_PLAN.md §3.1.2).
   * Created once per process; if Stripe refuses, the account's default portal is used.
   */
  private async portalConfiguration(): Promise<string | undefined> {
    if (this.portalConfigId) return this.portalConfigId;
    try {
      const config = await this.stripe().billingPortal.configurations.create({
        features: {
          customer_update: { enabled: true, allowed_updates: ["email", "address", "tax_id", "name"] },
          invoice_history: { enabled: true },
          payment_method_update: { enabled: true },
          subscription_cancel: { enabled: true, mode: "at_period_end" },
          subscription_update: { enabled: false },
        },
        metadata: { growthdesk: "portal-v1" },
      });
      this.portalConfigId = config.id;
      return config.id;
    } catch {
      return undefined;
    }
  }

  async createPortal(input: { providerCustomerId: string; returnUrl: string }) {
    const configuration = await this.portalConfiguration();
    const portal = await this.stripe().billingPortal.sessions.create({ customer: input.providerCustomerId, return_url: input.returnUrl, ...(configuration ? { configuration } : {}) });
    return { url: portal.url };
  }

  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): NormalizedEvent {
    const secret = this.config.STRIPE_WEBHOOK_SECRET;
    if (!secret) throw unavailable("Stripe webhooks are not configured");
    const signature = headers["stripe-signature"];
    if (!signature || Array.isArray(signature)) throw badRequest("Missing Stripe-Signature header");
    type StripeEvent = { id: string; type: string; created: number; data: { object: Record<string, unknown> } };
    let event: StripeEvent;
    try {
      // constructEvent verifies the HMAC and the timestamp tolerance; it throws on any mismatch.
      event = Stripe.webhooks.constructEvent(rawBody, signature, secret) as unknown as StripeEvent;
    } catch {
      // A forged or stale delivery is the sender's fault (400), not ours (500).
      throw badRequest("Invalid Stripe-Signature");
    }
    const out: NormalizedEvent = { id: event.id, type: event.type, createdAt: new Date(event.created * 1000), raw: event };
    const obj = event.data.object;
    switch (event.type) {
      case "checkout.session.completed": {
        const accountId = (obj.client_reference_id as string | null) ?? (obj.metadata as Record<string, string> | null)?.billingAccountId;
        const customer = obj.customer as string | { id: string } | null;
        const sub = obj.subscription as string | { id: string } | null;
        if (accountId && customer) {
          out.checkout = {
            billingAccountId: accountId,
            providerCustomerId: typeof customer === "string" ? customer : customer.id,
            providerSubscriptionId: sub ? (typeof sub === "string" ? sub : sub.id) : null,
          };
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
      case "customer.subscription.paused":
      case "customer.subscription.resumed":
        out.subscription = normalizeStripeSubscription(obj as unknown as StripeSubLike);
        break;
      case "invoice.paid":
      case "invoice.payment_succeeded":
      case "invoice.finalized":
      case "invoice.voided":
        out.invoice = normalizeStripeInvoice(obj as unknown as StripeInvoiceLike);
        break;
      case "invoice.payment_failed":
        out.invoice = normalizeStripeInvoice(obj as unknown as StripeInvoiceLike);
        out.paymentFailed = true;
        break;
      case "invoice.payment_action_required":
        out.invoice = normalizeStripeInvoice(obj as unknown as StripeInvoiceLike);
        out.actionRequired = true;
        break;
      case "invoice.marked_uncollectible":
        out.invoice = normalizeStripeInvoice(obj as unknown as StripeInvoiceLike);
        out.uncollectible = true;
        break;
      case "charge.refunded":
      case "charge.dispute.created":
        out.charge = normalizeStripeCharge(event.type, obj);
        break;
      default:
        break;
    }
    return out;
  }

  async changePrice(providerSubscriptionId: string, priceId: string) {
    const sub = await this.stripe().subscriptions.retrieve(providerSubscriptionId);
    const item = sub.items.data[0];
    if (!item) throw badRequest("That subscription has no items to change");
    await this.stripe().subscriptions.update(providerSubscriptionId, {
      items: [{ id: item.id, price: priceId }],
      // Invoice the prorated difference now instead of on the next renewal (up to a year away on annual
      // plans), and only switch the price once that invoice is paid (docs/GAP_PLAN.md §0.10). A downgrade
      // produces a credit on the same invoice.
      proration_behavior: "always_invoice",
      payment_behavior: "pending_if_incomplete",
      cancel_at_period_end: false,
    });
  }

  async findLiveSubscription(providerCustomerId: string) {
    const list = await this.stripe().subscriptions.list({ customer: providerCustomerId, status: "all", limit: 20 });
    const live = list.data.find((s) => ["active", "trialing", "past_due", "incomplete", "paused", "unpaid"].includes(s.status));
    return live?.id ?? null;
  }

  async setCancelAtPeriodEnd(providerSubscriptionId: string, cancel: boolean) {
    await this.stripe().subscriptions.update(providerSubscriptionId, { cancel_at_period_end: cancel });
  }

  async fetchSubscription(providerSubscriptionId: string) {
    const sub = await this.stripe().subscriptions.retrieve(providerSubscriptionId);
    return normalizeStripeSubscription(sub as unknown as StripeSubLike);
  }

  async customerForCharge(providerChargeId: string) {
    const charge = await this.stripe().charges.retrieve(providerChargeId);
    return idOf(charge.customer);
  }

  async fetchPrice(priceId: string): Promise<ProviderPrice> {
    const price = await this.stripe().prices.retrieve(priceId);
    return {
      id: price.id,
      active: price.active,
      amountCents: typeof price.unit_amount === "number" ? price.unit_amount : null,
      currency: price.currency.toUpperCase(),
      interval: price.recurring?.interval ?? null,
      intervalCount: price.recurring?.interval_count ?? 1,
    };
  }
}
