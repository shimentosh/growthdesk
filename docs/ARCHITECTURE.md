# Growthdesk — Architecture & Conventions

Growthdesk is a standalone multi-tenant SaaS for outbound sales: contacts/CRM, multichannel
sequences, unified inbox, calling, pipeline, tasks, automation, AI assistance, analytics and
subscription billing. It shares no runtime, database or deployment with LinkDesk or Business OS.

## Layout

```
apps/api        NestJS 12 REST API (src/main.ts) and background worker (src/worker.ts), Prisma 7 + PostgreSQL 18, BullMQ + Redis
apps/web        Next.js 16 App Router + React 19 + Tailwind 4: customer workspace (/w/:workspaceId/...); /admin redirects to apps/admin
apps/admin      Next.js 16 operator console for platform staff (ADMIN_APP_URL): users, workspaces, billing, email, settings
packages/shared Zod input schemas, enums, permission catalogue, plan keys, personalisation, sequence flow + time-zone windows (pure, tested)
docs/           This file, LinkDesk reuse report, billing policy, deployment, privacy operations, Business OS API
```

Why one API package with two entrypoints instead of `apps/worker`: the worker needs every domain
service; splitting would mean extracting a domain package for no runtime benefit. The worker is still a
separate process (`node dist/worker.js`) so sending and IMAP sync never share the HTTP event loop.

Why the operator console is its own app (`apps/admin`): it runs on its own host with its own sign-in, so
staff tooling never ships in the customer bundle. Every admin endpoint is still authorised server-side by
platform role (`@Platform()`), independent of workspace roles.

## Request pipeline (apps/api)

1. `AppThrottlerGuard` — Redis-backed rate limits (global 600/min/IP; auth endpoints 10/min/IP).
2. `AccessGuard` (src/common/access.guard.ts):
   - API key (`Authorization: Bearer gd_…`) on routes marked `@ApiKeyScope(scope)`, else the `gd_session` cookie.
   - Cookie-authenticated writes must come from an allowed `Origin` (CSRF defence, on top of SameSite=Lax).
   - `@Platform(min)` routes check the user's platform role.
   - Maintenance mode refuses writes for non-admins.
   - Routes with `:workspaceId` load the caller's membership **from the path id + session user** (never from
     a client-supplied claim); non-members get **404**. Then the workspace's two-factor requirement
     (403 `two_factor_required`), workspace suspension (`@AllowSuspended()` opts out) and `@Permission(...)` (any-of).
   - Sign-in with two-factor on is two steps: password or Google creates a short-lived `TwoFactorChallenge`
     (HttpOnly `gd_2fa` cookie); `POST /auth/2fa/verify` with a TOTP or recovery code starts the session.
3. `EnvelopeInterceptor` — success bodies are `{ data }` (`@Raw()` opts out).
4. `ApiExceptionFilter` — errors are `{ error: { code, message, fields?, details? } }`. Plan limits are
   HTTP 402 `plan_limit` with `details: { limit|feature, used, allowed, plan }`.

Handlers receive `@Ctx() ctx: RequestContext`; `ws(ctx)` is the workspace context
(`id, role, permissions, billingAccountId, timezone, currency`), `me(ctx)` the signed-in identity,
`actorId(ctx)` the acting user id (null for API keys), `ownershipScope(ctx)` the record filter for roles
without `records.view_all`.

Bodies/queries are validated with shared Zod schemas: `@Body(Schema)` / `@Query(Schema)` from
`src/common/decorators.ts` (NOT Nest's `@Body`).

## Tenant isolation

- Every tenant-owned table has a non-null `workspaceId`.
- `PrismaService.db` is wrapped by a **tenant guard** (src/prisma/tenant-guard.ts): any query on a tenant model
  without `workspaceId` in its top-level `where` (or in `data` for creates) throws before reaching Postgres.
  Use `where: { id, workspaceId }` for single-row reads/updates (Prisma accepts non-unique fields in unique wheres).
- `PrismaService.unscoped` bypasses the guard. Only for: webhook routing (find the integration by its key),
  platform admin, schedulers that discover due work across tenants. Comment why at the call site.
- Background jobs always carry `workspaceId` and re-scope every query with it.
- Isolation is covered by e2e tests (`test/*.e2e-spec.ts`).

## Billing & entitlements

`EntitlementsService` (src/billing/entitlements.service.ts) is the only place limits are decided:
`assertCapacity(billingAccountId, limitKey, n)`, `assertFeature(billingAccountId, featureKey)`,
`assertFullAccess(billingAccountId, what)`, `consume(...)` for metered allowances (`monthlyEmails`,
`monthlyAiCredits`, advisory-locked; returns the metering period, which a refund must use).
`assertCapacityIn(tx, …)` checks a counted limit inside the creating transaction under the same kind of
per-account advisory lock (contacts use it, so parallel imports cannot overshoot), and `assertSeat(…, email)`
checks a seat for one person (invite, resend, accept). Limits are summed over the billing account's workspaces.
Policy for lapsed subscriptions: see docs/BILLING.md. Payment providers implement
`PaymentProvider` (src/billing/providers); subscriptions change state only from verified webhooks.

## Events, activity, notifications

- `EventsService.emitIn(tx, …)` writes a `DomainEvent` inside the same transaction as the change
  (transactional outbox); call `events.kick()` after commit. The worker's dispatcher fans events out to
  workflows, outgoing webhooks and notifications. Event types: `contact.created`, `contact.updated`,
  `contact.qualified`, `lead.imported`, `reply.received`, `message.bounced`, `contact.unsubscribed`,
  `deal.created`, `deal.stage_changed`, `deal.won`, `deal.lost`, `meeting.booked`, `call.completed`,
  `task.overdue`, `campaign.completed`.
- `ActivityService.log(...)` writes the contact/company/deal timeline.
- `NotificationsService.notify(workspaceId, userIds, {type,title,body,link,email?})` — bell + optional email.
- `AuditService.record(ctx, {action, ...})` — security/admin audit trail.

## Messaging contracts

- **Email out:** `OutboundEmailService.send(input)` (src/messaging) is the only email send path. Write-ahead
  `Message` row with deterministic `Message-ID <messageRowId@domain>`; suppression re-check; mailbox daily cap
  (`MailboxDailyCount`, atomic); plan allowance; returns `sent | deferred | failed | uncertain | blocked`.
  Pass the same `messageRowId` on retry — it never double-sends. `kind: "campaign"` obeys the platform outreach
  kill switch and account restrictions.
- **Chat out:** `ChatSender` (src/channels/chat-sender.ts), provided as `CHAT_SENDER` by `ChannelsModule`; returns
  `sent | failed | uncertain | unavailable | blocked`. Like email, `uncertain` (may have been delivered) is never retried.
- **Credentials:** `MailboxAuthService` gives SMTP/IMAP auth (sealed password or refreshed OAuth token).
- Secrets are sealed with AES-256-GCM (`seal`/`open`, src/common/crypto.ts); never returned to clients.

## Background jobs

BullMQ queues (src/queues/queues.ts): `engine, mail, chat, events, automation, webhooks, imports, ai, maintenance,
marketing, platform-mail, platform-marketing, lifecycle` (`lifecycle`: workspace exports and the deleted-workspace purge,
docs/PRIVACY_OPS.md).
Each area registers processors in its `*.processors.ts` module (imported only by `WorkerModule`), using
`@Processor(QUEUES.x)` classes extending `WorkerHost`, and registers recurring schedules with
`queue.upsertJobScheduler(...)` in `onModuleInit` — guarded by `config.RUN_WORKERS` so the API process
never schedules. Jobs are idempotent: the database is the source of truth and processors re-check state.
The worker also runs `WorkerOpsModule` (src/worker/worker-ops.module.ts): one failed-job listener for every
queue (logs each failed attempt with queue, job, workspaceId and error; Sentry on the last one) and a heartbeat
in Redis that `/health` reports. Log lines carry the request id via `common/logger.ts`; no call site passes it.

## Conventions

- TypeScript strict, ESM (`.js` import suffixes), Prisma via `this.prisma.db`.
- Services own logic; controllers are thin; DTO mapping functions convert Prisma rows (Decimal → number).
- Never invent data. A capability that needs an unconfigured provider returns a clear 503/409 message.
- Copy in the UI and API messages must be true of the running system.
- Tests: unit (`src/**/*.spec.ts`, `pnpm test`) and API e2e against real Postgres+Redis
  (`test/*.e2e-spec.ts`, `pnpm test:e2e`). Parallel runners use `TEST_DB_NAME=<name> TEST_REDIS_DB=<n>`.
