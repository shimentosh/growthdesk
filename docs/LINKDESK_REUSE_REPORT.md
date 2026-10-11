# LinkDesk reuse report

**Source:** `../linkdesk` (git `25c3401`), read-only. LinkDesk was not modified. Growthdesk has its
own codebase, database, auth, billing and deployment, and needs no LinkDesk process at runtime.

**How the audit was done:** five parallel source-level reviews (email, campaigns/jobs, chat/AI,
auth/tenancy/billing, UI), followed by reading the specific files that were ported.

**Key technical difference:** LinkDesk uses **Drizzle** with a hand-built Postgres job queue. Growthdesk
uses **Prisma 7 + BullMQ** (as the spec requires). Ported code therefore keeps LinkDesk's logic and
rewrites its data access. Pure functions were ported almost verbatim, with their tests.

## Summary

| Feature | What LinkDesk has (from the code) | Action in Growthdesk |
|---|---|---|
| Email sending | nodemailer, one pooled transport per mailbox (`mailbox.service.ts`); `classifySmtpError` → deferred / rejected / unknown (`send-outcome.ts`); deterministic Message-ID on inbox sends; daily caps | **Adapted** → `apps/api/src/messaging/smtp.ts` and `outbound-email.service.ts`. Changes: credential fingerprint in the pool key; XOAUTH2; atomic per-mailbox day counter; plan allowance metering; write-ahead row for every send |
| Mailbox integrations | SMTP+IMAP with app password only. `connections.service.ts` lists Google/Outlook, but **no OAuth code exists** | **Adapted** (SMTP/IMAP probe, SSRF guard, verify-before-store) **+ built** (Gmail / Microsoft 365 OAuth with XOAUTH2, `messaging/mailbox-auth.service.ts`, `mailboxes/`) |
| Domain DNS checks | `domain-auth.ts`: pure SPF/DKIM/DMARC/MX checker | **Reused** (ported into `mailboxes/`) |
| Email inbox / receiving | IMAP polling with IDLE trigger (`inbound.service.ts`); reply matching on In-Reply-To/References; heuristic bounce detection; auto-reply detection (`spam.service.ts`); global (cross-tenant) Message-ID uniqueness | **Adapted**: sync loop, `answersTo`, `isAutoReply`. **Fixed**: dedupe scoped per workspace (LinkDesk's global unique index dropped a second tenant's copy); UIDVALIDITY handling added; real DSN parsing replaces "first email address in the body" bounce attribution |
| Conversation threading | `threads` / `messages` tables shared by email and chat | **Adapted** into `Conversation` / `Message` with `externalKey` unique per workspace (LinkDesk had no unique key on chat peer, so concurrent first messages could open two threads) |
| Open/click tracking | HMAC-signed stateless tokens; click URL is inside the signature (no open redirect) — `tracking.ts` | **Reused** → `messaging/tracking.ts` (key derived per purpose). Opens are labelled a weak signal everywhere |
| Unsubscribe | **Not implemented** (no link, no `List-Unsubscribe`; `contacts.unsubscribed_at` never written) | **Built**: signed unsubscribe links, RFC 8058 one-click headers, suppression list, enrollment stop |
| Campaign engine | `outreach.service.ts`: per-recipient state, write-ahead duplicate-send guard, pure flow functions (`nextPosition`, `branchPosition`, `waitBefore`, `threadOf`, `evaluate`) with unit tests | **Reused** (flow functions + tests → `packages/shared/src/flow.ts`, `test/flow.test.ts`) and **adapted** (engine on BullMQ). **Fixed** defects found in review: queued sends still went out after Pause; a duplicate job could send the *next* step; recipients stuck "sending" forever; one 550 disconnected the whole mailbox; app clock used in job claims |
| Send windows / time zones | `nextOpening` used the **server's** local clock; the schedule's time zone was stored but ignored | **Adapted** → `packages/shared/src/schedule.ts`, resolves wall-clock time in the campaign's zone via Intl, DST-safe (tested) |
| Templates / personalisation | `{{token}}` renderer; unresolved tokens left visible; validation only client-side | **Adapted** → `personalize.ts` + fallbacks (`{{first_name\|there}}`), custom-field tokens, server-side missing/unknown checks before every send |
| WhatsApp | Official Meta Cloud API via fetch; HMAC webhook verification; 24h window check; text only; no templates; no delivery statuses; no opt-out; owner lookup decrypted every integration per webhook | **Adapted**: signature check and window logic. **Built**: templates, delivery statuses, STOP opt-out, indexed `(provider, externalId)` routing |
| Telegram | Automates a **personal account** through an unofficial MTProto client (teleproto) — ToS / ban risk; cannot start conversations | **Not reused.** **Built** on the official Bot API (webhook or polling), with capability checks: a bot can only message people who started it |
| CRM / contacts | Contacts tied to link-building vendors/websites; no companies-as-CRM, no dedupe across sources | **Built** (contacts, companies, identifiers-based dedupe, merge, tags, custom fields, saved views, import/export) |
| Background jobs | Postgres `jobs` table, `FOR UPDATE SKIP LOCKED`, dedupe keys, LISTEN/NOTIFY doorbell, backoff | **Semantics ported, code not**: BullMQ job ids for dedupe, exponential backoff, durable state in Postgres with SKIP LOCKED claims for due enrollments, transactional outbox for events |
| Auth | scrypt passwords; opaque session tokens stored as SHA-256; AES-256-GCM sealing; per-email lockout; TOTP | **Reused** `crypto.ts` (adds constant-time behaviour for unknown emails — LinkDesk returned early, leaking account existence by timing). **Adapted** sessions (not pinned to one workspace, so a user can work in several). Lockout keyed on email **and** IP (LinkDesk let anyone lock out any account). **Added** sign-up email verification (LinkDesk had none) and optional Google sign-in |
| Roles & permissions | Permission catalogue + `roleTrouble` validation; custom roles | **Mechanism reused**, catalogue rewritten for Growthdesk; five fixed roles with per-workspace overrides |
| Plans & entitlements | Plans as rows; limits enforced server-side at several call sites; **no payment provider**; customers could **self-assign any paid plan without paying** | **Adapted** (`EntitlementsService`). **Built**: provider-agnostic billing with Stripe adapter, signed webhooks, idempotent event log, out-of-order protection, grace periods, metered allowances |
| Platform admin | Users page, suspension (account-wide), audit (filed under the admin's own org) | **Adapted**: separate `/admin` API with support/admin/owner ranks; admin actions audited under the customer's workspace; support access only via time-boxed owner grants |
| API errors / envelope | `ApiError`, exception filter, `{data}` envelope | **Reused** (`common/errors.ts`, `exception.filter.ts`, `envelope.interceptor.ts`) |
| Next → API proxy | Route handler forwarding `/api/*` to a loopback API (cookies first-party, no CORS) | **Reused** in `apps/web/src/app/api/[...path]/route.ts` |
| UI | Design tokens in CSS variables (light/dark), inline-style components, custom store | **Tokens reused** (mapped to Tailwind v4). Components rebuilt in Tailwind; LinkDesk's store and page components are domain-coupled and were not reused |
| AI | Provider adapter table (Anthropic/OpenAI/…) via fetch; credit ledger; link-building prompts | **Adapters adapted**; prompts rewritten for sales; caching and per-workspace metering added |
| Calling | None | **Built** (manual logging + Twilio click-to-call bridge) |
| Pipeline / deals, tasks, automation, analytics | LinkDesk's "deals" are price negotiations for link placements | **Built** |

## Files ported or adapted (by origin)

| LinkDesk source | Growthdesk destination |
|---|---|
| `packages/db/src/crypto.ts` | `apps/api/src/common/crypto.ts` |
| `packages/domain/src/errors.ts` | `apps/api/src/common/errors.ts` |
| `apps/api/src/common/api-exception.filter.ts`, `envelope.interceptor.ts` | `apps/api/src/common/exception.filter.ts`, `envelope.interceptor.ts` |
| `packages/domain/src/auth/context.ts` (`clientIpFrom`) | `apps/api/src/common/context.ts` |
| `packages/domain/src/auth/permissions.ts` (mechanism) | `packages/shared/src/permissions.ts` |
| `packages/domain/src/services/entitlements.ts`, `plan.service.ts` | `apps/api/src/billing/entitlements.service.ts` |
| `packages/domain/src/services/outreach.service.ts` (flow functions) + `tests/flow.test.ts` | `packages/shared/src/flow.ts` + `test/flow.test.ts` |
| `outreach.service.ts` (`nextOpening`, `renderTokens`) | `packages/shared/src/schedule.ts`, `personalize.ts` |
| `mailbox.service.ts`, `send-outcome.ts` | `apps/api/src/messaging/smtp.ts`, `outbound-email.service.ts` |
| `tracking.ts`, `packages/core/src/lib/mail-html.ts` | `apps/api/src/messaging/tracking.ts`, `mail-html.ts` |
| `inbound.service.ts`, `spam.service.ts` (`isAutoReply`), `mailboxes/domain-auth.ts` | `apps/api/src/mailboxes/` |
| `whatsapp.service.ts`, `chat-inbound.service.ts` | `apps/api/src/channels/` |
| `ai.service.ts` (provider table) | `apps/api/src/ai/` |
| `packages/http/src/proxy.ts`, `packages/core/src/lib/api.ts`, `globals.css` tokens | `apps/web/` |

## Not reused, and why

- Link-building domain code (vendors, websites, orders, placements, negotiation, site metrics, Clientdesk).
- LinkDesk's Postgres job queue and runner — replaced by BullMQ; its guarantees were re-implemented.
- Telegram MTProto user-account automation — ToS risk; replaced by the Bot API.
- The monolithic UI store and page components — coupled to LinkDesk's data model.
- Manual "Due" invoices and self-serve plan switching without payment.
