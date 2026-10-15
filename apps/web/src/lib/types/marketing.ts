/*
 * Email marketing. Kept in step with apps/api/src/marketing/*.service.ts
 * (lists `dto()` + `counts`, setup `espDto()` / `domainDto()`, designs `dto`,
 * campaigns `dto()`, recipients) and the inputs in packages/shared/src/marketing.ts.
 */
import type {
  ConsentStatus,
  EmailBlock,
  EmailTheme,
  EspProvider,
  ListMembershipStatus,
  MarketingAudienceT,
  MarketingCampaignStatus,
  MarketingSendStatus,
  SendingDomainStatus,
} from "@growthdesk/shared";

export type Paged<T> = { items: T[]; total: number; page: number; pageSize: number };

// ─── Lists ──────────────────────────────────────────────────────────────────

/** GET marketing/lists, GET marketing/lists/:id. */
export type MarketingList = {
  id: string;
  name: string;
  description: string;
  /** New people without recorded consent join as pending and must confirm by email. */
  doubleOptIn: boolean;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  counts: { subscribed: number; unsubscribed: number; pending: number };
};

/** GET marketing/lists/:id/members (paged). */
export type ListMember = {
  id: string;
  status: ListMembershipStatus;
  source: string;
  subscribedAt: string | null;
  unsubscribedAt: string | null;
  createdAt: string;
  contact: { id: string; fullName: string; email: string | null; consentStatus: ConsentStatus };
};

/** Why POST marketing/lists/:id/members left a contact out. */
export const SKIP_REASONS = ["not_found", "no_email", "do_not_contact", "no_consent", "consent_denied", "suppressed", "unsubscribed"] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

/** POST marketing/lists/:id/members answer. */
export type AddMembersResult = {
  added: number;
  /** Added (or already waiting) on a double opt-in list: sent an email to confirm, not subscribed yet. */
  pending: number;
  alreadyMember: number;
  skipped: Record<SkipReason, number>;
};

/** POST marketing/lists/:id/members/remove answer. Unsubscribed rows are kept, so they cannot be added back. */
export type RemoveMembersResult = { removed: number; keptUnsubscribed: number };

/** GET marketing/contacts/:contactId/lists. */
export type ContactListMembership = {
  id: string;
  status: ListMembershipStatus;
  source: string;
  subscribedAt: string | null;
  unsubscribedAt: string | null;
  list: { id: string; name: string; archivedAt: string | null };
};

// ─── Sending setup ──────────────────────────────────────────────────────────

export type EspConnection = {
  id: string;
  provider: EspProvider;
  host: string;
  port: number;
  security: "ssl" | "starttls" | "none";
  username: string;
  region: string | null;
  hasPassword: boolean;
  status: "connected" | "error" | "disconnected";
  lastError: string;
  lastCheckedAt: string | null;
  /** Where the email service posts bounces and complaints. */
  webhookUrl: string;
};

export type DnsRecordCheck = { ok: boolean; found: string[]; expected: string; required: boolean };
export type DnsRecord = { type: string; name: string; value: string };
/** A record the email service asks for (Resend). `name` is relative to the DNS zone, as Resend shows it. */
export type EspDnsRecord = { record: string; name: string; type: string; ttl: string; status: string; value: string; priority: number | null };

export type SendingDomain = {
  id: string;
  domain: string;
  status: SendingDomainStatus;
  dkimSelectors: string[];
  /** Empty until the first check. */
  checks: Partial<{ ownership: DnsRecordCheck; dkim: DnsRecordCheck; dmarc: DnsRecordCheck; spf: DnsRecordCheck }>;
  records: { ownership: DnsRecord; dmarc: DnsRecord };
  /** The email service's own view when it manages the domain (Resend): its status and the records it asks for. */
  esp: { status: string; records: EspDnsRecord[] } | null;
  lastCheckedAt: string | null;
  verifiedAt: string | null;
  pausedAt: string | null;
  pausedReason: string;
  createdAt: string;
};

/** GET marketing/setup. `dnsChecksSkipped` is true in development (MARKETING_SKIP_DNS_CHECKS). */
export type MarketingSetup = { esp: EspConnection | null; domains: SendingDomain[]; dnsChecksSkipped: boolean };

// ─── Designs ────────────────────────────────────────────────────────────────

/** GET marketing/designs, GET/POST/PATCH marketing/designs/:id. `fromLibrary`: seeded from the built-in library (still editable). */
export type EmailDesign = {
  id: string;
  name: string;
  blocks: EmailBlock[];
  /** Colours, fonts and corners; {} renders with the defaults. */
  theme: EmailTheme;
  fromLibrary: boolean;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** GET /marketing/design-library: the template gallery platform staff curate. */
export type LibraryTemplate = {
  id: string;
  key: string;
  name: string;
  description: string;
  category: string;
  theme: EmailTheme;
  blocks: EmailBlock[];
  sortOrder: number;
};

// ─── Campaigns ──────────────────────────────────────────────────────────────

export type MarketingCampaignStats = {
  recipients: number;
  sent: number;
  failed: number;
  skipped: number;
  uniqueOpens: number;
  uniqueClicks: number;
  unsubscribes: number;
  bounces: number;
  complaints: number;
};

/** GET marketing/campaigns, GET/POST/PATCH marketing/campaigns/:id — `dto()`. */
export type MarketingCampaign = {
  id: string;
  name: string;
  status: MarketingCampaignStatus;
  subject: string;
  preheader: string;
  fromName: string;
  fromLocalPart: string;
  /** fromLocalPart@domain once a sending domain is chosen. */
  fromEmail: string | null;
  replyTo: string;
  sendingDomainId: string | null;
  blocks: EmailBlock[];
  theme: EmailTheme;
  audience: { listIds: string[]; excludeListIds: string[]; viewId: string | null };
  trackOpens: boolean;
  trackClicks: boolean;
  scheduledAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  pausedAt: string | null;
  pausedReason: string;
  canceledAt: string | null;
  stats: MarketingCampaignStats;
  createdAt: string;
  updatedAt: string;
};

/** PATCH marketing/campaigns/:id body (drafts only; anything else answers 409). */
export type MarketingCampaignPatch = Partial<{
  name: string;
  subject: string;
  preheader: string;
  fromName: string;
  fromLocalPart: string;
  replyTo: string;
  sendingDomainId: string | null;
  /** Copies that design's blocks and theme into the campaign. */
  designId: string | null;
  blocks: EmailBlock[];
  theme: EmailTheme;
  audience: MarketingAudienceT;
  trackOpens: boolean;
  trackClicks: boolean;
}>;

/** GET marketing/campaigns/:id/readiness. */
export type CampaignReadiness = { ready: boolean; problems: string[]; recipients: number };

/** GET marketing/campaigns/:id/recipients (paged). */
export type CampaignRecipient = {
  id: string;
  email: string;
  contact: { id: string; fullName: string } | null;
  status: MarketingSendStatus;
  error: string;
  sentAt: string | null;
  openedAt: string | null;
  clickedAt: string | null;
  unsubscribedAt: string | null;
  bouncedAt: string | null;
  complainedAt: string | null;
};

/** POST marketing/campaigns/:id/test answer. */
export type TestSendResult = { results: { email: string; sent: boolean; error?: string }[] };
