# Deployment

Growthdesk ships as a single-host Docker Compose stack (`docker-compose.prod.yml`) built from two
Dockerfiles (`infra/Dockerfile.api`, `infra/Dockerfile.web`). This document describes that setup and the
local development setup (`docker-compose.yml`, `scripts/`). Backups are covered in [Backups](#backups);
CI lives in `.github/workflows/ci.yml`. There is no orchestration beyond Compose.

## Processes

| Service | Image / command | Role |
|---|---|---|
| `postgres` | `postgres:18.6-alpine`, volume `postgres-data` | Primary database (user, password user and database all `growthdesk`). Healthcheck: `pg_isready`. |
| `redis` | `redis:8.8.3-alpine`, `--appendonly yes --maxmemory-policy noeviction`, volume `redis-data` | BullMQ queues and rate-limit counters. `noeviction` is required: an evicted job key is a lost job. |
| `migrate` | `Dockerfile.api`, `npx prisma migrate deploy && node dist/scripts/seed.js` | One-shot: applies migrations, then seeds the plan catalogue. Runs after `postgres` is healthy. |
| `api` | `Dockerfile.api`, default CMD `node --enable-source-maps dist/main.js`, volume `exports-data` | NestJS REST API on `0.0.0.0:3601`, everything under `/v1`. Starts after `migrate` succeeds and `redis` is healthy. |
| `worker` | `Dockerfile.api`, `node --enable-source-maps dist/worker.js`, volume `exports-data` | BullMQ processors and recurring schedules (sequence engine, mailbox sync, event dispatch, reminders, billing upkeep, workspace exports and the deleted-workspace purge). Sets `RUN_WORKERS=true` itself. Same start conditions as `api`. |
| `web` | `Dockerfile.web`, `node apps/web/server.js` (Next.js standalone) | The only published port: `127.0.0.1:3600`. Serves the UI and proxies `/api/*` to the API's `/v1/*` (`API_URL=http://api:3601`). |

How they connect:

```
browser / providers ──https──▶ your reverse proxy ──▶ web :3600 ──/api/* → /v1/*──▶ api :3601 ──▶ postgres, redis
                                                                                    worker ─────▶ postgres, redis
```

- `api`, `worker` and `migrate` share one environment block (`x-api-env` in the compose file).
- The API is not published on the host. Browsers, integrations and provider webhooks all reach it through the
  web app's proxy (`apps/web/src/app/api/[...path]/route.ts`): `/api/auth/me` → `${API_URL}/v1/auth/me`.
  The proxy forwards the request body as the exact bytes received (payment webhooks are verified over them),
  passes `X-Forwarded-For` on unchanged, sets `X-Forwarded-Proto` / `X-Forwarded-Host`, and keeps repeated
  `Set-Cookie` headers intact. If the API is unreachable it answers `502` with `error.code = "api_unreachable"`.
- The worker is a separate process so sending and IMAP sync never share the HTTP event loop; `worker.ts` notes
  that one or more workers can run alongside the API. Rate limits are stored in Redis, so they hold across
  several API instances.
- Postgres and Redis are not published on the host.

## Prerequisites

- Docker with Compose v2 (the file uses `name:` and `depends_on.condition: service_completed_successfully`).
- A TLS-terminating reverse proxy in front of `web` (Caddy, nginx, a cloud load balancer) and a domain for it.
- An SMTP relay for the platform's own mail (verification, password reset, invitations, notifications).
- Optional: Google / Microsoft OAuth clients, a Stripe account, an Anthropic or OpenAI key.

## Configuration

```sh
cp .env.production.example .env.production   # never commit the filled-in copy (.gitignore lists it)
```

`.env.production` is read by Compose for variable substitution only. The containers receive the variables
listed in the compose file's `x-api-env` block; anything else in `.env.production` is ignored.

Generate the encryption key:

```sh
openssl rand -base64 32
```

### Variables in `.env.production`

| Variable | Required | Meaning |
|---|---|---|
| `PUBLIC_APP_URL` | yes | The https origin your reverse proxy serves. Email links, tracking/unsubscribe links, OAuth redirect URIs, Stripe return URLs and provider webhook URLs are built from it. The session cookie is `Secure` when it starts with `https://`. Must be a valid URL or the API refuses to boot. |
| `POSTGRES_PASSWORD` | yes | Password for the `growthdesk` database user. It is interpolated into `DATABASE_URL` as-is, so use URL-safe characters. |
| `ENCRYPTION_KEY` | yes | 32 bytes, base64. Seals mailbox passwords, OAuth tokens and provider secrets (AES-256-GCM), and derives the signing keys for tracking/unsubscribe links, OAuth state and Telegram start links. The API refuses to boot if it does not decode to 32 bytes. |
| `MAIL_FROM` | yes | From address of platform mail, e.g. `Growthdesk <no-reply@example.com>`. Compose passes it without a default. |
| `SMTP_HOST` | yes | SMTP relay host. Compose passes it without a default. |
| `SMTP_PORT` | no | Compose default `587`. |
| `SMTP_SECURE` | no | `true`/`1` for implicit TLS. Compose default `false`. |
| `SMTP_USER`, `SMTP_PASSWORD` | no | SMTP credentials. |
| `TRUSTED_PROXY_HOPS` | no | Compose default `1`. See [Reverse proxy and TLS](#reverse-proxy-and-tls). |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | no | Google sign-in and Gmail mailbox connections. |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` | no | Microsoft 365 mailbox connections. Without a client, the OAuth connect answers 503 and suggests SMTP/IMAP. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | no | Stripe subscriptions. Without both, checkout reports itself unavailable. |
| `AI_PROVIDER` | no | `none` (default), `anthropic` or `openai`. Platform default; the platform admin can override it in settings. |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | no | Key for the chosen provider. |
| `WORKSPACE_PURGE_DAYS` | no | Compose default `30`. Days a deleted workspace can be restored before the purge job erases it. See [docs/PRIVACY_OPS.md](PRIVACY_OPS.md). |
| `DATA_EXPORT_DAYS` | no | Compose default `7`. Days a workspace data export can be downloaded before it is deleted. |

Blank values are treated as unset, so `STRIPE_SECRET_KEY=` disables Stripe rather than configuring an empty secret.

### Values fixed by the compose file

`NODE_ENV=production`, `API_HOST=0.0.0.0`, `API_PORT=3601`,
`DATABASE_URL=postgresql://growthdesk:${POSTGRES_PASSWORD}@postgres:5432/growthdesk`,
`REDIS_URL=redis://redis:6379`, `DATA_EXPORT_DIR=/app/.data/exports` (the `exports-data` volume, mounted in both
`api` and `worker`), and for `web`: `API_URL=http://api:3601`.

### Full API/worker schema (`apps/api/src/config/config.ts`)

Every variable the API and worker validate at boot, with the code's defaults. Variables not in the compose
`x-api-env` block take these defaults in production unless you add them to the compose file.

| Variable | Default | Meaning |
|---|---|---|
| `NODE_ENV` | `development` | `development`, `test` or `production`. HSTS is sent only in `production`. |
| `LOG_LEVEL` | `log` | `debug`, `log`, `warn` or `error` (API process). |
| `API_PORT` | `3601` | HTTP port. |
| `API_HOST` | `127.0.0.1` | Bind address. Loopback by default; browsers reach the API through the web proxy. |
| `PUBLIC_APP_URL` | `http://localhost:3600` | See above. |
| `ALLOWED_ORIGINS` | origin of `PUBLIC_APP_URL` | Comma-separated origins allowed to send cookie-authenticated writes (CSRF check). |
| `TRUSTED_PROXY_HOPS` | `1` | See below. |
| `DATABASE_URL` | — (required) | PostgreSQL connection string. |
| `REDIS_URL` | `redis://127.0.0.1:6386` | Redis connection string. |
| `ENCRYPTION_KEY` | — (required) | See above. |
| `SESSION_DAYS` | `14` | Session lifetime, 1–90 days. |
| `MAIL_FROM` | `Growthdesk <no-reply@growthdesk.local>` | Platform mail sender. |
| `SMTP_HOST` | `127.0.0.1` | |
| `SMTP_PORT` | `1066` | (Mailpit in development.) |
| `SMTP_SECURE` | `false` | |
| `SMTP_USER`, `SMTP_PASSWORD` | unset | |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | unset | |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` | unset | |
| `MICROSOFT_TENANT` | `common` | Tenant segment of the Microsoft authorize/token URLs. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | unset | |
| `AI_PROVIDER` | `none` | |
| `AI_MODEL` | unset | Platform default model; the admin setting takes precedence. |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | unset | |
| `RUN_WORKERS` | `false` | Run BullMQ processors and schedules in this process. `worker.js` sets it; the API does not. |
| `WORKER_CONCURRENCY` | `5` | 1–50. |
| `ALLOW_PRIVATE_MAIL_HOSTS` | `false` | Allows private-network SMTP/IMAP hosts (local test servers). Never enable in production. |
| `WORKSPACE_PURGE_DAYS` | `30` | 1–365. Restore window for a deleted workspace; the hourly purge erases it after that. |
| `DATA_EXPORT_DIR` | `.data/exports` | Where workspace exports are written (relative to the process's working directory). The API (download) and the worker (build) must see the same directory. |
| `DATA_EXPORT_DAYS` | `7` | 1–30. How long an export can be downloaded; the daily cleanup deletes it afterwards. |

Read directly from `process.env` outside the schema:

| Variable | Default | Where |
|---|---|---|
| `RATE_LIMIT_PER_MINUTE` | `600` | Global per-IP API rate limit (`app.module.ts`). |
| `AUTH_RATE_LIMIT` | `10` | Per-minute limit on auth endpoints; exists for tests, production keeps the default. |
| `ALLOW_PRIVATE_WEBHOOKS` | unset | `true` disables the SSRF guard on outgoing webhooks. Development/tests only; never in production. |
| `WHATSAPP_GRAPH_URL`, `TELEGRAM_API_URL`, `TWILIO_API_URL` | provider defaults | Provider API base URLs, overridable for tests. |
| `API_URL` (web) | `http://127.0.0.1:3601` | Where the web app's `/api` proxy and server-side calls forward to. |

## First deploy

```sh
cp .env.production.example .env.production   # then edit it
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
```

Order on start: `postgres` healthy → `migrate` (migrations + plan seed) completes → `api` and `worker` start
(with `redis` healthy) → `web`. Then put the reverse proxy in front of `127.0.0.1:3600`, create the first
platform admin, and configure the external providers you use.

The seed only creates plans whose key does not exist yet; plans edited in Platform admin are never overwritten.
Seeded prices are placeholders (see docs/BILLING.md).

## Reverse proxy and TLS

- `web` is bound to `127.0.0.1:3600` only. Terminate TLS in your proxy and forward everything (pages and
  `/api/*`) to it. `PUBLIC_APP_URL` must be the https origin the proxy serves.
- Forward `X-Forwarded-For` and `X-Forwarded-Proto`. The web proxy passes them on to the API.
- The API accepts JSON bodies up to 20 MB (CSV imports up to 15 MB arrive as JSON); allow request bodies of
  that size in the proxy.
- **`TRUSTED_PROXY_HOPS`** is the number of proxies in front of the API that append to `X-Forwarded-For`.
  The API takes the client address as the entry that many places from the right of that header
  (`clientIpFrom`, `src/common/context.ts`); with `0`, or when the header has fewer entries, it uses the socket
  peer (inside Compose, the `web` container). The client address keys rate limits, sign-in failure tracking,
  sessions and the audit trail. The compose default is `1`: one TLS proxy in front of `web`. Next.js does
  not append to `X-Forwarded-For` (it only sets it when absent) and the `/api` proxy forwards it unchanged, so
  neither counts.
  - nginx (`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for`), Caddy and most load balancers: `1`.
  - A CDN or load balancer in front of that proxy, both appending: `2`.
  - Too high a value lets a client choose its own address with a forged header, which defeats rate limits and
    sign-in lockout. Too low a value makes every user share the proxy's address, so one person's failed
    sign-ins throttle everyone. Check it after deploying: sign in, then look at the IP in Settings → Audit log.

## Creating the first platform admin

`apps/api/src/scripts/create-admin.ts`, compiled to `dist/scripts/create-admin.js` in the API image. It
creates the user (or, for an existing email, resets its password and role, verifies the email and lifts any
suspension). Password: at least 10 characters. `--role` is `owner` (default), `admin` or `support`.

```sh
docker compose -f docker-compose.prod.yml --env-file .env.production exec api \
  node dist/scripts/create-admin.js --email you@example.com --password '…' --name 'You'
```

Then sign in at the web app and open `/admin`.

## Upgrades

```sh
# update the checkout, then:
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
```

`migrate` runs again on every `up`: `prisma migrate deploy` applies pending migrations and the seed adds only
missing plans. `api` and `worker` start only after it succeeds. The worker shuts down gracefully, waiting for
in-flight jobs (Nest shutdown hooks close the BullMQ workers).

## Health checks

- `GET /v1/health` on the API (public, not rate-limited): runs `SELECT 1` against Postgres and `PING` against
  Redis. Healthy → `200 { "data": { "ok": true, "checks": { "database": true, "redis": true } } }`;
  otherwise `503` with `error.code = "unavailable"`. Through the web origin it is `GET /api/health`.
- Compose healthchecks: `postgres` (`pg_isready`), `redis` (`redis-cli ping`), `api`
  (`wget -qO- http://127.0.0.1:3601/v1/health`, every 15 s, 5 retries). `worker` and `web` have none.

## External providers

All provider-facing URLs go through the web origin's `/api` proxy and are built from `PUBLIC_APP_URL`.

| Provider | Register | Notes |
|---|---|---|
| Google OAuth client (web application) | `{PUBLIC_APP_URL}/api/auth/google/callback` and `{PUBLIC_APP_URL}/api/mailboxes/oauth/gmail/callback` | One client serves Google sign-in and Gmail mailbox connections. |
| Microsoft Entra app registration | `{PUBLIC_APP_URL}/api/mailboxes/oauth/microsoft/callback` | Mailbox connections. Tenant from `MICROSOFT_TENANT` (`common` unless added to the compose file). |
| Stripe webhook endpoint | `POST {PUBLIC_APP_URL}/api/webhooks/billing/stripe` | Signing secret → `STRIPE_WEBHOOK_SECRET`. Event list and setup steps: docs/BILLING.md. Checkout returns to `{PUBLIC_APP_URL}/w/<workspaceId>/billing`. |
| WhatsApp (Meta Cloud API), per workspace | `{PUBLIC_APP_URL}/api/webhooks/whatsapp/<webhookKey>` | The URL and verify token are shown in the workspace's channel settings after connecting. |
| Telegram bot, per workspace | — | When `PUBLIC_APP_URL` is https the API registers `{PUBLIC_APP_URL}/api/webhooks/telegram/<webhookKey>` with Telegram itself; otherwise the worker polls every 10 seconds. |

Open/click tracking and unsubscribe links in sent email are built as `{PUBLIC_APP_URL}/api/t/...` and signed
with a key derived from `ENCRYPTION_KEY`; changing either breaks links in mail already sent.

## Public API

Integrations call the API through the web origin: `{PUBLIC_APP_URL}/api/...` is proxied to `/v1/...`
(for example `{PUBLIC_APP_URL}/api/docs.json` serves the OpenAPI document from `/v1/docs.json`). They
authenticate with `Authorization: Bearer gd_…` workspace API keys. See docs/BUSINESS_OS_API.md.

## Data and secrets

- Persistent state is in the named volumes `postgres-data` and `redis-data`, plus the dumps in `BACKUP_DIR`
  (see [Backups](#backups)). Redis runs with append-only
  persistence and holds queued jobs; Postgres is the source of truth.
- **Back up `ENCRYPTION_KEY`** alongside the database. Without it, sealed mailbox passwords, OAuth tokens and
  provider secrets cannot be read, and existing tracking/unsubscribe links stop verifying.
- `.env.production` holds every secret; keep it out of version control.
- Workspace data exports sit in the `exports-data` volume until they expire (`DATA_EXPORT_DAYS`). They are
  short-lived copies of customer data: there is no need to back the volume up, and it should not be copied
  anywhere else. Retention, the purge job and the incident runbook are in [docs/PRIVACY_OPS.md](PRIVACY_OPS.md).

## Backups

The `backup` service writes a full `pg_dump` (custom format, compressed) once a day at `BACKUP_HOUR_UTC`
(default 03:00 UTC) into `BACKUP_DIR` (default `./backups` next to the compose file), keeping
`BACKUP_RETAIN_DAYS` (default 14). Each dump is checked with `pg_restore --list` before it is kept and gets a
`.sha256` file. The scripts are `scripts/backup/pg-backup.sh` and `scripts/backup/pg-restore.sh`.

```sh
# A backup now (before an upgrade, for example)
docker compose -f docker-compose.prod.yml --env-file .env.production run --rm backup sh /scripts/pg-backup.sh --once
docker compose -f docker-compose.prod.yml --env-file .env.production logs backup   # "backup ok" / "BACKUP FAILED"
```

**Copy the backups off this host.** Dumps on the same disk as the database survive a bad migration or a
deleted table, but not a lost server. Sync `BACKUP_DIR` to separate storage from a host cron job, for example:

```sh
# restic (encrypted, deduplicated) to S3-compatible storage, every day after the dump
restic -r s3:https://<endpoint>/<bucket>/growthdesk backup /srv/growthdesk/backups && restic forget --keep-daily 30 --prune
# or rclone to any provider
rclone copy /srv/growthdesk/backups remote:growthdesk-backups
```

**Escrow the secrets separately from the dumps:** `ENCRYPTION_KEY` and `POSTGRES_PASSWORD` in a password
manager or secrets vault that two people can open. A dump restored without its `ENCRYPTION_KEY` loses every
sealed secret (mailbox passwords, OAuth tokens, email service credentials) and every outstanding
tracking/unsubscribe link.

**Restore drill: run it once now and then quarterly.** Restore into a scratch database, never over the live one:

```sh
docker compose -f docker-compose.prod.yml --env-file .env.production run --rm backup \
  sh /scripts/pg-restore.sh /backups/growthdesk-<timestamp>.dump restore_drill
```

It verifies the checksum, refuses a database that already has tables (unless `FORCE=1`), and prints row
counts (workspaces, users, contacts, messages, migrations) to compare with production. Drop `restore_drill`
afterwards. A real recovery goes like this:
1. Stop `api`, `worker` and `web`.
2. Restore into a new database.
3. Point `DATABASE_URL` at it (or rename the databases).
4. Start `migrate`, then the services.

**Data-loss window:** a nightly dump means up to 24 hours of data can be lost. To narrow that, add
continuous WAL archiving for point-in-time recovery (pgBackRest or WAL-G to object storage), or move
Postgres to a managed service with PITR. This is tracked in docs/GAP_PLAN.md §0.3.

## Local development

Requires Node ≥ 24, pnpm 12.9.1 (`packageManager`) and Docker.

```sh
pnpm bootstrap   # scripts/setup.mjs, one-time, safe to re-run
pnpm dev         # scripts/dev.mjs
```

`pnpm bootstrap`: creates `apps/api/.env` from `apps/api/.env.example` with a fresh `ENCRYPTION_KEY` and
`ALLOW_PRIVATE_MAIL_HOSTS=true`; creates `apps/web/.env.local` from `apps/web/.env.example`; runs
`pnpm install`, `docker compose up -d --wait`, builds `@growthdesk/shared`, `prisma migrate deploy`,
`prisma generate`, builds the API and runs the seed.

`pnpm dev`: starts the Docker services, builds shared, applies migrations, then runs shared (watch), the API
(`http://127.0.0.1:3601/v1`, Swagger at `/v1/docs`), the worker and the web app (`http://localhost:3600`)
with prefixed logs. Ctrl+C stops what it started.

Development services (`docker-compose.yml`, host ports offset from the defaults, all bound to 127.0.0.1):

| Service | Host port | Purpose |
|---|---|---|
| postgres | 5466 | user/password/database `growthdesk` |
| redis | 6386 | `noeviction`, append-only |
| mailpit | SMTP 1066, UI http://localhost:8066 | Catches platform mail |
| greenmail | SMTP 3925, IMAP 3943 | Real SMTP/IMAP for connected-mailbox tests; any `@growthdesk.test` address is auto-provisioned with password = address |

Other root scripts: `pnpm services:up` / `services:down`, `pnpm db:migrate`, `pnpm db:migrate:dev`,
`pnpm db:seed` (runs the built `dist/scripts/seed.js`), `pnpm db:studio`,
`pnpm admin:create --email … --password … --name …`, `pnpm build`, `pnpm typecheck`,
`pnpm test` (unit + API e2e; e2e uses the dev Postgres on 5466 with its own `growthdesk_test` database),
`pnpm test:ui` (Playwright).
