# Growthdesk — Product Plan

Growthdesk is one workspace for the whole revenue journey:

- **Outreach.** Cold and warm outbound from connected mailboxes, plus WhatsApp, Telegram and calls.
- **Marketing.** Klaviyo-style email marketing to opted-in audiences: campaigns, flows, segments and forms.
- **Sales.** Deals, meetings, tasks and the inbox where replies land.

All three sit on one shared CRM, automation engine, analytics layer and billing model.

This document covers everything that exists today and everything planned. Status markers:
**✅ Built**, **🆕 Planned**, **🔁 Change to existing**.

---

## 1. Ground rules (non-negotiable)

These rules shape every section below. Code must enforce them; documentation alone is not enough.

| # | Rule | Why |
|---|---|---|
| R1 | **Outreach and marketing never share sending infrastructure.** Outreach sends only through connected mailboxes on *secondary* domains (e.g. `trybrand.com`). Marketing sends only through an ESP on a *subdomain of the main domain* (e.g. `news.brand.com`). Neither path falls back to the other. | Cold email damages domain reputation, and ESPs (SES, SendGrid, Postmark, Klaviyo) ban cold sending. One bad outreach week must never land newsletters in spam. |
| R2 | **Marketing goes only to contacts with recorded consent** (`consentStatus = granted`, with source and timestamp). A cold lead is never added to a marketing list automatically. | GDPR, CAN-SPAM, CASL, and the Gmail/Yahoo bulk-sender rules. |
| R3 | **Hard bounces, spam complaints and "do not contact" suppress across both engines.** An unsubscribe is scoped to the engine it came from: unsubscribing from marketing does not stop a 1:1 sales reply thread, and vice versa. Each suppression scope is explicit. | Respect recipients without breaking legitimate sales conversations. |
| R4 | **Every marketing email carries one-click unsubscribe** (RFC 8058 `List-Unsubscribe` + `List-Unsubscribe-Post`), a visible footer link and the sender's postal address. | Required for bulk senders by Gmail and Yahoo (2024 rules) and by CAN-SPAM. |
| R5 | **Deliverability guardrails stop sending automatically.** A sending domain or campaign pauses when its complaint rate exceeds 0.3% or its hard-bounce rate exceeds 2%. | Protects the customer's reputation and the platform's ESP account. |
| R6 | Existing architecture conventions still apply: tenant isolation, a transactional outbox for events, idempotent jobs, server-side plan limits, no invented data (see ARCHITECTURE.md). | Consistency. |

---

## 2. Feature map by category

### 2.1 Platform & account

| Feature | Status | Notes |
|---|---|---|
| Email/password + Google/Microsoft sign-in, sessions, password reset | ✅ | `auth/` |
| Workspaces, members, invitations, roles & custom permissions | ✅ | `workspaces/`, `shared/permissions.ts` |
| Billing accounts, plans, subscriptions, invoices, usage counters | ✅ | `billing/`, see BILLING.md |
| Platform admin: users, workspaces, plans, logs, support cases, support access | ✅ | `/admin` |
| Audit log | ✅ | |
| Notifications (bell + email) | ✅ | |
| Brand rename to Growthdesk | ✅ | Packages `@growthdesk/*`, cookies `gd_*`, API keys `gd_…`, webhook header `X-Growthdesk-Signature` |
| Marketing plan limits & features | 🆕 | See §5 |
| Company profile: legal name, postal address, default from-name and reply-to | ✅ | Settings → Company profile. Needed for marketing footers (R4). |

### 2.2 CRM & data (shared by all engines)

| Feature | Status | Notes |
|---|---|---|
| Contacts, companies, identifiers, sources | ✅ | |
| Tags, custom fields, saved views, filters | ✅ | |
| CSV import, duplicate detection and merge | ✅ | |
| Notes, activity timeline | ✅ | |
| Suppression list (email / domain / phone) | ✅ | |
| Consent fields on contact (`consentStatus`, `consentSource`, `consentAt`) | ✅ | Data exists; nothing in marketing reads it yet |
| Suppression **scope**: `all` / `outreach` / `marketing` | ✅ | Implements R3. Outreach unsubscribes now write `outreach`. Rows from before the split stay `all`. |
| Consent history (every grant/revoke with source, IP, form, timestamp) | ✅ | `ConsentEvent` + `ConsentService.setIn`. Shown as a "Marketing consent" card on the contact page. |
| Customer events timeline (opened, clicked, ordered, viewed product…) | 🆕 | Shown on the contact page next to the activity timeline |
| Marketing profile properties (lifetime value, last order, predicted next order) | 🆕 | Phase 3 |

### 2.3 Outreach engine

| Feature | Status | Notes |
|---|---|---|
| Mailboxes: SMTP/IMAP, Gmail OAuth, Microsoft OAuth | ✅ | Daily limit, min delay, signature |
| Templates with versions | ✅ | |
| Sequences: email, wait, branch, call task, WhatsApp, Telegram, field update, assign, task, notify | ✅ | |
| Campaigns: audience, schedule window, daily new limit, stop on reply/meeting, multi-mailbox rotation | ✅ | |
| Open/click tracking, one-click unsubscribe | ✅ | |
| Platform outreach kill switch | ✅ | |
| Mailbox health dashboard (bounce rate, reply rate, sends vs cap per mailbox) | 🆕 | |
| Domain setup checker for outreach domains (SPF, DKIM, DMARC, MX) | 🆕 | Shared DNS checker with §2.4 |
| Mailbox warm-up schedule (ramping daily limit) | 🆕 | Ramp the cap only. No warm-up network. |
| Guard: block connecting a mailbox whose domain is a registered marketing sending domain | 🆕 | Implements R1 |
| "Request opt-in" step / action | 🆕 | Hands interested leads over to marketing (see §3) |

### 2.4 Marketing engine (new, Klaviyo-style)

**Sending infrastructure**

| Feature | Status | Notes |
|---|---|---|
| Sending domains: add `news.brand.com`, show DNS records, verify SPF/DKIM/DMARC, track status | 🆕 | `SendingDomain` |
| ESP connection, Amazon SES first | 🆕 | `EspProvider` interface (like `PaymentProvider`). Postmark, Resend and SendGrid adapters later. |
| Bounce and complaint webhooks (SES via SNS) → suppression | 🆕 | Feeds R3 and R5 |
| Sending-domain warm-up (daily volume ramp for new domains) | 🆕 | |
| Guardrail auto-pause (R5) | 🆕 | |

**Audience**

| Feature | Status | Notes |
|---|---|---|
| Lists (static) with membership status `subscribed / unsubscribed / pending` | 🆕 | `List`, `ListMembership` |
| Segments (dynamic): profile fields, tags, list membership, engagement, events, deal stage | 🆕 | Reuses the CRM filter engine. Evaluated at send time. |
| Double opt-in (per list setting) | 🆕 | |
| Preference center (choose lists or unsubscribe from all marketing) | 🆕 | Extends the existing `/unsubscribe/[token]` page |
| Sunset policy (suppress contacts unengaged for 90/180 days) | 🆕 | Phase 2 |

**Content**

| Feature | Status | Notes |
|---|---|---|
| Drag-and-drop email designer (blocks: text, image, button, columns, divider, social, footer, product) | 🆕 | Stored as block JSON and compiled to responsive HTML (MJML) |
| Saved designs & starter templates | 🆕 | |
| Personalisation tags & fallbacks | 🔁 | Reuse `shared/personalisation` |
| Image library | 🆕 | Needs object storage (S3-compatible) |
| Preview: desktop/mobile, test send, dark-mode preview | 🆕 | |

**Campaigns (one-off broadcasts)**

| Feature | Status | Notes |
|---|---|---|
| Campaign builder: audience (lists + segments, with exclusions), design, subject, preheader, from | 🆕 | `MarketingCampaign` |
| Send now / schedule / send in recipient's time zone | 🆕 | Reuse `shared` time-zone windows |
| A/B test: subject or content, winner by open/click after N hours | 🆕 | Phase 2 |
| Smart sending (skip anyone emailed in the last X hours) | 🆕 | |

**Flows (automated journeys)**

| Feature | Status | Notes |
|---|---|---|
| Flow builder: trigger → time delay → conditional split → email/action | 🆕 | `Flow`, `FlowStep`, `FlowEnrollment`. Reuses the sequence engine where possible. |
| Triggers: joined list, form submitted, tag added, field changed, custom event, date property (birthday), order placed, checkout started | 🆕 | Built on the existing `DomainEvent` outbox |
| Prebuilt flows: Welcome series, Re-engagement, Post-purchase, Abandoned cart, Browse abandonment, Win-back | 🆕 | Ecommerce flows in Phase 3 |
| Flow exit conditions & re-entry rules | 🆕 | |

**Forms & capture**

| Feature | Status | Notes |
|---|---|---|
| Signup forms: embedded, popup, flyout, hosted page | 🆕 | `SignupForm`, `FormSubmission` |
| Embed script (one `<script>` tag) | 🆕 | Public, rate-limited endpoint |
| Consent capture on submit (writes `ConsentEvent`) | 🆕 | R2 |
| Spam protection (honeypot + rate limit, optional CAPTCHA) | 🆕 | |

**Ecommerce & events (Klaviyo's core strength)**

| Feature | Status | Notes |
|---|---|---|
| Track API: `POST /v1/track` (custom events) and `identify` | 🆕 | API-key scoped. JS snippet for websites. |
| Shopify integration: customers, orders, products, checkouts | 🆕 | Phase 3 |
| WooCommerce integration | 🆕 | Phase 3+ |
| Product catalog & product blocks in emails | 🆕 | |
| Revenue attribution (order within X days of an open/click) | 🆕 | Per campaign and per flow |

### 2.5 Sales

| Feature | Status | Notes |
|---|---|---|
| Pipelines & stages, deals, stage history | ✅ | |
| Meetings | ✅ | |
| Tasks (incl. from conversations) | ✅ | |
| Calling (Twilio), call scripts | ✅ | |

### 2.6 Inbox & conversations

| Feature | Status | Notes |
|---|---|---|
| Unified inbox: email (IMAP sync), WhatsApp, Telegram | ✅ | |
| Conversation notes, assign, compose | ✅ | |
| Marketing replies: route replies to marketing emails into the inbox (optional reply-to mailbox) | 🆕 | Off by default |

### 2.7 Automation & AI

| Feature | Status | Notes |
|---|---|---|
| Workflows: event triggers, conditions, actions, run history | ✅ | |
| Outgoing webhooks with signed deliveries | ✅ | |
| AI assistant (drafts, prompts, cache, credit metering) | ✅ | |
| New workflow triggers: `marketing.subscribed`, `marketing.unsubscribed`, `form.submitted`, `order.placed`, `email.clicked` | 🆕 | |
| New workflow actions: add to list, remove from list, request opt-in, start flow | 🆕 | |
| AI for marketing: subject-line variants, email copy from brief, natural-language segment builder | 🆕 | Uses existing AI credits |
| Send-time optimisation | 🆕 | Phase 4 |

### 2.8 Analytics

| Feature | Status | Notes |
|---|---|---|
| Outreach reports: sends, replies, positive replies, bounces, team performance | ✅ | |
| Marketing campaign report: delivered, opens (MPP-adjusted), clicks, unsubscribes, complaints, revenue | 🆕 | |
| Flow report: per-step conversion and revenue | 🆕 | |
| List growth: subscribers gained and lost, by source/form | 🆕 | |
| Deliverability dashboard: per sending domain and per mailbox | 🆕 | Covers both engines, clearly separated |
| Revenue dashboard: attributed revenue by channel (outreach deals vs marketing orders) | 🆕 | Phase 3 |

### 2.9 Developers & integrations

| Feature | Status | Notes |
|---|---|---|
| Workspace API keys (`gd_…`) with scopes | ✅ | |
| Lead ingest API (Business OS) with idempotency | ✅ | |
| Outgoing webhooks | ✅ | |
| Track / identify API | 🆕 | §2.4 |
| Lists & subscription API (subscribe, unsubscribe, get status) | 🆕 | |
| Store integrations (Shopify, WooCommerce) | 🆕 | |

### 2.10 Compliance & trust

| Feature | Status | Notes |
|---|---|---|
| Unsubscribe page, one-click unsubscribe headers | ✅ | |
| Suppression list | ✅ | |
| Consent record & proof export | 🆕 | |
| Postal address in every marketing footer | 🆕 | |
| Contact data export / erase (GDPR requests) | 🆕 | |
| Acceptable-use enforcement: platform admin can pause any workspace's marketing sending | 🆕 | Mirrors the outreach kill switch |

---

## 3. Outreach → Marketing handoff

How a cold lead becomes a marketing subscriber without breaking R2:

```
Cold lead (consent: unknown)
   │  outreach sequence (mailbox on trybrand.com)
   ▼
Positive reply / meeting booked / demo done
   │  "Request opt-in" step or workflow action
   ▼
Opt-in email with confirm link  ──► confirmed ──► consent: granted (ConsentEvent logged)
                                                   │
                                                   ▼
                                     Added to list → marketing flows (news.brand.com)
```

Other entry points into marketing: signup forms, store checkout opt-in, an import with a consent source column (the importer must confirm consent and enter its source), and the subscribe API.

---

## 4. Data model additions

New models (all tenant-owned with a non-null `workspaceId`):

| Model | Purpose |
|---|---|
| `SendingDomain` | Domain, DNS records, verification status, warm-up stage, health metrics |
| `EspConnection` | Provider (`ses`, later `postmark`/`resend`/`sendgrid`), sealed credentials, region, status |
| `ConsentEvent` | Contact, action (`granted`/`revoked`), source, IP, user agent, form/list, timestamp |
| `List` / `ListMembership` | Static lists. Membership status `subscribed`/`unsubscribed`/`pending` with timestamps. |
| `Segment` | Saved dynamic filter definition and cached count |
| `EmailDesign` | Block JSON, compiled HTML, plain-text version, thumbnail |
| `MarketingCampaign` | Audience (include/exclude lists and segments), design, subject variants, schedule, stats |
| `MarketingSend` | One row per recipient per campaign/flow email: status, ESP message id, timestamps |
| `Flow` / `FlowStep` / `FlowEnrollment` | Journey definition, steps graph, per-contact progress |
| `SignupForm` / `FormSubmission` | Form config/design and submissions |
| `CustomerEvent` | Track API and store events (`name`, `properties`, `value`, `occurredAt`) |
| `StoreIntegration`, `Product`, `Order` | Ecommerce sync (Phase 3) |

Changes to existing models:

- `Suppression`: add `scope` (`all` | `outreach` | `marketing`).
- `UsageCounter`: add metered key `marketingEmails`.
- `DomainEvent`: new event types (§2.7).
- `Workspace`: postal address and default marketing from-name and reply-to.

---

## 5. Plans & billing additions

New limits, set per plan in Platform admin like the existing ones:

| Limit key | Meaning |
|---|---|
| `marketingContacts` | Contacts that are subscribed to at least one list. This is the Klaviyo-style pricing axis. |
| `monthlyMarketingEmails` | Marketing emails per UTC month (metered, advisory-locked like `monthlyEmails`) |
| `sendingDomains` | Verified marketing sending domains |
| `signupForms` | Active signup forms |

New feature flags: `marketing`, `marketingFlows`, `abTesting`, `signupForms`, `ecommerce`, `trackApi`.

Outreach limits (`mailboxes`, `monthlyEmails`, `activeCampaigns`) stay separate, so each engine can be priced on its own or bundled.

---

## 6. Navigation (target)

Sidebar:

```
Home · Inbox · Tasks
CRM          Contacts · Companies · Lists & segments 🆕 · Imports
Outreach     Campaigns · Sequences · Templates
Marketing 🆕  Campaigns · Flows · Signup forms · Email designs
Sales        Deals · Meetings · Calls
Automate     Workflows
Insights     Reports (Outreach · Marketing 🆕 · Deliverability 🆕 · Revenue 🆕)
Settings
```

Settings:

```
Workspace     General · Company profile 🆕 · Members · Roles & permissions · Plan & billing
Outreach      Mailboxes · WhatsApp & Telegram · Calling
Marketing 🆕   Sending domains · ESP connection · Subscription & consent · Preference center
Data          Pipelines · Tags · Custom fields · Suppression list
Integrations  Store integrations 🆕
Developers    API keys · Webhooks · Track API 🆕
Security      Audit log · Support access
```

The old Settings "Channels" group becomes "Outreach", so sending setup for each engine lives in its own group (R1 shows up in the UI too).

---

## 7. Roadmap

### Phase 0: Rebrand ✅
Rename to Growthdesk across code, docs, packages, cookies, API key prefix, webhook headers and infrastructure names.

### Phase 1: Marketing foundation (MVP)
Goal: send a compliant newsletter to a consented list from a verified subdomain.
- ✅ Suppression scopes (R3), consent history, company profile/postal address
- ✅ Sending domains + DNS verification, SES connection, bounce/complaint webhooks *(API; UI in progress)*
- ✅ Lists, list membership, subscribe/unsubscribe, preference center *(API; UI in progress)*
- ◐ Basic email designer (text, image, button, divider, footer) + test send *(block model, renderer and API done; editor UI in progress)*
- ✅ Marketing campaigns: audience from lists, send now/schedule, tracking, one-click unsubscribe *(API)*
- ✅ Guardrail auto-pause (R5), marketing usage metering, plan limits and feature flags
- ◐ Marketing campaign report *(stats and recipients API done; UI in progress)*

**Done when:** an e2e test sends a campaign to a list through a stubbed SES provider; suppressed, unconsented and outreach-unsubscribed-but-marketing-subscribed contacts are handled per R2/R3; a simulated complaint suppresses the contact and counts toward auto-pause; no code path sends marketing through a `Mailbox` or outreach through an ESP.

### Phase 2: Automation & growth
- Dynamic segments
- Flow builder + Welcome series and Re-engagement templates
- Signup forms (embed, popup, hosted) + double opt-in
- "Request opt-in" outreach step / workflow action (§3)
- A/B subject testing, smart sending, recipient-time-zone sending
- Sunset policy, list growth report, flow report, deliverability dashboard
- Outreach mailbox health + DNS checker + warm-up ramp

### Phase 3: Ecommerce (Klaviyo parity)
- Track/identify API + website JS snippet
- Shopify integration (customers, orders, products, checkouts)
- Abandoned cart, browse abandonment, post-purchase, win-back flows
- Product blocks, revenue attribution, revenue dashboard
- Customer lifetime value and order properties on profiles

### Phase 4: Advanced
- AI: subject variants, copy from brief, natural-language segments, send-time optimisation
- More ESP adapters (Postmark, Resend, SendGrid), WooCommerce
- SMS channel for marketing
- BIMI support, dedicated IP option

---

## 8. Open decisions

| Decision | Recommendation |
|---|---|
| First ESP | **Amazon SES**: lowest cost per email, mature bounce/complaint webhooks |
| Marketing contacts: same `Contact` table or separate profiles? | **Same table.** One person, one record, with consent and list membership on top. Keeps the outreach → marketing handoff simple. |
| "Campaigns" appears under both Outreach and Marketing | Keep both, distinguished by sidebar group and URL (`/campaigns` vs `/marketing/campaigns`). Reports label them "Outreach campaigns" and "Email campaigns". |
| Email designer: build or embed? | Build on MJML with our own block editor. Embedded editors (Unlayer, Beefree) add per-seat cost and lock-in. |
| Object storage for images | S3-compatible (AWS S3 / Cloudflare R2 / MinIO in dev) |
| Pricing axis for marketing | `marketingContacts` tiers (like Klaviyo), with email volume as a secondary cap |
