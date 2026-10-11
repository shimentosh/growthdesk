# Billing, plans and entitlements

## Model

- **BillingAccount** — the paying customer. Created with the first workspace a person creates; that person
  owns it. One subscription per account. An account can hold several workspaces (the plan's `workspaces`
  limit), which is how agencies run client workspaces under one subscription.
- **Plan** — a row edited in Platform admin → Plans: prices (monthly/annual), trial days, limits, features,
  and the provider price ids (e.g. `{ "stripe": { "month": "price_…", "year": "price_…" } }`).
  Seeded plans: Free, Starter, Growth, Agency. **Seeded prices are placeholders** — set real prices in admin.
- **Subscription** — plan, status, interval, provider, provider ids, period, trial end, cancel-at-period-end,
  grace period end.
- **Invoice** — mirrored from the provider (hosted link and PDF).
- **BillingEvent** — every provider webhook, stored with a unique `(provider, providerEventId)`.
- **UsageCounter** — metered usage per workspace per UTC month (`emails`, `ai_credits`).

## Limits (enforced server-side only)

| Limit | Counted as | Enforced at |
|---|---|---|
| contacts | non-deleted contacts across the account | create, CSV import (per row), API ingest (per lead) |
| seats | members + pending invitations (distinct emails) | invitations |
| mailboxes | connected, non-deleted mailboxes | connect (SMTP and OAuth) |
| workspaces | workspaces in the account | creating a workspace |
| monthlyEmails | emails sent this UTC month | every email send (atomic, advisory-locked) |
| monthlyAiCredits | AI calls this month (cache hits are free) | every AI request |
| activeCampaigns | running + scheduled campaigns | launch / resume |
| channelIntegrations | WhatsApp, Telegram, Twilio connections | connect |

`-1` means unlimited. Features (multichannel steps, branching, automation, AI, advanced reporting,
API access, webhooks, calling, WhatsApp, Telegram, custom roles) are checked with `assertFeature`.
A refusal is HTTP **402** with `error.code = "plan_limit"` and `details: { limit|feature, used, allowed, plan }`;
the web app turns it into an upgrade prompt.

## Subscription states and access policy

| State | Access |
|---|---|
| `trialing` (trial not over) / `active` | Full access to the plan |
| `past_due` within the grace period (default 7 days, platform setting) | Full access, with a billing banner |
| `past_due` after grace, `incomplete` | **Restricted**: contacts, pipeline, tasks and inbox stay usable; sending, campaign launch/resume, imports, new mailboxes/integrations and invitations are refused |
| `canceled`, `expired`, trial ended without payment | The **expired plan** (Free by default) applies; nothing is deleted; creating beyond Free's limits is refused until a plan is chosen |

**Data retention:** customer data is never deleted because a subscription lapses. Deletion only happens when a
workspace owner deletes records or asks support to close the account.

## Payments

- Providers implement `PaymentProvider` (`apps/api/src/billing/providers/payment-provider.ts`).
  **Stripe** is implemented (`stripe.provider.ts`): hosted Checkout, Billing Portal, price changes, cancel at
  period end, and subscription fetch (for every webhook and for reconciliation).
- **A plan changes only from a verified provider event.** The browser returning from Checkout changes nothing.
- Webhook endpoint: `POST {PUBLIC_APP_URL}/api/webhooks/billing/stripe`. Signature verified with
  `STRIPE_WEBHOOK_SECRET` over the exact raw body. Handled: `checkout.session.completed`,
  `customer.subscription.created|updated|deleted|paused|resumed`, `invoice.paid|payment_succeeded|finalized|voided|payment_failed`.
- Duplicate deliveries are acknowledged and ignored; a delivery that failed is re-applied.
- **Every subscription event applies Stripe's current state, not the event payload.** The subscription is
  re-read from Stripe under a row lock, so events that arrive out of order (even within the same second)
  cannot roll the state back. If Stripe is unreachable, the webhook answers 500 and Stripe retries.
- **One live subscription per account.** An event for a different subscription than the account's live one
  (a double checkout, or an old subscription) is not applied. It is logged and audited as
  `billing.duplicate_subscription` so an operator can refund it. Only once Stripe reports the live one ended
  does the other replace it. Checkout also refuses to open a second session when the customer already has a
  live subscription at Stripe, and changes that subscription's price instead.
- **Plan changes are paid before they apply.** A price change invoices the prorated difference immediately
  (`always_invoice`), and Stripe keeps the old price until that invoice is paid (`pending_if_incomplete`). A
  downgrade becomes a credit. Plan changes only happen in-app, where the downgrade check
  (`assertFits`: seats, mailboxes, workspaces, contacts, active campaigns, channel connections, sending
  domains, marketing subscribers) runs. The Billing Portal Growthdesk opens has plan switching turned off.
- Payment failure → `past_due` + grace period + email to the billing contact with the real time left. A
  `payment_failed` for an invoice that is already paid, or for another subscription, is ignored.
- **Billing notices** (hourly, each sent once per occasion, tracked in `Subscription.noticesSent`):
  - trial ends within 3 days
  - grace period ends within 24 hours
  - grace has ended and sending is paused
  - payment received after a failure (sent when the subscription returns to active)
- The read-only banner shows **Update payment** to people who can see billing, and tells everyone else to ask
  the account owner.
- Scheduled jobs (trial expiry hourly, reconciliation daily): unpaid trials without a provider subscription → `expired` (owner emailed); reconciliation re-reads
  every provider-managed subscription to correct missed webhooks.
- **Manual / invoiced customers and the operator's own workspace:** Platform admin → Workspaces → Assign plan
  sets a plan with provider `manual` (audited, with a reason). It refuses to override an active Stripe subscription.

## Setting up Stripe

1. Create Products/Prices in Stripe (monthly and annual per paid plan).
2. Enter the price ids on each plan in Platform admin → Plans (`providerPrices.stripe.month/year`).
3. Add a webhook endpoint for the events above; put its signing secret in `STRIPE_WEBHOOK_SECRET`.
4. Set `STRIPE_SECRET_KEY`. Without both keys, checkout is reported as unavailable — never faked.
5. Enable the Customer Portal in Stripe settings. Growthdesk creates its own portal configuration through the
   API (payment methods, billing details, invoices, cancel at period end, **no plan switching**); if Stripe
   refuses it, the account's default portal is used, so also turn off "customers can switch plans" there.
6. Turn on Smart Retries / dunning in Stripe so a failed renewal moves the subscription to `past_due` (which
   starts the grace period here) rather than cancelling it straight away.

Stripe availability depends on the business's country and eligibility — verify before launch. Another
gateway (e.g. Paddle as merchant of record, or a regional provider) is added by implementing `PaymentProvider`
and registering it in `BillingService`.
