import type { BillingInterval, SubscriptionStatus } from "@growthdesk/shared";

/*
 * Payment providers sit behind this interface so no provider is hardcoded
 * through the app. Stripe is the first implementation; a regional gateway
 * (Paddle, Lemon Squeezy, SSLCommerz, Razorpay…) is another class that maps
 * its own webhook payloads onto NormalizedEvent.
 *
 * The rule every implementation follows: a subscription changes state only
 * from a signature-verified provider event (or a verified API read during
 * reconciliation). A browser returning from checkout proves nothing.
 */

export type NormalizedSubscription = {
  providerSubscriptionId: string;
  providerCustomerId: string;
  status: SubscriptionStatus;
  /** The provider price id; mapped to a plan through Plan.providerPrices. */
  priceId: string;
  interval: BillingInterval;
  /**
   * What the provider charges per `interval` (unit amount × quantity, in the
   * smallest currency unit), or null when it cannot be read as one flat
   * amount (tiered/metered prices). Discounts are not applied.
   */
  priceCents: number | null;
  /** Upper-case ISO currency of priceCents; null when priceCents is null. */
  priceCurrency: string | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  trialEndsAt: Date | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: Date | null;
  /** Our billing account id, when the provider echoes back the metadata we set. */
  billingAccountId: string | null;
};

export type NormalizedInvoice = {
  providerInvoiceId: string;
  providerCustomerId: string;
  providerSubscriptionId: string | null;
  number: string;
  status: string;
  currency: string;
  amountDueCents: number;
  amountPaidCents: number;
  hostedUrl: string;
  pdfUrl: string;
  periodStart: Date | null;
  periodEnd: Date | null;
  issuedAt: Date;
  paidAt: Date | null;
  billingAccountId: string | null;
};

/** A refund or a dispute (chargeback) on a payment. */
export type NormalizedCharge = {
  kind: "refund" | "dispute";
  providerChargeId: string;
  /** Null for a dispute, whose payload names only the charge: resolve it with customerForCharge. */
  providerCustomerId: string | null;
  /** Refunded or disputed amount, in the smallest currency unit. */
  amountCents: number;
  /** Upper-case ISO currency. */
  currency: string;
  /** refund: true when the whole charge was refunded. */
  fullRefund: boolean;
  /** dispute: the card network's reason (e.g. "fraudulent"). */
  reason: string;
  billingAccountId: string | null;
};

export type NormalizedEvent = {
  id: string;
  type: string;
  createdAt: Date;
  /** checkout.completed: links a provider customer to our account. */
  checkout?: { billingAccountId: string; providerCustomerId: string; providerSubscriptionId: string | null };
  subscription?: NormalizedSubscription;
  invoice?: NormalizedInvoice;
  paymentFailed?: boolean;
  /** The invoice's payment needs the customer to confirm it (SCA / 3-D Secure) on the hosted invoice page. */
  actionRequired?: boolean;
  /** The provider has given up collecting the invoice (dunning exhausted). */
  uncollectible?: boolean;
  charge?: NormalizedCharge;
  raw: unknown;
};

export interface PaymentProvider {
  readonly id: string;
  readonly label: string;
  isConfigured(): boolean;
  createCheckout(input: {
    billingAccountId: string;
    priceId: string;
    customerEmail: string;
    providerCustomerId: string | null;
    trialDays: number;
    successUrl: string;
    cancelUrl: string;
  }): Promise<{ url: string }>;
  createPortal(input: { providerCustomerId: string; returnUrl: string }): Promise<{ url: string }>;
  /** Verifies the signature and normalises. Throws on a bad signature. */
  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): NormalizedEvent;
  /**
   * Moves a live subscription to another price. An upgrade must be paid before
   * it takes effect: the provider invoices the difference now and keeps the
   * old price until that payment succeeds.
   */
  changePrice(providerSubscriptionId: string, priceId: string): Promise<void>;
  /** The customer's subscription that is still billing (or about to), if any. */
  findLiveSubscription(providerCustomerId: string): Promise<string | null>;
  setCancelAtPeriodEnd(providerSubscriptionId: string, cancel: boolean): Promise<void>;
  fetchSubscription(providerSubscriptionId: string): Promise<NormalizedSubscription>;
  /** The customer a charge belongs to (disputes name only the charge). */
  customerForCharge(providerChargeId: string): Promise<string | null>;
  /**
   * Reads a recurring price, to check a plan's price id when the plan is saved:
   * its amount per interval, currency and interval. Throws when it does not exist.
   */
  fetchPrice(priceId: string): Promise<ProviderPrice>;
}

export type ProviderPrice = {
  id: string;
  active: boolean;
  /** Smallest currency unit per `interval`; null for tiered or metered prices. */
  amountCents: number | null;
  /** Upper-case ISO currency. */
  currency: string;
  interval: string | null;
  intervalCount: number;
};

export const PAYMENT_PROVIDERS = Symbol("PAYMENT_PROVIDERS");
