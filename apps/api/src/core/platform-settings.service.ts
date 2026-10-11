import { Inject, Injectable } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { open, seal } from "../common/crypto.js";

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
};

/** Write-only secret inputs → the sealed setting each one is stored in. */
const SECRETS = { aiApiKey: "aiApiKeySealed", resendApiKey: "resendApiKeySealed", resendWebhookSecret: "resendWebhookSecretSealed" } as const;
type SecretInput = { [K in keyof typeof SECRETS]?: string };

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

  async update(patch: Partial<PlatformSettings> & SecretInput, userId: string | null): Promise<PlatformSettings> {
    const entries: [string, unknown][] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      if (k in SECRETS) {
        // Sealed settings are only ever written through their write-only input.
        entries.push([SECRETS[k as keyof typeof SECRETS], v ? seal(String(v)) : ""]);
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

  /** What the admin panel may see: everything except the sealed secrets (only whether each is set). */
  async publicView() {
    const { aiApiKeySealed, resendApiKeySealed, resendWebhookSecretSealed, ...rest } = await this.get();
    return {
      ...rest,
      aiApiKeySet: Boolean(aiApiKeySealed) || Boolean(await this.aiApiKey()),
      resendApiKeySet: Boolean(resendApiKeySealed) || Boolean(await this.resendApiKey()),
      resendWebhookSecretSet: Boolean(resendWebhookSecretSealed) || Boolean(await this.resendWebhookSecret()),
    };
  }

  invalidate() {
    this.cache = null;
  }
}
