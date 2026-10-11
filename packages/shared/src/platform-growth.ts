import { z } from "zod";
import { EmailBlocks } from "./email-design.js";
import { SUBSCRIPTION_STATUSES } from "./enums.js";
import { SIGNUP_SOURCES, USER_TAG_PATTERN, normalizeUserTag } from "./platform-users.js";

/*
 * Platform growth (super-admin Phase 5): marketing to the SaaS's OWN users —
 * audiences, broadcasts, onboarding drips, subscribers and the product-email
 * preference. The API is apps/api/src/platform-growth.
 *
 * Every audience is AND-ed with the marketing rule, whatever its filter says:
 * marketing consent given, not unsubscribed, not suppressed (hard bounce /
 * complaint / admin), not anonymised, account not suspended and email
 * verified. Transactional (system) mail checks none of these.
 */

// ─── Audiences ───────────────────────────────────────────────────────────────

const instant = z
  .string()
  .trim()
  .max(40)
  .refine((v) => !Number.isNaN(Date.parse(v)), "Use a date and time")
  .transform((v) => new Date(v).toISOString());

const optionalInstant = instant.nullable().optional();
const count = z.number().int().min(0).max(10_000).nullable().optional();

/** The saved filter of a PlatformAudience. Empty = every user the marketing rule allows. */
export const PlatformAudienceFilter = z
  .object({
    /** Plan keys: people in any workspace whose billing account is on one of these plans. */
    plans: z.array(z.string().trim().min(1).max(60)).max(30).default([]),
    /** Subscription statuses of that same subscription (combined with `plans` when both are set). */
    subscriptionStatuses: z.array(z.enum(SUBSCRIPTION_STATUSES)).max(SUBSCRIPTION_STATUSES.length).default([]),
    signedUpAfter: optionalInstant,
    signedUpBefore: optionalInstant,
    lastLoginAfter: optionalInstant,
    lastLoginBefore: optionalInstant,
    /** Workspaces the person is a member of. */
    workspacesMin: count,
    workspacesMax: count,
    /** Any of these profile tags. */
    tagsAny: z
      .array(z.string().max(60).transform(normalizeUserTag))
      .max(20)
      .refine((tags) => tags.every((t) => USER_TAG_PATTERN.test(t)), "Tags use letters, digits and - _ : . (up to 40 characters)")
      .default([]),
    signupSources: z.array(z.enum(SIGNUP_SOURCES)).max(SIGNUP_SOURCES.length).default([]),
  })
  .refine((f) => f.workspacesMin == null || f.workspacesMax == null || f.workspacesMin <= f.workspacesMax, {
    message: "The minimum workspace count is above the maximum",
    path: ["workspacesMax"],
  });
export type PlatformAudienceFilter = z.infer<typeof PlatformAudienceFilter>;

export const PlatformAudienceInput = z.object({
  name: z.string().trim().min(1, "Name the audience").max(120),
  filter: PlatformAudienceFilter,
});
export const PlatformAudienceUpdate = PlatformAudienceInput.partial();
export const PlatformAudiencePreviewInput = z.object({ filter: PlatformAudienceFilter });

// ─── Content ─────────────────────────────────────────────────────────────────

/** Tokens a broadcast or drip step may use. `unsubscribe_url` is also always in the footer. */
export const PLATFORM_MARKETING_VARIABLES = [
  { key: "product_name", label: "Product name", sample: "Growthdesk" },
  { key: "support_email", label: "Support email", sample: "support@example.com" },
  { key: "name", label: "Recipient's name", sample: "Alex" },
  { key: "unsubscribe_url", label: "Unsubscribe link", sample: "https://app.example.com/email-preferences/…" },
] as const;

export const PlatformMarketingPreviewInput = z.object({
  subject: z.string().max(300).default(""),
  preheader: z.string().max(300).default(""),
  blocks: EmailBlocks.default([]),
});

// ─── Broadcasts ──────────────────────────────────────────────────────────────

export const PLATFORM_BROADCAST_STATUSES = ["draft", "scheduled", "sending", "sent", "canceled", "failed"] as const;
export type PlatformBroadcastStatus = (typeof PLATFORM_BROADCAST_STATUSES)[number];

export const PlatformBroadcastInput = z.object({
  name: z.string().trim().min(1, "Name the broadcast").max(160),
  audienceId: z.string().uuid().nullable().optional(),
  subject: z.string().trim().max(300).optional(),
  preheader: z.string().trim().max(300).optional(),
  blocks: EmailBlocks.optional(),
});
export const PlatformBroadcastUpdate = PlatformBroadcastInput.partial();

export const PlatformBroadcastsQuery = z.object({
  status: z.enum(PLATFORM_BROADCAST_STATUSES).optional(),
});

/** `now: true` starts it right away; otherwise `at` (an instant in the future). */
export const PlatformBroadcastScheduleInput = z
  .object({ at: instant.optional(), now: z.boolean().optional() })
  .refine((v) => v.now === true || Boolean(v.at), { message: "Choose a time, or send now", path: ["at"] });

// ─── Drip sequences ──────────────────────────────────────────────────────────

export const PLATFORM_DRIP_TRIGGERS = ["signup", "verified", "trial_started", "trial_ending", "trial_ended"] as const;
export type PlatformDripTrigger = (typeof PLATFORM_DRIP_TRIGGERS)[number];

export const PLATFORM_DRIP_TRIGGER_LABELS: Record<PlatformDripTrigger, { label: string; description: string }> = {
  signup: { label: "Signed up", description: "When the account is created" },
  verified: { label: "Verified email", description: "When the email address is confirmed" },
  trial_started: { label: "Trial started", description: "When a trial begins (sent to the billing account owner)" },
  trial_ending: { label: "Trial ending", description: "3 days before the trial ends (billing account owner)" },
  trial_ended: { label: "Trial ended", description: "When a trial ends without converting (billing account owner)" },
};

/** The longest delay a step may have: 90 days. */
export const PLATFORM_DRIP_MAX_DELAY_HOURS = 90 * 24;

export const PlatformDripSequenceInput = z.object({
  name: z.string().trim().min(1, "Name the sequence").max(160),
  trigger: z.enum(PLATFORM_DRIP_TRIGGERS),
});
export const PlatformDripSequenceUpdate = PlatformDripSequenceInput.partial();

export const PlatformDripStepInput = z.object({
  delayHours: z.number().int().min(0).max(PLATFORM_DRIP_MAX_DELAY_HOURS),
  subject: z.string().trim().max(300).default(""),
  preheader: z.string().trim().max(300).default(""),
  blocks: EmailBlocks.default([]),
});
export const PlatformDripStepUpdate = z.object({
  delayHours: z.number().int().min(0).max(PLATFORM_DRIP_MAX_DELAY_HOURS).optional(),
  subject: z.string().trim().max(300).optional(),
  preheader: z.string().trim().max(300).optional(),
  blocks: EmailBlocks.optional(),
});
export const PlatformDripStepOrderInput = z.object({ stepIds: z.array(z.string().uuid()).min(1).max(50) });

// ─── Subscribers & preferences ───────────────────────────────────────────────

export const PLATFORM_SUBSCRIBER_TABS = ["consented", "unsubscribed", "suppressed"] as const;
export type PlatformSubscriberTab = (typeof PLATFORM_SUBSCRIBER_TABS)[number];

export const PlatformSubscribersQuery = z.object({
  tab: z.enum(PLATFORM_SUBSCRIBER_TABS).default("consented"),
  q: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

/** PUT /auth/me/email-preferences */
export const EmailPreferencesInput = z.object({ marketingConsent: z.boolean() });

/** POST /platform-mail/u/:token — the page's button sends `via: "page"`; a mail app's one-click POST sends the RFC 8058 form body. */
export const PlatformUnsubscribeInput = z
  .object({
    via: z.enum(["page"]).optional(),
    "List-Unsubscribe": z.string().max(100).optional(),
  })
  .passthrough();

/** GET /platform-mail/u/:token/details — what the preferences page shows. */
export type PlatformEmailPreferencesDetails = {
  email: string;
  productName: string;
  /** Receiving product emails now. */
  subscribed: boolean;
  /** A hard bounce or complaint stopped marketing; it cannot be turned back on from the page. */
  suppressed: boolean;
};
