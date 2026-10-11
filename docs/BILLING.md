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
- **UsageCounter** — metered usage per workspace per billing month (`emails`, `ai_credits`,
  `marketing_emails`). The month starts on the subscription's billing day (the UTC day of month its current
  period started; the last day of a short month when that day does not exist), not on the 1st. `period`
  holds the month's first day (`YYYY-MM-DD`). A refund for a failed send goes to the period the send was
  counted in.

## Limits (enforced server-side only)

| Limit | Counted as | Enforced at |
|---|---|---|
| contacts | non-deleted contacts across the account | every contact created (manual, CSV import, API ingest), inside its transaction under a per-account advisory lock, so parallel imports cannot overshoot |
| seats | members + unexpired pending invitations (distinct emails) | inviting, resending an invitation, and accepting one (the plan may have shrunk since it was sent) |
| mailboxes | connected, non-deleted mailboxes | connect (SMTP and OAuth) |
| workspaces | workspaces in the account | creating a workspace |
| monthlyEmails | emails sent this billing month | every email send (atomic, advisory-locked) |
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
| `canceled`, `expired`, trial ended without payment, an assigned plan past its end date | The **expired plan** (Free by default) applies; nothing is deleted; creating beyond Free's limits is refused until a plan is chosen |

**Payment events that do not change the state by themselves:**

| Event | What happens |
|---|---|
| `invoice.payment_action_required` (SCA / 3-D Secure) | The billing contact is emailed a link to the hosted invoice, where only they can confirm the payment. If it is not confirmed, the subscription's own events move it to `incomplete` or `past_due`. |
| `charge.refunded` | Audited (`billing.refunded`) and the billing contact is emailed a receipt. Access is unchanged: ending the subscription is a separate decision, made in Stripe, whose event then applies. |
| `charge.dispute.created` | Audited (`billing.dispute_opened`) and the platform's owners and admins are emailed, since only they can answer it in Stripe before its deadline. Access is unchanged; whether to cancel is their call. |
| `invoice.marked_uncollectible` | Stripe has stopped retrying, so the grace period ends now: the subscription's state is applied and a `past_due` account is restricted at once. Audited (`billing.invoice_uncollectible`); the owner gets the "sending is paused" notice. |

**Who sees billing:** a billing account can pay for several workspaces, so invoices, billing details (tax ID,
address, billing email) and usage summed across workspaces go only to the account's owner. Anyone else with
`billing.read` (a workspace admin in an agency's client workspace) sees the plan and that workspace's own usage.

**Trials:** a free trial is granted once per person and only `TRIALS_PER_IP_PER_DAY` times a day (default 3)
from one signup IP. "Once per person" compares a normalised email (lower-case, `+tag` removed, and for
gmail.com/googlemail.com the dots removed): the address used to log in is stored exactly as typed. An account
that gets no trial starts on the expired plan (Free), audited as `billing.trial_withheld`. A card-required
trial is not offered yet.

**Data retention:** customer data is never deleted because a subscription lapses. Deletion only happens when a
workspace owner deletes records or asks support to close the account.

## Payments

- Providers implement `PaymentProvider` (`apps/api/src/billing/providers/payment-provider.ts`).
  **Stripe** is implemented (`stripe.provider.ts`): hosted Checkout, Billing Portal, price changes, cancel at
  period end, and subscription fetch (for every webhook and for reconciliation).
- **A plan changes only from a verified provider event.** The browser returning from Checkout changes nothing.
- Webhook endpoint: `POST {PUBLIC_APP_URL}/api/webhooks/billing/stripe`. Signature verified with
  `STRIPE_WEBHOOK_SECRET` over the exact raw body. Handled: `checkout.session.completed`,
  `customer.subscription.created|updated|deleted|paused|resumed`, `invoice.paid|payment_succeeded|finalized|voided|payment_failed|payment_action_required|marked_uncollectible`,
  `charge.refunded`, `charge.dispute.created`.
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
  sets a plan with provider `manual` (audited, with a reason). It refuses to override an active Stripe subscription,
  and clears the old provider ids so a late event about the previous subscription cannot reach it (an event
  about a live subscription, from a new checkout, does take over). With an end date the plan lapses then:
  entitlements fall back at once, and the hourly job marks it `expired` and emails the owner.
- Only public plans can be bought; a hidden plan can only be renewed by an account already on it. Resuming
  or canceling a subscription that has already ended is refused with a 400.

## Setting up Stripe

1. Create Products/Prices in Stripe (monthly and annual per paid plan).
2. Enter the price ids on each plan in Platform admin → Plans (`providerPrices.stripe.month/year`). Saving
   reads each price from Stripe: it must be active, flat and recurring every 1 month / 1 year, both in one
   currency, and its amount and currency are copied into the plan, so the price shown is the price charged.
   Without `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` the ids are saved unchecked, with a warning.
3. Add a webhook endpoint for the events above (including the invoice and charge events); put its signing
   secret in `STRIPE_WEBHOOK_SECRET`.
4. Set `STRIPE_SECRET_KEY`. Without both keys, checkout is reported as unavailable — never faked.
5. Enable the Customer Portal in Stripe settings. Growthdesk creates its own portal configuration through the
   API (payment methods, billing details, invoices, cancel at period end, **no plan switching**); if Stripe
   refuses it, the account's default portal is used, so also turn off "customers can switch plans" there.
6. Turn on Smart Retries / dunning in Stripe so a failed renewal moves the subscription to `past_due` (which
   starts the grace period here) rather than cancelling it straight away.

Stripe availability depends on the business's country and eligibility — verify before launch. Another
gateway (e.g. Paddle as merchant of record, or a regional provider) is added by implementing `PaymentProvider`
and registering it in `BillingService`.
