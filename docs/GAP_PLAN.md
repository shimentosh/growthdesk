# Growthdesk — Gap Audit & Fix Plan

Audit date: 2026-10-11. Five read-only audits covered security, billing, the outreach engine, web UX and production readiness. Every finding was checked against the code; `file:line` references point at the tree as it was on that day. Paths are relative to `apps/api/src` unless they start with `apps/`, `packages/` or `infra/`.

Severity:
- **P0**: blocks launch. It loses data or money, lets an attacker in, or stops the app deploying.
- **P1**: fix before paying customers rely on it.
- **P2**: fix soon after launch.
- **P3**: polish.

Status: ☐ open · ◐ in progress · ☑ done.

**Sprint 1 progress (2026-10-11):**
- ☑ 0.1 and 0.2 were verified by building both images. The migrate command ran against a scratch database (5 migrations, 4 plans), and the web image served `/login`.
- ◐ 0.3: the nightly `backup` service, restore script and docs are in, and a restore drill matched row counts. Off-host sync and PITR (WAL archiving) still need setting up on the server.
- ☑ 0.4: hops default to 1, the docs cover each proxy setup, and a lockout per account across all IP addresses was added (test).
- ☑ 0.5: squatted unverified accounts lose their password, sessions and links when Google links (tests).
- ☑ 0.7: `patchOf()` is used on every PATCH body. Custom-field options were also being wiped and are fixed (tests).
- ◐ 0.13: `.github/workflows/ci.yml` (typecheck, unit, e2e with Postgres, Redis and GreenMail, audit, images) and Dependabot are in, and actionlint is clean. The repository still needs its first commit.
- ☑ 6.3: `.dockerignore` keeps secrets and host builds out of the image, and the base images are pinned by digest.
- ☑ 2.1: the `next` redirect rejects control characters and backslashes, and requires the same origin.
- ☑ Extra: the audit found that mailparser bundled nodemailer 10.0.1, which has two DoS advisories on parsing inbound addresses. It is now overridden to 10.0.16.

**Sprint 2 progress (2026-10-11):**
- ☑ 0.9: every subscription event applies Stripe's current state, re-read under a row lock. A test sends two events in the same second, out of order.
- ☑ 0.8: an event for a second subscription is not applied (audited as `billing.duplicate_subscription`) until Stripe reports the live one ended. Checkout reuses a live subscription instead of opening a new session (tests).
- ☑ 0.10: price changes use `always_invoice` + `pending_if_incomplete`. This can't be exercised without real Stripe, so check it once in Stripe test mode.
- ☑ 0.11: campaign WhatsApp and Telegram steps wait on the kill switch, restricted access and the plan feature. Inbox chat replies need the plan feature (test).
- ☑ 3.1.1: a `payment_failed` for an already-paid invoice, or for another subscription, is ignored. The failure email states the real days left (test).
- ☑ 3.1.2: the portal Growthdesk opens has plan switching off, and `assertFits` covers every counted limit (test).
- ☑ 3.2: hourly notices (trial ending, grace ending, sending paused), each sent once, plus "payment received" and an **Update payment** button on the read-only banner (tests).
- Not done from §3.1: tax/VAT (3.1.3) and the medium items 3.1.4–3.1.11.

---

## 1. Launch blockers (P0)

| # | Area | Problem | Where | Fix |
|---|---|---|---|---|
| ☑ 0.1 | Deploy | The web image cannot build: it copies `apps/web/public`, which does not exist. | `infra/Dockerfile.web:24` | Add `apps/web/public/.gitkeep`, or drop the COPY. |
| ☑ 0.2 | Deploy | The migrate container has no Prisma CLI. `prisma` is a devDependency, `pnpm deploy --prod` drops it, and compose then runs `npx prisma` (unpinned download, or a failure). The whole stack waits on `migrate`. | `infra/Dockerfile.api:20`, `docker-compose.prod.yml:62` | Move `prisma` to dependencies pinned at 7.10.0. Call `node_modules/.bin/prisma`. |
| ◐ 0.3 | Data | No backups, restore drill or point-in-time recovery. Everything sits in one Docker volume on one host. | `docs/DEPLOYMENT.md:5` | Nightly `pg_dump` plus WAL archiving (pgBackRest or wal-g) to off-host storage, a written restore drill, and `ENCRYPTION_KEY` escrow. |
| ☑ 0.4 | Security | Client IP is spoofable, or shared by all users. With `TRUSTED_PROXY_HOPS=2` and a proxy that appends X-Forwarded-For (nginx), an attacker picks their own IP and bypasses login throttling and lockout (brute force). With a proxy that replaces it (Caddy), everyone shares the web container's IP: 11 logins a minute block sign-in for the whole platform. | `docker-compose.prod.yml:13`, `common/context.ts:63-70`, `apps/web/src/app/api/[...path]/route.ts:67-68` | Default to 1 hop, document the right value for each proxy, and add a lockout keyed on the email address. |
| ☑ 0.5 | Security | Account pre-hijack through Google sign-in. An attacker registers the victim's email with their own password. When the victim later uses "Sign in with Google", the accounts link, the attacker's password and session keep working, and the attacker sees everything. | `auth/auth.service.ts:239-253` | When linking to an account whose email was never verified, clear `passwordHash` and revoke every session. |
| ☐ 0.6 | Outreach | Closing a shared SMTP pool marks queued emails "uncertain" (never retried), then follow-ups go out as "Re:" to emails the prospect never got. One 550 or an hourly OAuth refresh triggers it. | `messaging/smtp.ts:73,114`, `outbound-email.service.ts:260`, `engine.service.ts:600-601` | Retire the pool and let it drain instead of closing it. Classify "pool closed" as deferred. |
| ☑ 0.7 | Data integrity | Toggling a workflow on or off wipes its conditions and approval step. In zod 4, `.partial()` still applies `.default()`. The same bug resets task `type` to "custom" on every task edit, and re-enables a disabled webhook on any webhook edit. | `automation/automation.controller.ts:12-13`, `packages/shared/src/schemas.ts:345,579,581,612`, `pipeline/pipeline.controller.ts:160` | Add a shared `patchOf()` helper that strips defaults, and use it for every PATCH schema. Add a test that a partial update keeps untouched fields. |
| ☑ 0.8 | Billing | Two checkouts (two tabs or a double click) create two Stripe subscriptions, and events from either one overwrite the single local row. Cancelling one drops the account to Free while the other keeps charging. | `billing/billing.service.ts:150,323-364` | Ignore events for a subscription that is not the current one. Refuse checkout while a live subscription or open session exists. |
| ☑ 0.9 | Billing | Events arriving in the same second can leave a paying customer restricted for up to 24 hours. The ordering check uses one-second timestamps and no lock. | `billing/billing.service.ts:329` | On every event, re-fetch the subscription from Stripe and apply that, under a row lock. |
| ☑ 0.10 | Billing | Upgrades are granted with no payment. The proration lands on the next invoice, up to 12 months away on annual plans. | `billing/providers/stripe.provider.ts:204` | Use `proration_behavior: "always_invoice"` with `payment_behavior: "pending_if_incomplete"`. |
| ☑ 0.11 | Billing | WhatsApp and Telegram keep sending after a trial ends, a downgrade, a restriction for non-payment, or the platform kill switch. | `campaigns/engine.service.ts:635-665`, `channels/channels.service.ts:474-502` | Check the plan feature, full access and `outreachEnabled` before every chat send. |
| ☐ 0.12 | Legal | There are no terms, privacy policy or signup consent, and no way to delete an account or workspace (GDPR erasure). | `apps/web/src/app/page.tsx`, `workspaces.controller.ts`, `admin.service.ts` | Legal pages and a consent line on signup now. Deletion flows in §3.4. |
| ◐ 0.13 | Ops | No CI and no commits: nothing gates a broken build, and there is no rollback point. | repo root | Commit. Add a GitHub Actions workflow: typecheck, unit tests, e2e against Postgres and Redis service containers, `docker build`, and dependency audit. |

---

## 2. Security

| # | Sev | Problem | Where | Fix |
|---|---|---|---|---|
| ☑ 2.1 | P1 | Open redirect after login: `?next=/%09/evil.com` passes the check, and the browser strips the tab. | `apps/web/src/app/(auth)/safe-next.ts:4` | Reject control characters, and require the same origin via `new URL`. |
| ☐ 2.2 | P1 | API keys and webhooks outlive the person who made them. A removed admin keeps full API access. | `workspaces.service.ts:285-306`, `admin/admin.service.ts:205-212`, `common/access.guard.ts:163-190` | Revoke their keys when a member is removed or a user disabled. Flag their webhooks for review. |
| ☐ 2.3 | P2 | Login and registration CSRF: a cross-site form can sign a victim into the attacker's account. | `common/access.guard.ts:88`, `app.setup.ts:13` | Check Origin on unsafe public auth routes, or require JSON there. |
| ☐ 2.4 | P2 | The viewer role can read the audit log (IP addresses and user agents of every member). | `packages/shared/src/permissions.ts:200` | Remove `audit.read` from viewer. |
| ☐ 2.5 | P2 | A company owner can be any user UUID from any tenant, and their name then shows up in responses. | `crm/companies.service.ts:113,149` | Check workspace membership, as contacts and deals already do. |
| ☐ 2.6 | P2 | Registration reveals whether an account exists (409). | `auth/auth.service.ts:42` | Return a generic answer and send an email instead. |
| ☐ 2.7 | P2 | No Content-Security-Policy. Swagger UI is public in production. | `apps/web/next.config.ts`, `app.setup.ts:27-28` | Add a strict CSP. Turn Swagger UI off in production. |
| ☐ 2.8 | P2 | A password reset or change leaves the user's other reset links valid. The OAuth state cookie lacks `Secure`. | `auth/auth.service.ts:128-148`, `auth/auth.controller.ts:164` | Burn all reset tokens on reset or change. Set `Secure`. |
| ☐ 2.9 | P3 | A signed click link redirects to any site, so it can be used for phishing. | `messaging/tracking.ts:42-47` | Show an interstitial page for unknown domains, or rate-limit and monitor. |
| ☐ 2.10 | P3 | The SMTP send path does not re-check the host against DNS rebinding (IMAP does). | `mailboxes/net-guard.ts:22-25` | Pin the resolved IP. |
| ☐ 2.11 | P2 | `ENCRYPTION_KEY` cannot be rotated: sealed values carry no key id. | `common/crypto.ts:74-106` | Add a key-version prefix and a re-seal job. |
| ☐ 2.12 | P1 | No 2FA for accounts. | — | Add TOTP with recovery codes, and allow a workspace to require it. |
| ☑ 2.13 | — | `ConsentEvent` was missing from the tenant guard list. | `prisma/tenant-guard.ts` | Fixed during the marketing work. |

**Already solid:** scrypt passwords and hashed tokens; HttpOnly, SameSite session cookies; signed OAuth state; tenant guard with tests; `@Permission` on every route; parameterised SQL; AES-GCM secrets that are never returned; an SSRF guard on outgoing webhooks; signed Stripe, Twilio, WhatsApp and Telegram webhooks; sanitised inbound HTML; CSV export protected from formula injection; non-root containers.

---

## 3. Billing, plans and account lifecycle

### 3.1 Correctness
| # | Sev | Problem | Where | Fix |
|---|---|---|---|---|
| ☑ 3.1.1 | P1 | A late `invoice.payment_failed` overrides a successful payment. The account goes past due and gets a "payment failed" email after paying. | `billing/billing.service.ts:368-385` | Skip the event if the invoice is paid, or older than the last applied event. Otherwise re-fetch. |
| ☑ 3.1.2 | P1 | Plan changes made in the Stripe portal skip the downgrade check. `assertFits` ignores contacts, campaigns and channels. | `billing/billing.service.ts:119-127` | Turn off plan switching in the portal, or enforce limits after the webhook. |
| ☐ 3.1.3 | P1 | No tax or VAT handling, and billing details never reach Stripe. The UI's "Shown on invoices" is false. | `billing/providers/stripe.provider.ts:122-135`, `billing.service.ts:111`, `apps/web/src/components/admin/BillingSettings.tsx:450` | Stripe Tax, tax ID collection, `customers.update` and `taxIds.create`. |
| ☐ 3.1.4 | P2 | The seat limit can be bypassed by resending an expired invitation, and accepting an invite does not re-check seats. | `workspaces/workspaces.service.ts:251-262,347` | Run `assertCapacity("seats")` on resend and on join. |
| ☐ 3.1.5 | P2 | Contact limit races in imports and the ingest API: parallel requests overshoot. | `integrations/lead-ingest.service.ts:96`, `crm/imports.service.ts:178` | Take a per-account advisory lock, as `consume()` does. |
| ☐ 3.1.6 | P2 | Admin-assigned plans never expire, and they keep stale Stripe ids. | `billing/entitlements.service.ts:98`, `billing.service.ts:403` | Lapse at `currentPeriodEnd`. Clear provider ids on manual assignment. |
| ☐ 3.1.7 | P2 | The price shown is not the price charged: Stripe price ids are never checked. | `apps/web/src/components/admin/BillingSettings.tsx:203` | `prices.retrieve` when a plan is saved, copying amount and currency. |
| ☐ 3.1.8 | P2 | A workspace admin in an agency sees the whole account's invoices, usage and tax ID. | `packages/shared/src/permissions.ts:140`, `billing.service.ts:76-108` | Limit billing read to billing-account owners, or scope the response. |
| ☐ 3.1.9 | P2 | Unlimited 14-day Starter trials, one per email, with no card. Plus-addresses are not normalised. | `workspaces.service.ts:87-101`, `core/platform-settings.service.ts:31` | Normalise emails, rate-limit signups per domain or IP, and offer an optional card-required trial. |
| ☐ 3.1.10 | P2 | Unhandled Stripe events: SCA `payment_action_required`, refunds, disputes, `marked_uncollectible`. | `billing/` | Handle them and email the customer for SCA. |
| ☐ 3.1.11 | P3 | A failed send refunds the wrong month across a month boundary. Meters reset on the UTC calendar month. Hidden plans can be bought by key. Resume on a canceled subscription returns a 500. | `outbound-email.service.ts:270`, `billing.service.ts:142` | Small fixes. |

### 3.2 Dunning and notices (missing)
☑ Trial-ending reminder · ☑ grace-period-ending warning · ☑ "service restricted" notice · ☑ "payment recovered" confirmation · ☑ a **Pay now** button on the read-only banner, plus routing 423 errors to billing (`apps/web/src/app/w/[workspaceId]/layout.tsx:73-78`).

### 3.3 Admin finance (missing)
☐ MRR and revenue view · ☐ refunds, credits and coupons on our side · ☐ re-sync a subscription or replay a webhook · ☐ plan versioning (editing a plan currently changes it for every subscriber at once).

### 3.4 Lifecycle and GDPR (missing)
☐ Delete a workspace (soft delete, then a purge job) · ☐ close an account · ☐ transfer ownership (today the owner can neither leave nor be removed) · ☐ full workspace data export · ☐ per-contact erasure and export (the GDPR data-subject request) · ☐ admin delete for users and workspaces · ☐ privacy policy, DPA, records of processing, incident runbook.

---

## 4. Outreach engine

| # | Sev | Problem | Where | Fix |
|---|---|---|---|---|
| ☐ 4.1 | P1 | A reply that quotes the unsubscribe footer ("Yes, Thursday works" plus the quoted email) is treated as an opt-out. | `mailboxes/inbound-parse.ts:296-299` | Strip quoted text and signatures before matching. |
| ☐ 4.2 | P1 | Newsletters and notification emails become contacts, "replies", tasks and AI-credit spend. Connecting a busy Gmail can use up the contact limit and fire `contact.created` workflows. | `mailboxes/inbound-parse.ts:110-119`, `inbound-email.service.ts:325,368-416` | Treat `Precedence: bulk`, `List-Id`, `List-Unsubscribe` and no-reply senders as machine mail. Only create contacts for threads we started. |
| ☑ 4.3 | P1 | Editing a paused campaign's steps re-sends or skips steps, because enrollment positions are not remapped. | `campaigns/campaigns.service.ts:103,362`, `sequences.service.ts:45-49` | Key enrollments to step ids, or block structural edits once anyone is enrolled. **Done:** structural edits are blocked once anyone is enrolled (409, `structureChange`); content, timing and steps added at the end are applied in place, keeping step ids. Chosen over step-id keys because the engine and branch lanes address steps by number, and a deleted current step has no safe remap (tests). |
| ☐ 4.4 | P1 | A WhatsApp or Telegram send with an unknown outcome is retried, so up to 3 duplicates. | `channels/channels.service.ts:606-608`, `engine.service.ts:672-673` | Add an "uncertain" chat result, as email has. |
| ☐ 4.5 | P1 | A mailbox failing mid-campaign silently stalls everything. No notification is sent, and follow-ups reschedule every hour forever. | `outbound-email.service.ts:259-261`, `mailboxes.processors.ts:114` | Notify on every transition to error. Don't flip status on a single transient failure. |
| ☐ 4.6 | P1 | Concurrent jobs break per-mailbox pacing, sending bursts of about 10 emails at once. | `campaigns/engine.service.ts:538-549` | Reserve an atomic next-send slot (`UPDATE … RETURNING`). |
| ◐ 4.7 | P2 | `dailyNewLimit` collapses weekends onto Monday and stacks overflow. | `campaigns/enrollment.service.ts:137-140` | Enforce new starts per local day at claim time. **Done:** starts are planned per real local day (`planStarts`), counting waiting starts and today's first steps, and resume re-plans starts that fell due during a pause (tests). **Remains:** an engine reschedule of a not-yet-started enrollment (mailbox full, plan, kill switch) can still roll it onto a day already at its quota. A claim-time check in `engine.service.ts` (outside this scope) would close that. |
| ☐ 4.8 | P2 | The daily cap resets at UTC midnight, allowing up to twice the cap in some time zones. | `outbound-email.service.ts:88-99` | Key the counter on the local day. |
| ☐ 4.9 | P2 | One IMAP ingest error loses that reply for good, so stop-on-reply never fires. | `mailboxes/imap-sync.service.ts:138-146` | Hold the pointer at the failure, and skip only after N attempts. |
| ☐ 4.10 | P2 | Stop-on-reply can silently not work: IMAP turned off, only INBOX scanned, sync errors not surfaced. | `campaigns.service.ts:456-476`, `imap-sync.service.ts:64-71` | Warn or block at launch, pause when sync is stale, scan Junk too. |
| ☐ 4.11 | P2 | A synchronous 550 is not recorded as a bounce, so the dead address is enrolled again later. | `campaigns/engine.service.ts:603-605` | Route 5.1.x rejections through bounce recording. |
| ☐ 4.12 | P2 | Engine failures leave no trace. `removeOnFail` is on and there is no failed-job listener, so a failing step is re-claimed forever. | `campaigns/engine.service.ts:176` | Count errors, keep failed jobs, and alert. |
| ◐ 4.13 | P3 | Inbox reply has no idempotency key. Overnight windows (22:00–06:00) are treated as always open. Tracking runs on the shared app domain. | `inbox/inbox.service.ts:373`, `packages/shared/src/schedule.ts:109`, `messaging/tracking.ts:72` | Small fixes, plus a custom tracking domain. **Overnight windows done:** a window opens on its listed day and closes the next morning (tests). |
| ☐ 4.14 | P1 | The Gmail OAuth scope is restricted and needs Google's CASA security assessment before production. | `messaging/mailbox-auth.service.ts:21` | Start the assessment early, or narrow the scope. |

**Missing vs competitors (Instantly, Lemlist, Apollo), by impact:**
1. Warm-up ramp and an inbox health dashboard.
2. Email verification before sending.
3. Sending in the recipient's time zone.
4. A/B testing of steps, and spintax.
5. CRM sync (HubSpot, Salesforce, Pipedrive) and a Zapier app.
6. Booking links.
7. Pause on out-of-office until the return date, and stop when a colleague at the same company replies.
8. Custom tracking domain, per-recipient-domain throttling, and saving to Sent for custom SMTP.

---

## 5. Web app and user flows

| # | Sev | Problem | Where | Fix |
|---|---|---|---|---|
| ☐ 5.1 | P0 | No landing page, pricing, legal pages, or error and 404 pages. Next's bare screen shows on a crash. | `apps/web/src/app/page.tsx:10-24` | Add a public route group (home, pricing from `GET /plans`, terms, privacy) plus `error.tsx`, `not-found.tsx` and `global-error.tsx`. |
| ☐ 5.2 | P1 | Inbox reply → deal is a dead end: there is no "New deal" or "Link to deal" from a conversation or contact. | `apps/web/src/components/inbox/ConversationPane.tsx:247-258` | Add the actions with the contact prefilled. |
| ☐ 5.3 | P1 | Unsaved campaign edits are lost when switching tabs. | `apps/web/src/components/ui/Tabs.tsx:29`, `campaigns/[campaignId]/page.tsx:117-137` | Keep dirty tabs mounted, or confirm before leaving. |
| ☐ 5.4 | P1 | No bulk "Add to campaign" from contacts. | `apps/web/src/components/crm/BulkActionsBar.tsx:18` | Add a bulk action that calls `POST /campaigns/:id/enroll`. |
| ☐ 5.5 | P2 | Google sign-in is built but has no button, and its errors are never shown. | `auth/auth.controller.ts:35,159`, `apps/web/src/app/(auth)/login/page.tsx:7-9` | Add the button and show `?error=`. |
| ☐ 5.6 | P2 | Mailbox OAuth failures land on `/` with the error dropped, or show raw JSON. | `mailboxes/mailbox-oauth.service.ts:112-116` | Redirect to the mailboxes settings page with `?error=`. |
| ☑ 5.7 | P2 | Launch readiness lists problems with no "Fix" links, and Launch stays enabled. | `apps/web/src/components/campaigns/CampaignActions.tsx:101-130` | Add per-field links, and disable Launch while problems remain. **Done:** each readiness problem carries `fix: { label, href }` (campaign tab, mailbox settings or billing), shown as a link. The confirm button stays disabled until a fresh check has no problems (e2e on the API shape). |
| ☐ 5.8 | P2 | Caches go stale after edits: analytics is never invalidated, plus mailbox→readiness, inbox→task summary, Twilio→calls setup, and the onboarding checklist. | see audit | Fix the query-key invalidation. |
| ☐ 5.9 | P2 | Unsaved-changes guards miss sidebar navigation (workflows, templates). | `automation/[workflowId]/page.tsx:77`, `templates/[templateId]/page.tsx:68-73` | Add a router-level guard. |
| ☐ 5.10 | P2 | Maintenance mode is invisible. "Contact support" leads nowhere. A second workspace hitting the limit shows bare text. | `common/access.guard.ts:108`, `apps/web/src/app/onboarding/CreateWorkspace.tsx:47-52` | Banner, support form or address, and an upgrade prompt. |
| ☐ 5.11 | P3 | Smaller issues: /login while signed in shows the form, the post-checkout poll never ends, template previews can arrive out of order, archive can't be undone, SMTP host can't be edited, meeting buttons can be double-clicked, reports show zeros with no empty state, and the inbox only polls (no live updates). | see audit | Small fixes. |

**Missing account features:** ☐ 2FA · ☐ change email · ☐ personal notification preferences · ☐ personal data export · ☐ delete account · ☐ link or unlink Google.

**Already solid:** the API client and error envelope, 402 upgrade dialogs, loading, empty and error states, double-submit guards, optimistic rollbacks, every auth flow, invitations, the workspace switcher, the billing UI, the import wizard, and the admin operations tools.

---

## 6. Production operations

| # | Sev | Problem | Fix |
|---|---|---|---|
| ☐ 6.1 | P1 | Almost no observability. Logs are plain text, the request id is never logged, 500s go to stdout only, failed jobs vanish, and the worker and web containers have no healthcheck. | JSON logs with an `x-request-id` header, Sentry in api, worker and web, alerts on failed jobs, a queue dashboard, a worker heartbeat in `/health`, and uptime checks. |
| ☐ 6.2 | P1 | Growing tables are never pruned: DomainEvent, MessageEvent, WorkflowRun, StepExecution, Activity, AiUsage, BillingEvent and MarketingSend. A cross-tenant `domainEvent` query runs every 5 minutes with no index (`tasks.service.ts:262`). | Retention jobs, an index on `(type, subjectId)`, and an overdue flag on Task. |
| ☑ 6.3 | P1 | No `.dockerignore`, so host `node_modules`, `.next` and **`apps/api/.env` (secrets)** are copied into the build stage. The base image tag floats. | Add `.dockerignore`, and pin images by digest. |
| ☐ 6.4 | P2 | Deploys cause downtime and cannot be rolled back. Migrations are not online-safe (no `CONCURRENTLY`, backfill runs in the transaction). | Build images in CI with tags, roll with health gating, and write expand/contract migration rules. |
| ☐ 6.5 | P2 | Platform emails (verify, reset) are sent inline with no retry, and failures are swallowed. There is no SPF/DKIM guidance for `MAIL_FROM`. | Send through a queue with retries, and document DNS. |
| ☐ 6.6 | P2 | A 15 MB CSV is parsed synchronously on the event loop. Exports build 100k rows in memory. The 20 MB body limit applies to every route. | Streaming parser, file upload instead of a JSON body, background exports, and a per-route body limit. |
| ☐ 6.7 | P2 | Compose has no log rotation, `stop_grace_period`, memory limits or `shm_size`. | Add them. |
| ☐ 6.8 | P2 | Connection pooling caps the deployment at about 5–6 processes. | Add PgBouncer, or tune `max_connections`. |
| ☐ 6.9 | P3 | `/health` is public, unthrottled, and opens a Redis connection per call. Cleanup deletes have no indexes and are unbatched. | Small fixes. |

---

## 7. Testing

| # | Sev | Gap | Fix |
|---|---|---|---|
| ☐ 7.1 | P1 | `automation/` (1,851 lines, including the SSRF guard) has zero tests. | Add e2e tests for dispatch, conditions, actions, webhooks and the SSRF guard. |
| ☐ 7.2 | P1 | The web app has zero tests: Playwright is installed with no config and the `e2e/` folder is empty. | Playwright smoke tests: signup → verify → workspace → mailbox → import → campaign launch → inbox reply → deal; billing return; admin. |
| ☐ 7.3 | P2 | No unit specs for auth, billing, crm, campaigns, messaging, workspaces or admin. Untested: Google sign-in, mailbox OAuth, channels beyond the inbox, notifications, multi-step sequences. | Fill these, worst first. |
| ☐ 7.4 | P2 | No lint config. | Add ESLint or Biome to CI. |

---

## 8. Email marketing (new module, in progress)

See `docs/PRODUCT_PLAN.md` §7 for the roadmap. Phase 1 status:
- ☑ Suppression scopes, consent history, company profile.
- ☑ API: lists, sending domains and email service (SES or any SMTP relay), designs, campaigns, the sending worker, tracking, the preference page, the bounce and complaint webhook (SES/SNS or a generic format), guardrails, and plan limits. Covered by `test/marketing-engine.e2e-spec.ts` (17 tests), the renderer's unit tests, and a live send through Mailpit.
- ◐ Marketing UI: sidebar group, lists, campaigns, designer, sending domains, preference page. Being built in a parallel session.

Lessons from this audit that the module follows:
- PATCH schemas carry no defaults (§0.7).
- Its job failures are logged (§4.12).
- Its tracking links and preference page use separately keyed tokens.
- `MarketingSend` needs a retention policy (§6.2).

---

## 9. Suggested order of work

1. **Sprint 1, make it deployable and safe:** 0.1, 0.2, 0.3, 0.4, 0.5, 0.7, 0.13, 6.3, 2.1.
2. **Sprint 2, money correctness:** 0.8, 0.9, 0.10, 0.11, 3.1.1, 3.1.2, 3.2 (Pay now and dunning).
3. **Sprint 3, sending reliability:** 0.6, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.12, 6.1.
4. **Sprint 4, launch surface:** 5.1 and 0.12 (public site, legal pages, error pages), 3.1.3 (tax), 2.12 (2FA), 5.2, 5.3, 5.4.
5. **Sprint 5, compliance and lifecycle:** 3.4 (deletion, transfer, export, erasure), 2.2, 6.2, 6.4.
6. **Then:** the rest of P2, test coverage (§7), competitor features (§4), and marketing phases 2–3.
