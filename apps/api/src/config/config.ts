import { z } from "zod";

/*
 * Every environment variable the API and worker read, validated once at boot.
 * Blank values are treated as unset (LinkDesk's assertEnvironment rule), so an
 * `.env` line left as `STRIPE_SECRET_KEY=` disables the feature instead of
 * configuring it with an empty secret.
 */

const blankAsUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const opt = () => z.preprocess(blankAsUndefined, z.string().optional());
/** Retention in days; blank means the default (a bare z.coerce would read "" as 0 = keep forever). */
const days = (fallback: number) => z.preprocess(blankAsUndefined, z.coerce.number().int().min(0).default(fallback));
const bool = (fallback: boolean) =>
  z.preprocess((v) => (blankAsUndefined(v) === undefined ? fallback : String(v) === "true" || String(v) === "1"), z.boolean());

const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["debug", "log", "warn", "error"]).default("log"),
  /** json = one JSON object per line (log shippers); pretty = Nest's coloured lines. Default: json in production. */
  LOG_FORMAT: z.preprocess(blankAsUndefined, z.enum(["json", "pretty"]).optional()),
  /** Optional error reporting (Sentry or a compatible server such as GlitchTip). Off unless set. */
  SENTRY_DSN: opt(),
  /** Sentry's environment tag. Defaults to NODE_ENV. */
  SENTRY_ENVIRONMENT: opt(),
  /** Sentry's release tag, e.g. the image tag or git sha. */
  SENTRY_RELEASE: opt(),
  API_PORT: z.coerce.number().int().default(3601),
  API_HOST: z.string().default("127.0.0.1"),
  /** Where people open the app. Links in emails, tracking URLs and webhook URLs are built from it. */
  PUBLIC_APP_URL: z.string().url().default("http://localhost:3600"),
  /** The super-admin app (apps/admin). Linked from the customer app for platform staff only. */
  ADMIN_APP_URL: z.string().url().default("http://localhost:3602"),
  /** Origins allowed to send cookie-authenticated writes (comma-separated). Defaults to PUBLIC_APP_URL + ADMIN_APP_URL. */
  ALLOWED_ORIGINS: opt(),
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).default(1),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default("redis://127.0.0.1:6386"),
  /** 32 bytes, base64. Seals mailbox passwords, OAuth tokens and provider secrets. */
  ENCRYPTION_KEY: z.string().min(40),

  SESSION_DAYS: z.coerce.number().int().min(1).max(90).default(14),

  /** The platform's own transactional mail (verification, reset, invitations). */
  MAIL_FROM: z.string().default("Growthdesk <no-reply@growthdesk.local>"),
  /** Platform mail through Resend. Keys saved in admin → Email settings take precedence. */
  RESEND_API_KEY: opt(),
  RESEND_WEBHOOK_SECRET: opt(),
  MAIL_REPLY_TO: opt(),
  SMTP_HOST: z.string().default("127.0.0.1"),
  SMTP_PORT: z.coerce.number().int().default(1066),
  SMTP_SECURE: bool(false),
  SMTP_USER: opt(),
  SMTP_PASSWORD: opt(),

  GOOGLE_CLIENT_ID: opt(),
  GOOGLE_CLIENT_SECRET: opt(),
  MICROSOFT_CLIENT_ID: opt(),
  MICROSOFT_CLIENT_SECRET: opt(),
  MICROSOFT_TENANT: z.string().default("common"),

  STRIPE_SECRET_KEY: opt(),
  STRIPE_WEBHOOK_SECRET: opt(),

  /** Platform AI defaults; the platform admin can override them in settings. */
  AI_PROVIDER: z.enum(["none", "anthropic", "openai"]).default("none"),
  AI_MODEL: opt(),
  ANTHROPIC_API_KEY: opt(),
  OPENAI_API_KEY: opt(),
  /** Optional: another endpoint for the AI provider (an OpenAI-compatible gateway or self-hosted server). */
  AI_BASE_URL: opt(),

  /** Run BullMQ processors in this process (the worker sets it; the API does not). */
  RUN_WORKERS: bool(false),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(5),
  /** Allows the private-network SMTP/IMAP hosts used by local test servers. Never enable in production. */
  ALLOW_PRIVATE_MAIL_HOSTS: bool(false),
  /**
   * Development only: treat every marketing sending domain's DNS as correct,
   * so the send flow can be tried locally. Ignored when NODE_ENV=production.
   */
  MARKETING_SKIP_DNS_CHECKS: bool(false),
  /** Free trials granted per signup IP address in a rolling day; later accounts start on the free plan. 0 = no limit. */
  TRIALS_PER_IP_PER_DAY: z.coerce.number().int().min(0).default(3),

  /*
   * Data retention (days) for the high-volume history tables, pruned daily by
   * the worker's `retention` job (worker/retention.service.ts). 0 keeps rows
   * forever. Customer records themselves (contacts, messages, deals, notes)
   * are never pruned.
   */
  /** Domain events, once dispatched and no workflow run or webhook delivery still needs them. */
  RETENTION_DOMAIN_EVENT_DAYS: days(30),
  /** Per-message delivery/open/click events (Message keeps its own sentAt/openedAt/… columns). */
  RETENTION_MESSAGE_EVENT_DAYS: days(365),
  /** Finished workflow runs (the Runs tab of a workflow). */
  RETENTION_WORKFLOW_RUN_DAYS: days(90),
  /** Step executions of finished enrollments in completed or canceled campaigns. Kept by default: the per-step report reads them. */
  RETENTION_STEP_EXECUTION_DAYS: days(0),
  /** Automated open/click entries on the contact timeline. Every other timeline entry is kept. */
  RETENTION_ACTIVITY_NOISE_DAYS: days(365),
  /** Per-call AI usage rows (monthly allowances are counted separately, in UsageCounter). */
  RETENTION_AI_USAGE_DAYS: days(400),
  /** Processed payment-provider webhooks (the raw log; invoices and subscriptions are kept). */
  RETENTION_BILLING_EVENT_DAYS: days(400),
  /** Per-recipient rows of marketing campaigns that finished this long ago. Their counters stay on the campaign. */
  RETENTION_MARKETING_SEND_DAYS: days(730),
  /** Rows deleted per statement, so a large backlog never holds long locks. */
  RETENTION_BATCH_SIZE: z.preprocess(blankAsUndefined, z.coerce.number().int().min(100).max(50_000).default(5000)),

  /** Days a deleted workspace can be restored (platform admin) before the purge job hard-deletes its data. */
  WORKSPACE_PURGE_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  /**
   * Where workspace data exports are written. The API (download) and the worker (build) must see the same
   * directory: mount one volume at this path in both containers. Relative paths resolve from the process's cwd.
   */
  DATA_EXPORT_DIR: z.string().default(".data/exports"),
  /** Days an export file can be downloaded before it is deleted. */
  DATA_EXPORT_DAYS: z.coerce.number().int().min(1).max(30).default(7),
});

export type AppConfig = z.infer<typeof Env> & { allowedOrigins: string[] };

export const APP_CONFIG = Symbol("APP_CONFIG");

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment:\n${lines}\nSee .env.example for every setting.`);
  }
  const cfg = parsed.data;
  const key = Buffer.from(cfg.ENCRYPTION_KEY, "base64");
  if (key.length !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes of base64 (openssl rand -base64 32).");
  const allowedOrigins = (cfg.ALLOWED_ORIGINS ?? `${new URL(cfg.PUBLIC_APP_URL).origin},${new URL(cfg.ADMIN_APP_URL).origin}`)
    .split(",")
    .map((o) => o.trim().replace(/\/$/, ""))
    .filter(Boolean);
  return { ...cfg, allowedOrigins };
}
