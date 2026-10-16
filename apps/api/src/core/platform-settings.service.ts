import { Inject, Injectable } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { open, seal } from "../common/crypto.js";
import { DATA_RETENTION, type DataRetentionKey } from "../worker/maintenance-policy.js";

/*
 * Install-level policy, edited in the platform admin. Each setting is read by
 * the code that enforces it (sign-up, the access guard, the campaign engine,
 * the AI service) — a switch that only changed its own appearance would be a
 * lie. Values are cached for a few seconds per process.
 */

export type PlatformSettings = {
  signupsOpen: boolean;
  signupDomains: string[];
  defaultPlanKey: string;
  expiredPlanKey: string;
  graceDays: number;
  maintenanceMode: boolean;
  maintenanceMessage: string;
  outreachEnabled: boolean;
  aiProvider: "none" | "anthropic" | "openai";
  aiModel: string;
  /** Sealed; never returned to a client. */
  aiApiKeySealed: string;

  // Platform email (apps/api/src/platform-mail).
  /** smtp = SMTP_* env (Mailpit in dev); resend = the Resend API, SMTP as the fallback when Resend is unconfigured. */
  mailProvider: "smtp" | "resend";
  /** Sealed; never returned to a client. Falls back to RESEND_API_KEY. */
  resendApiKeySealed: string;
  /** Sealed (whsec_…); never returned to a client. Falls back to RESEND_WEBHOOK_SECRET. */
  resendWebhookSecretSealed: string;
  /** "Name <address>" for system mail; "" = MAIL_FROM. */
  transactionalFrom: string;
  /** "Name <address>" for broadcasts and drips; "" = transactionalFrom. */
  marketingFrom: string;
  /** "" = MAIL_REPLY_TO, else none. */
  replyTo: string;
  /** Requests per second shared by every worker. Resend's default team limit is 10/s; a batch call (≤100 emails) is one request. */
  resendRateLimitPerSec: number;

  // Registration (auth.service assertSignupAllowed).
  /** open | invite_only (needs a PlatformSignupInvite) | waitlist (collects PlatformWaitlistEntry) | closed. */
  signupMode: "open" | "invite_only" | "waitlist" | "closed";
  blockDisposableDomains: boolean;
  extraBlockedDomains: string[];
  /** Writes (workspace creation included) need a verified email. */
  requireEmailVerification: boolean;
  /** Overrides the default plan's trialDays at workspace creation; null = the plan's own. */
  defaultTrialDays: number | null;

  // Public site.
  /** false = "/" sends visitors to /login instead of the landing page. */
  landingEnabled: boolean;

  // Platform mail over SMTP. smtpHost "" = the SMTP_* environment (Mailpit in development).
  smtpHost: string;
  smtpPort: number;
  /** true = implicit TLS (465); false = STARTTLS when the server offers it. */
  smtpSecure: boolean;
  smtpUser: string;
  /** Sealed; never returned to a client. */
  smtpPasswordSealed: string;

  // OAuth clients: Google sign-in and Gmail mailboxes; Microsoft 365 mailboxes. Id "" = the environment's pair.
  googleClientId: string;
  /** Sealed; never returned to a client. */
  googleClientSecretSealed: string;
  microsoftClientId: string;
  /** Sealed; never returned to a client. */
  microsoftClientSecretSealed: string;
  /** "" = MICROSOFT_TENANT. */
  microsoftTenant: string;

  // The Discord application workspaces add as a bot (src/discord). Id "" = the DISCORD_* environment.
  discordClientId: string;
  /** Sealed; never returned to a client. */
  discordClientSecretSealed: string;
  /** Sealed; never returned to a client. */
  discordBotTokenSealed: string;

  // Stripe. Each falls back to its STRIPE_* environment value.
  /** Sealed; never returned to a client. */
  stripeSecretKeySealed: string;
  /** Sealed (whsec_…); never returned to a client. */
  stripeWebhookSecretSealed: string;

  /** An OpenAI-compatible gateway or self-hosted endpoint; "" = AI_BASE_URL, else the provider default. */
  aiBaseUrl: string;
  /** Free trials per signup IP in a rolling day; null = TRIALS_PER_IP_PER_DAY. 0 = no limit. */
  trialsPerIpPerDay: number | null;
  /** History retention in days per table (worker/maintenance-policy.ts DATA_RETENTION); a missing key = its RETENTION_* environment value. */
  retentionDays: Partial<Record<DataRetentionKey, number>>;
  /** Checks on every email a contact gets by hand, CSV, the leads API or MCP (core/email-validation.service.ts). */
  contactEmailValidation: ContactEmailValidation;
};

export type ContactEmailValidation = {
  /** Off: only the address's syntax matters, as before. */
  enabled: boolean;
  /** Refuse throwaway mail services (auth/disposable-domains.ts). */
  blockDisposable: boolean;
  /** Refuse domains with no mail server (DNS MX, or an address record). Fails open when DNS cannot answer. */
  checkMailServer: boolean;
  /** Refuse shared mailboxes such as info@ and sales@. */
  blockRoleAccounts: boolean;
  /** Domains never accepted as a contact's email (and their subdomains). */
  blockedDomains: string[];
};

const DEFAULTS: PlatformSettings = {
  signupsOpen: true,
  signupDomains: [],
  defaultPlanKey: "starter",
  expiredPlanKey: "free",
  graceDays: 7,
  maintenanceMode: false,
  maintenanceMessage: "",
  outreachEnabled: true,
  aiProvider: "none",
  aiModel: "",
  aiApiKeySealed: "",
  mailProvider: "smtp",
  resendApiKeySealed: "",
  resendWebhookSecretSealed: "",
  transactionalFrom: "",
  marketingFrom: "",
  replyTo: "",
  resendRateLimitPerSec: 2,
  signupMode: "open",
  blockDisposableDomains: true,
  extraBlockedDomains: [],
  requireEmailVerification: true,
  defaultTrialDays: null,
  landingEnabled: true,
  smtpHost: "",
  smtpPort: 587,
  smtpSecure: false,
  smtpUser: "",
  smtpPasswordSealed: "",
  googleClientId: "",
  googleClientSecretSealed: "",
  microsoftClientId: "",
  microsoftClientSecretSealed: "",
  microsoftTenant: "",
  discordClientId: "",
  discordClientSecretSealed: "",
  discordBotTokenSealed: "",
  stripeSecretKeySealed: "",
  stripeWebhookSecretSealed: "",
  aiBaseUrl: "",
  trialsPerIpPerDay: null,
  retentionDays: {},
  contactEmailValidation: { enabled: false, blockDisposable: true, checkMailServer: true, blockRoleAccounts: false, blockedDomains: [] },
};

/** Write-only secret inputs → the sealed setting each one is stored in. */
export const SECRETS = {
  aiApiKey: "aiApiKeySealed",
  resendApiKey: "resendApiKeySealed",
  resendWebhookSecret: "resendWebhookSecretSealed",
  smtpPassword: "smtpPasswordSealed",
  googleClientSecret: "googleClientSecretSealed",
  microsoftClientSecret: "microsoftClientSecretSealed",
  discordClientSecret: "discordClientSecretSealed",
  discordBotToken: "discordBotTokenSealed",
  stripeSecretKey: "stripeSecretKeySealed",
  stripeWebhookSecret: "stripeWebhookSecretSealed",
} as const;
export type SecretName = keyof typeof SECRETS;
export const isSecretName = (k: string): k is SecretName => k in SECRETS;
type SecretInput = { [K in SecretName]?: string };
type Sealed = (typeof SECRETS)[SecretName];

export type OAuthClient = { id: string; secret: string; fromEnv: boolean };
/** The Discord application: its OAuth client (to add the bot to a server) and the bot's token (to act in it). */
export type DiscordApp = { clientId: string; clientSecret: string; botToken: string; fromEnv: boolean };
export type SmtpConfig = { host: string; port: number; secure: boolean; user: string; password: string; fromEnv: boolean };

const TTL_MS = 5_000;

@Injectable()
export class PlatformSettingsService {
  private cache: { at: number; value: PlatformSettings } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async get(): Promise<PlatformSettings> {
    if (this.cache && Date.now() - this.cache.at < TTL_MS) return this.cache.value;
    const rows = await this.prisma.db.platformSetting.findMany();
    const stored = Object.fromEntries(rows.map((r) => [r.key, r.value])) as Partial<PlatformSettings>;
    const value: PlatformSettings = { ...DEFAULTS, ...stored };
    if (!stored.aiProvider && this.config.AI_PROVIDER !== "none") value.aiProvider = this.config.AI_PROVIDER;
    if (!stored.aiModel && this.config.AI_MODEL) value.aiModel = this.config.AI_MODEL;
    this.cache = { at: Date.now(), value };
    return value;
  }

  /** The AI key: the admin-set one, else the environment's. */
  async aiApiKey(): Promise<string> {
    const s = await this.get();
    if (s.aiApiKeySealed) return open(s.aiApiKeySealed) ?? "";
    if (s.aiProvider === "anthropic") return this.config.ANTHROPIC_API_KEY ?? "";
    if (s.aiProvider === "openai") return this.config.OPENAI_API_KEY ?? "";
    return "";
  }

  /** The Resend API key: the admin-set one, else RESEND_API_KEY. */
  async resendApiKey(): Promise<string> {
    const s = await this.get();
    if (s.resendApiKeySealed) return open(s.resendApiKeySealed) ?? "";
    return this.config.RESEND_API_KEY ?? "";
  }

  /** The Resend (Svix) webhook signing secret: the admin-set one, else RESEND_WEBHOOK_SECRET. */
  async resendWebhookSecret(): Promise<string> {
    const s = await this.get();
    if (s.resendWebhookSecretSealed) return open(s.resendWebhookSecretSealed) ?? "";
    return this.config.RESEND_WEBHOOK_SECRET ?? "";
  }

  /** The SMTP server for platform mail: the admin-set one when it names a host, else SMTP_*. */
  async smtp(): Promise<SmtpConfig> {
    const s = await this.get();
    if (s.smtpHost) {
      return { host: s.smtpHost, port: s.smtpPort, secure: s.smtpSecure, user: s.smtpUser, password: s.smtpUser ? (open(s.smtpPasswordSealed) ?? "") : "", fromEnv: false };
    }
    const c = this.config;
    return { host: c.SMTP_HOST, port: c.SMTP_PORT, secure: c.SMTP_SECURE, user: c.SMTP_USER ?? "", password: c.SMTP_PASSWORD ?? "", fromEnv: true };
  }

  /**
   * The OAuth client for Google (sign-in and Gmail mailboxes) or Microsoft 365, or null when there is none.
   * The id and secret travel as a pair: an admin-set client id uses the admin-set secret, never the environment's.
   */
  async oauthClient(provider: "google" | "microsoft"): Promise<OAuthClient | null> {
    const s = await this.get();
    const [id, sealed, envId, envSecret] =
      provider === "google"
        ? [s.googleClientId, s.googleClientSecretSealed, this.config.GOOGLE_CLIENT_ID, this.config.GOOGLE_CLIENT_SECRET]
        : [s.microsoftClientId, s.microsoftClientSecretSealed, this.config.MICROSOFT_CLIENT_ID, this.config.MICROSOFT_CLIENT_SECRET];
    if (id) {
      const secret = open(sealed) ?? "";
      return secret ? { id, secret, fromEnv: false } : null;
    }
    return envId && envSecret ? { id: envId, secret: envSecret, fromEnv: true } : null;
  }

  /**
   * The Discord application, or null when it is not fully configured. Like the OAuth clients, the three values
   * travel together: an admin-set client id uses the admin-set secret and token, never the environment's.
   */
  async discordApp(): Promise<DiscordApp | null> {
    const s = await this.get();
    if (s.discordClientId) {
      const clientSecret = open(s.discordClientSecretSealed) ?? "";
      const botToken = open(s.discordBotTokenSealed) ?? "";
      return clientSecret && botToken ? { clientId: s.discordClientId, clientSecret, botToken, fromEnv: false } : null;
    }
    const c = this.config;
    return c.DISCORD_CLIENT_ID && c.DISCORD_CLIENT_SECRET && c.DISCORD_BOT_TOKEN ? { clientId: c.DISCORD_CLIENT_ID, clientSecret: c.DISCORD_CLIENT_SECRET, botToken: c.DISCORD_BOT_TOKEN, fromEnv: true } : null;
  }

  async microsoftTenant(): Promise<string> {
    return (await this.get()).microsoftTenant || this.config.MICROSOFT_TENANT;
  }

  /** Stripe's API key and webhook signing secret: each the admin-set one, else its STRIPE_* environment value. */
  async stripe(): Promise<{ secretKey: string; webhookSecret: string }> {
    const s = await this.get();
    return {
      secretKey: (s.stripeSecretKeySealed ? open(s.stripeSecretKeySealed) : this.config.STRIPE_SECRET_KEY) ?? "",
      webhookSecret: (s.stripeWebhookSecretSealed ? open(s.stripeWebhookSecretSealed) : this.config.STRIPE_WEBHOOK_SECRET) ?? "",
    };
  }

  async aiBaseUrl(): Promise<string | undefined> {
    return (await this.get()).aiBaseUrl || this.config.AI_BASE_URL;
  }

  async trialsPerIpPerDay(): Promise<number> {
    return (await this.get()).trialsPerIpPerDay ?? this.config.TRIALS_PER_IP_PER_DAY;
  }

  /** Retention in days for every history table: the admin-set value, else the environment's (0 = keep forever). */
  async retentionDays(): Promise<Record<DataRetentionKey, number>> {
    const s = await this.get();
    const out = {} as Record<DataRetentionKey, number>;
    for (const [k, env] of Object.entries(DATA_RETENTION) as [DataRetentionKey, (typeof DATA_RETENTION)[DataRetentionKey]][]) {
      out[k] = s.retentionDays[k] ?? this.config[env];
    }
    return out;
  }

  async update(patch: Partial<PlatformSettings> & SecretInput, userId: string | null): Promise<PlatformSettings> {
    const entries: [string, unknown][] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      if (isSecretName(k)) {
        // Sealed settings are only ever written through their write-only input.
        entries.push([SECRETS[k], v ? seal(String(v)) : ""]);
      } else if (k in DEFAULTS && !Object.values<string>(SECRETS).includes(k)) {
        entries.push([k, v]);
      }
    }
    for (const [key, value] of entries) {
      await this.prisma.db.platformSetting.upsert({
        where: { key },
        create: { key, value: value as never, updatedById: userId },
        update: { value: value as never, updatedById: userId },
      });
    }
    this.cache = null;
    return this.get();
  }

  /**
   * What the admin panel may see: everything except the sealed secrets. For each secret, `<name>Set` says
   * whether one applies and `<name>FromEnv` whether it comes from the server's environment. `env` carries the
   * environment's non-secret values, shown as what applies when a setting is left empty.
   */
  async publicView() {
    const s = await this.get();
    const rest = Object.fromEntries(Object.entries(s).filter(([k]) => !Object.values<string>(SECRETS).includes(k))) as Omit<PlatformSettings, Sealed>;
    const [aiKey, resendKey, resendSecret, smtp, google, microsoft, stripe, discord] = await Promise.all([
      this.aiApiKey(),
      this.resendApiKey(),
      this.resendWebhookSecret(),
      this.smtp(),
      this.oauthClient("google"),
      this.oauthClient("microsoft"),
      this.stripe(),
      this.discordApp(),
    ]);
    const c = this.config;
    return {
      ...rest,
      aiApiKeySet: Boolean(aiKey),
      aiApiKeyFromEnv: !s.aiApiKeySealed && Boolean(aiKey),
      resendApiKeySet: Boolean(resendKey),
      resendApiKeyFromEnv: !s.resendApiKeySealed && Boolean(resendKey),
      resendWebhookSecretSet: Boolean(resendSecret),
      resendWebhookSecretFromEnv: !s.resendWebhookSecretSealed && Boolean(resendSecret),
      smtpPasswordSet: Boolean(smtp.password),
      smtpPasswordFromEnv: smtp.fromEnv && Boolean(smtp.password),
      googleClientSecretSet: Boolean(google),
      googleClientSecretFromEnv: Boolean(google?.fromEnv),
      microsoftClientSecretSet: Boolean(microsoft),
      microsoftClientSecretFromEnv: Boolean(microsoft?.fromEnv),
      // Each Discord secret counts as set when it is saved here, or (with no client id saved) in the environment.
      discordClientSecretSet: s.discordClientId ? Boolean(s.discordClientSecretSealed) : Boolean(this.config.DISCORD_CLIENT_SECRET),
      discordClientSecretFromEnv: !s.discordClientId && Boolean(this.config.DISCORD_CLIENT_SECRET),
      discordBotTokenSet: s.discordClientId ? Boolean(s.discordBotTokenSealed) : Boolean(this.config.DISCORD_BOT_TOKEN),
      discordBotTokenFromEnv: !s.discordClientId && Boolean(this.config.DISCORD_BOT_TOKEN),
      discordConfigured: Boolean(discord),
      stripeSecretKeySet: Boolean(stripe.secretKey),
      stripeSecretKeyFromEnv: !s.stripeSecretKeySealed && Boolean(stripe.secretKey),
      stripeWebhookSecretSet: Boolean(stripe.webhookSecret),
      stripeWebhookSecretFromEnv: !s.stripeWebhookSecretSealed && Boolean(stripe.webhookSecret),
      env: {
        smtp: { host: c.SMTP_HOST, port: c.SMTP_PORT, secure: c.SMTP_SECURE, user: c.SMTP_USER ?? "" },
        googleClientId: c.GOOGLE_CLIENT_ID ?? "",
        microsoftClientId: c.MICROSOFT_CLIENT_ID ?? "",
        microsoftTenant: c.MICROSOFT_TENANT,
        discordClientId: c.DISCORD_CLIENT_ID ?? "",
        aiBaseUrl: c.AI_BASE_URL ?? "",
        trialsPerIpPerDay: c.TRIALS_PER_IP_PER_DAY,
        retentionDays: Object.fromEntries(Object.entries(DATA_RETENTION).map(([k, env]) => [k, c[env]])) as Record<DataRetentionKey, number>,
      },
    };
  }

  invalidate() {
    this.cache = null;
  }
}
