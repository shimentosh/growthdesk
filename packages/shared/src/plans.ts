/*
 * Plan limits and feature entitlements.
 *
 * Plans are database rows edited in the platform admin; these are the keys a
 * plan may set and the starting catalogue the seed writes. Prices here are
 * placeholders for a fresh install — nothing in the business logic reads a
 * price from this file.
 */

export const LIMIT_KEYS = [
  "contacts",
  "seats",
  "mailboxes",
  "workspaces",
  "monthlyEmails",
  "monthlyAiCredits",
  "activeCampaigns",
  "channelIntegrations",
  "marketingContacts",
  "monthlyMarketingEmails",
  "sendingDomains",
] as const;
export type LimitKey = (typeof LIMIT_KEYS)[number];
export type PlanLimits = Record<LimitKey, number>;

export const LIMIT_LABELS: Record<LimitKey, string> = {
  contacts: "Contacts",
  seats: "Team members",
  mailboxes: "Connected mailboxes",
  workspaces: "Workspaces",
  monthlyEmails: "Emails per month",
  monthlyAiCredits: "AI credits per month",
  activeCampaigns: "Active campaigns",
  channelIntegrations: "WhatsApp / Telegram / calling connections",
  marketingContacts: "Marketing subscribers",
  monthlyMarketingEmails: "Marketing emails per month",
  sendingDomains: "Marketing sending domains",
};

/** Limits that are monthly allowances (metered) rather than counts of rows. */
export const METERED_LIMITS: readonly LimitKey[] = ["monthlyEmails", "monthlyAiCredits", "monthlyMarketingEmails"];

export const FEATURE_KEYS = [
  "multichannel",
  "branching",
  "automation",
  "ai",
  "advancedReporting",
  "apiAccess",
  "webhooks",
  "calling",
  "whatsapp",
  "telegram",
  "customRoles",
  "marketing",
] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];
export type PlanFeatures = Record<FeatureKey, boolean>;

export const FEATURE_LABELS: Record<FeatureKey, string> = {
  multichannel: "Multichannel sequences (WhatsApp, Telegram, call steps)",
  branching: "Conditional branches in sequences",
  automation: "Workflow automation",
  ai: "AI sales assistant",
  advancedReporting: "Advanced reporting & team performance",
  apiAccess: "API access & Business OS import",
  webhooks: "Outgoing webhooks",
  calling: "Calling workspace",
  whatsapp: "WhatsApp integration",
  telegram: "Telegram integration",
  customRoles: "Custom role permissions",
  marketing: "Email marketing (lists, campaigns, sending domains)",
};

export const UNLIMITED = -1;
export const isUnlimited = (n: number) => n < 0;

export type PlanSeed = {
  key: string;
  name: string;
  description: string;
  sortOrder: number;
  monthlyPriceCents: number;
  annualPriceCents: number;
  trialDays: number;
  limits: PlanLimits;
  features: PlanFeatures;
};

const none: PlanFeatures = {
  multichannel: false,
  branching: false,
  automation: false,
  ai: false,
  advancedReporting: false,
  apiAccess: false,
  webhooks: false,
  calling: false,
  whatsapp: false,
  telegram: false,
  customRoles: false,
  marketing: false,
};

export const DEFAULT_PLANS: PlanSeed[] = [
  {
    key: "free",
    name: "Free",
    description: "For trying Growthdesk with a single mailbox.",
    sortOrder: 0,
    monthlyPriceCents: 0,
    annualPriceCents: 0,
    trialDays: 0,
    limits: {
      contacts: 250,
      seats: 1,
      mailboxes: 1,
      workspaces: 1,
      monthlyEmails: 500,
      monthlyAiCredits: 25,
      activeCampaigns: 1,
      channelIntegrations: 0,
      marketingContacts: 250,
      monthlyMarketingEmails: 1000,
      sendingDomains: 1,
    },
    features: { ...none, calling: true, ai: true, marketing: true },
  },
  {
    key: "starter",
    name: "Starter",
    description: "Email campaigns and follow-up sequences for a solo seller.",
    sortOrder: 1,
    monthlyPriceCents: 2900,
    annualPriceCents: 29000,
    trialDays: 14,
    limits: {
      contacts: 5000,
      seats: 2,
      mailboxes: 3,
      workspaces: 1,
      monthlyEmails: 10000,
      monthlyAiCredits: 200,
      activeCampaigns: 10,
      channelIntegrations: 2,
      marketingContacts: 2500,
      monthlyMarketingEmails: 25000,
      sendingDomains: 1,
    },
    features: { ...none, calling: true, ai: true, whatsapp: true, telegram: true, apiAccess: true, marketing: true },
  },
  {
    key: "growth",
    name: "Growth",
    description: "Multichannel sequences, automation and team collaboration.",
    sortOrder: 2,
    monthlyPriceCents: 7900,
    annualPriceCents: 79000,
    trialDays: 14,
    limits: {
      contacts: 25000,
      seats: 5,
      mailboxes: 10,
      workspaces: 2,
      monthlyEmails: 50000,
      monthlyAiCredits: 1000,
      activeCampaigns: UNLIMITED,
      channelIntegrations: 5,
      marketingContacts: 15000,
      monthlyMarketingEmails: 150000,
      sendingDomains: 3,
    },
    features: {
      ...none,
      multichannel: true,
      branching: true,
      automation: true,
      ai: true,
      advancedReporting: true,
      apiAccess: true,
      webhooks: true,
      calling: true,
      whatsapp: true,
      telegram: true,
      marketing: true,
    },
  },
  {
    key: "agency",
    name: "Agency",
    description: "Several client workspaces, larger allowances and custom roles.",
    sortOrder: 3,
    monthlyPriceCents: 19900,
    annualPriceCents: 199000,
    trialDays: 14,
    limits: {
      contacts: 100000,
      seats: 20,
      mailboxes: 50,
      workspaces: 10,
      monthlyEmails: 200000,
      monthlyAiCredits: 5000,
      activeCampaigns: UNLIMITED,
      channelIntegrations: 20,
      marketingContacts: 50000,
      monthlyMarketingEmails: 500000,
      sendingDomains: 10,
    },
    features: Object.fromEntries(Object.keys(none).map((k) => [k, true])) as PlanFeatures,
  },
];

export function readLimits(raw: unknown): PlanLimits {
  const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return Object.fromEntries(
    LIMIT_KEYS.map((k) => [k, typeof src[k] === "number" ? (src[k] as number) : 0]),
  ) as PlanLimits;
}

export function readFeatures(raw: unknown): PlanFeatures {
  const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return Object.fromEntries(FEATURE_KEYS.map((k) => [k, src[k] === true])) as PlanFeatures;
}

/** The access a subscription state grants. Documented in docs/BILLING.md. */
export type AccessLevel = "full" | "restricted";

export const formatMoney = (cents: number, currency = "USD") =>
  new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: cents % 100 ? 2 : 0 }).format(
    cents / 100,
  );
