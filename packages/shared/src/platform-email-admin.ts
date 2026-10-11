import { z } from "zod";
import { EmailBlocks } from "./email-design.js";

/*
 * Super-admin inputs for platform email (apps/api/src/platform-mail):
 * Email settings, the delivery log and the editable system templates.
 * Template keys and their variables are in platform-mail.ts.
 */

/** EmailLog.status values, in delivery order. */
export const PLATFORM_EMAIL_STATUSES = ["queued", "sent", "delivered", "bounced", "complained", "failed", "suppressed"] as const;
export type PlatformEmailStatus = (typeof PLATFORM_EMAIL_STATUSES)[number];
export const PLATFORM_EMAIL_STREAMS = ["transactional", "marketing"] as const;
export type PlatformEmailStream = (typeof PLATFORM_EMAIL_STREAMS)[number];
export const PLATFORM_MAIL_PROVIDERS = ["smtp", "resend"] as const;
export type PlatformMailProviderId = (typeof PLATFORM_MAIL_PROVIDERS)[number];

/** "Name <address@domain>" or a bare address; "" = use the default. */
const sender = z
  .string()
  .trim()
  .max(200)
  .refine((v) => v === "" || /^(?:[^<>@\r\n]{0,150}<\s*[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+\s*>|[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)$/.test(v), 'Use an address, or "Name <address@domain>"');

export const PlatformEmailSettingsInput = z.object({
  mailProvider: z.enum(PLATFORM_MAIL_PROVIDERS).optional(),
  /** Write-only. "" clears the saved key (RESEND_API_KEY then applies, if set). */
  resendApiKey: z.string().trim().max(500).optional(),
  /** Write-only (whsec_…). "" clears it. */
  resendWebhookSecret: z
    .string()
    .trim()
    .max(500)
    .refine((v) => v === "" || /^whsec_[A-Za-z0-9+/=]+$/.test(v), "Paste the signing secret from Resend (it starts with whsec_)")
    .optional(),
  transactionalFrom: sender.optional(),
  marketingFrom: sender.optional(),
  replyTo: sender.optional(),
  resendRateLimitPerSec: z.number().int().min(1).max(100).optional(),
});

/** A template's content as edited in admin. Tokens are checked against the template's variables by the API. */
export const PlatformEmailTemplateDraft = z.object({
  subject: z.string().trim().min(1, "Add a subject").max(300),
  preheader: z.string().trim().max(300).default(""),
  blocks: EmailBlocks.min(1, "Add at least one block"),
});
export type PlatformEmailTemplateDraft = z.infer<typeof PlatformEmailTemplateDraft>;

/** Publishes a new version and makes it the active one. */
export const PlatformEmailTemplatePublishInput = PlatformEmailTemplateDraft.extend({
  note: z.string().trim().max(500).default(""),
});

/** Renders a draft with sample (or given) variable values. */
export const PlatformEmailTemplatePreviewInput = PlatformEmailTemplateDraft.extend({
  vars: z.record(z.string(), z.string().max(2000)).optional(),
});

/** Sends a test to the signed-in admin: the draft when given, else the active version (or the code default). */
export const PlatformEmailTemplateTestInput = z.object({
  draft: PlatformEmailTemplateDraft.optional(),
  vars: z.record(z.string(), z.string().max(2000)).optional(),
});
