import { z } from "zod";
import { email, requiredText, text } from "./schemas.js";
import { EmailBlocks, EmailTheme } from "./email-design.js";

/*
 * Email marketing: lists, sending setup, campaigns and the public preference
 * page. The rules these serve are R1–R5 in docs/PRODUCT_PLAN.md.
 */

export const LIST_MEMBERSHIP_STATUSES = ["subscribed", "unsubscribed", "pending"] as const;
export type ListMembershipStatus = (typeof LIST_MEMBERSHIP_STATUSES)[number];
export const ESP_PROVIDERS = ["ses", "smtp_relay"] as const;
export type EspProvider = (typeof ESP_PROVIDERS)[number];
export const SENDING_DOMAIN_STATUSES = ["pending", "verified", "failed"] as const;
export type SendingDomainStatus = (typeof SENDING_DOMAIN_STATUSES)[number];
export const MARKETING_CAMPAIGN_STATUSES = ["draft", "scheduled", "sending", "paused", "sent", "canceled"] as const;
export type MarketingCampaignStatus = (typeof MARKETING_CAMPAIGN_STATUSES)[number];
export const MARKETING_SEND_STATUSES = ["queued", "sent", "failed", "skipped", "bounced", "complained"] as const;
export type MarketingSendStatus = (typeof MARKETING_SEND_STATUSES)[number];

/** SES SMTP regions offered in the connect form. */
export const SES_REGIONS = ["us-east-1", "us-east-2", "us-west-2", "ca-central-1", "eu-west-1", "eu-west-2", "eu-central-1", "eu-north-1", "ap-south-1", "ap-southeast-1", "ap-southeast-2", "ap-northeast-1", "sa-east-1"] as const;

/** Deliverability guardrail (R5): a campaign or domain pauses past these rates, once enough mail went out to judge. */
export const GUARDRAIL = { minSample: 100, maxBounceRate: 0.02, maxComplaintRate: 0.003 } as const;

const uuid = z.string().uuid();
const domainName = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^(?=.{1,253}$)(?!-)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/, "Enter a domain like news.yourbrand.com");

// ─── Lists ──────────────────────────────────────────────────────────────────

export const MarketingListInput = z.object({
  name: requiredText(120),
  description: text(500).optional(),
});

/**
 * Adds contacts to a list. Marketing needs recorded consent (R2): contacts
 * without it are skipped, unless the person adding them confirms consent was
 * given and says where — that is then recorded as the contact's consent.
 */
export const ListMembersAdd = z.object({
  contactIds: z.array(uuid).min(1).max(5000),
  consent: z
    .object({
      confirmed: z.literal(true),
      source: requiredText(200),
    })
    .optional(),
});
export const ListMembersRemove = z.object({ contactIds: z.array(uuid).min(1).max(5000) });
export const ListMembersQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  status: z.enum(LIST_MEMBERSHIP_STATUSES).optional(),
  q: text(200).optional(),
});

// ─── Sending setup ──────────────────────────────────────────────────────────

export const EspConnectionInput = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("ses"),
    region: z.enum(SES_REGIONS),
    username: requiredText(200),
    /** Omit to keep the stored one. */
    password: z.string().min(1).max(500).optional(),
  }),
  z.object({
    provider: z.literal("smtp_relay"),
    host: requiredText(253),
    port: z.coerce.number().int().min(1).max(65535).default(587),
    security: z.enum(["ssl", "starttls", "none"]).default("starttls"),
    username: text(200).default(""),
    password: z.string().max(500).optional(),
  }),
]);

export const SendingDomainInput = z.object({
  domain: domainName,
  dkimSelectors: z.array(z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{1,63}$/, "Letters, digits, dots, dashes")).max(5).default([]),
});
export const SendingDomainUpdate = z.object({
  dkimSelectors: z.array(z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{1,63}$/, "Letters, digits, dots, dashes")).max(5).optional(),
  /** false clears a pause (by hand or the guardrail). */
  paused: z.literal(false).optional(),
});

// ─── Designs & campaigns ────────────────────────────────────────────────────

export const EmailDesignInput = z.object({
  name: requiredText(120),
  blocks: EmailBlocks.optional(),
  theme: EmailTheme.optional(),
});

export const MarketingAudience = z.object({
  listIds: z.array(uuid).max(50).default([]),
  excludeListIds: z.array(uuid).max(50).default([]),
  /** A saved contact view, used as a segment: only list members it matches are included. */
  viewId: uuid.nullable().optional(),
});
export type MarketingAudienceT = z.infer<typeof MarketingAudience>;

export const MarketingCampaignInput = z.object({
  name: requiredText(120),
  subject: text(250).optional(),
  preheader: text(250).optional(),
  fromName: text(120).optional(),
  fromLocalPart: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9._+-]{1,64}$/, "Letters, digits and . _ + - only")
    .optional()
    .or(z.literal("")),
  replyTo: z.union([email, z.literal("")]).optional(),
  sendingDomainId: uuid.nullable().optional(),
  /** Copies this design's blocks and theme into the campaign. */
  designId: uuid.nullable().optional(),
  blocks: EmailBlocks.optional(),
  theme: EmailTheme.optional(),
  audience: MarketingAudience.optional(),
  trackOpens: z.boolean().optional(),
  trackClicks: z.boolean().optional(),
});
export type MarketingCampaignInputT = z.infer<typeof MarketingCampaignInput>;

export const MarketingSendInput = z.object({
  /** Omit to send now. */
  scheduledAt: z.coerce.date().optional(),
});
export const MarketingTestInput = z.object({ emails: z.array(email).min(1).max(5) });
export const MarketingRecipientsQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  status: z.enum(MARKETING_SEND_STATUSES).optional(),
});

// ─── Public preference page ─────────────────────────────────────────────────

export const PreferencesUpdate = z.object({
  /** Leave every list and record withdrawn consent. */
  unsubscribeAll: z.boolean().optional(),
  lists: z.array(z.object({ listId: uuid, subscribed: z.boolean() })).max(100).optional(),
});

export type PreferencesDetails = {
  email: string;
  workspaceName: string;
  legalName: string;
  unsubscribedFromAll: boolean;
  lists: { id: string; name: string; description: string; subscribed: boolean }[];
};

/** Bounce/complaint notifications in Growthdesk's own format (any ESP can be bridged to it). */
export const EspEventInput = z.object({
  type: z.enum(["bounce", "complaint"]),
  /** Only permanent bounces suppress; transient ones are counted, not acted on. */
  bounceType: z.enum(["permanent", "transient"]).default("permanent"),
  email,
  providerMessageId: text(300).optional(),
  sendId: uuid.optional(),
});
