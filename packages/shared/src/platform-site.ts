import { z } from "zod";

/*
 * The public website's editable content — the contract between the API
 * (apps/api/src/site), the customer web app (the (public) route group) and
 * the super-admin's "Website" pages.
 *
 * Each key is one PlatformSiteContent row with a draft and a published copy.
 * A key that was never published serves the defaults below, which describe
 * the product as it is built today (docs/PRODUCT_PLAN.md) — no customers,
 * testimonials or numbers that do not exist.
 *
 * Text fields may use {{product_name}}; the public endpoints replace it with
 * the published branding's product name, so renaming the product does not
 * leave the old name behind on the landing page or in the legal pages.
 */

export const SITE_CONTENT_KEYS = ["branding", "landing", "legal.terms", "legal.privacy", "announcement", "seo", "analytics"] as const;
export type SiteContentKey = (typeof SITE_CONTENT_KEYS)[number];

export const LEGAL_SLUGS = ["terms", "privacy"] as const;
export type LegalSlug = (typeof LEGAL_SLUGS)[number];

export const PRODUCT_NAME_TOKEN = "{{product_name}}";

// ─── Building blocks ─────────────────────────────────────────────────────────

const text = (max: number) => z.string().trim().max(max);
const required = (max: number) => z.string().trim().min(1, "Required").max(max);

/**
 * A link a visitor can follow: a path on this site ("/register", "#faq"), or
 * an http(s)/mailto URL. Never javascript: or data:.
 */
export const SiteHref = z
  .string()
  .trim()
  .max(500)
  .refine((v) => /^(\/(?!\/)|#|https?:\/\/[^\s]+$|mailto:[^\s@]+@[^\s@]+$)/i.test(v) && !/\s/.test(v), {
    message: "Use a path starting with / or #, or an http(s):// or mailto: link",
  });
const optionalHref = z.union([z.literal(""), SiteHref]);

export const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const assetId = z.uuid("Not an uploaded asset").nullable();

export const SiteCta = z.object({ label: required(40), href: SiteHref });
export type SiteCta = z.infer<typeof SiteCta>;

/** Icons a landing feature may use — lucide-react names in kebab case; the web app maps each one. */
export const LANDING_ICONS = [
  "mail",
  "send",
  "inbox",
  "users",
  "contact",
  "building",
  "workflow",
  "git-branch",
  "sparkles",
  "bot",
  "chart-column",
  "chart-line",
  "trending-up",
  "phone",
  "message-circle",
  "megaphone",
  "shield-check",
  "lock",
  "zap",
  "target",
  "calendar-check",
  "list-checks",
  "kanban",
  "globe",
  "layers",
  "gauge",
  "filter",
  "database",
  "webhook",
  "key-round",
  "clock",
  "repeat",
  "handshake",
  "plug",
  "rocket",
  "file-text",
] as const;
export type LandingIcon = (typeof LANDING_ICONS)[number];

// ─── Schemas, one per key ────────────────────────────────────────────────────

export const BrandingContent = z.object({
  productName: required(60),
  /** "" = none shown. */
  supportEmail: z.union([z.literal(""), z.email("Not an email address").max(254)]),
  /** #rrggbb, or "" for the design-system blue. */
  primaryColor: z.union([z.literal(""), z.string().regex(HEX_COLOR, "Use a #rrggbb colour")]),
  logoAssetId: assetId,
  faviconAssetId: assetId,
  /** Default social-share image; seo.ogAssetId overrides it. */
  ogAssetId: assetId,
});
export type BrandingContent = z.infer<typeof BrandingContent>;

const section = <T extends z.ZodTypeAny>(item: T, max: number) =>
  z.object({ title: text(120), subtitle: text(300), items: z.array(item).max(max) });

export const LandingContent = z.object({
  hero: z.object({
    eyebrow: text(80),
    headline: required(140),
    subheadline: text(400),
    primaryCta: SiteCta,
    secondaryCta: SiteCta.nullable(),
  }),
  /** A strip of short text items (what it works with, who it is for) — not logos of customers. */
  socialProof: z.object({ title: text(120), items: z.array(required(60)).max(12) }),
  features: section(z.object({ icon: z.enum(LANDING_ICONS), title: required(80), body: required(400) }), 12),
  steps: section(z.object({ title: required(80), body: required(400) }), 6),
  /** Empty by default: only real quotes from real people belong here. */
  testimonials: section(z.object({ quote: required(600), name: required(80), role: text(120) }), 9),
  faq: section(z.object({ q: required(200), a: required(2000) }), 20),
  finalCta: z.object({
    headline: required(140),
    body: text(400),
    primaryCta: SiteCta,
    secondaryCta: SiteCta.nullable(),
  }),
});
export type LandingContent = z.infer<typeof LandingContent>;

export const LEGAL_MARKDOWN_MAX = 100_000;
export const LegalContent = z.object({
  title: required(120),
  /** Markdown only — the site renders it without raw HTML. */
  markdown: required(LEGAL_MARKDOWN_MAX),
  /** Free text shown under the title, e.g. "Last updated 1 October 2026". */
  updatedLabel: text(80),
});
export type LegalContent = z.infer<typeof LegalContent>;

export const ANNOUNCEMENT_TONES = ["info", "warning", "success"] as const;
export const ANNOUNCEMENT_AUDIENCES = ["public", "app", "both"] as const;
export const AnnouncementContent = z
  .object({
    enabled: z.boolean(),
    message: text(280),
    href: optionalHref,
    tone: z.enum(ANNOUNCEMENT_TONES),
    /** public = the marketing site, app = signed-in pages, both = everywhere. */
    audience: z.enum(ANNOUNCEMENT_AUDIENCES),
    dismissible: z.boolean(),
  })
  .refine((a) => !a.enabled || a.message.length > 0, { message: "An enabled announcement needs a message", path: ["message"] });
export type AnnouncementContent = z.infer<typeof AnnouncementContent>;

export const SeoContent = z.object({
  /** "" = the product name. */
  title: text(70),
  description: text(200),
  /** Overrides branding.ogAssetId. */
  ogAssetId: assetId,
});
export type SeoContent = z.infer<typeof SeoContent>;

export const ANALYTICS_PROVIDERS = ["none", "plausible", "ga4"] as const;
export const PLAUSIBLE_DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export const GA4_MEASUREMENT_ID = /^G-[A-Z0-9]{4,15}$/;
export const AnalyticsContent = z
  .object({
    provider: z.enum(ANALYTICS_PROVIDERS),
    /** The site's domain as registered in Plausible (plausible.io), e.g. "growthdesk.com". */
    plausibleDomain: z.union([z.literal(""), z.string().trim().toLowerCase().regex(PLAUSIBLE_DOMAIN, "Use a domain such as example.com")]),
    /** "G-XXXXXXX". */
    ga4MeasurementId: z.union([z.literal(""), z.string().trim().toUpperCase().regex(GA4_MEASUREMENT_ID, "Use a GA4 measurement ID such as G-AB12CD34")]),
  })
  .refine((a) => a.provider !== "plausible" || a.plausibleDomain !== "", { message: "Plausible needs the site's domain", path: ["plausibleDomain"] })
  .refine((a) => a.provider !== "ga4" || a.ga4MeasurementId !== "", { message: "GA4 needs a measurement ID", path: ["ga4MeasurementId"] });
export type AnalyticsContent = z.infer<typeof AnalyticsContent>;

export const SITE_CONTENT_SCHEMAS = {
  branding: BrandingContent,
  landing: LandingContent,
  "legal.terms": LegalContent,
  "legal.privacy": LegalContent,
  announcement: AnnouncementContent,
  seo: SeoContent,
  analytics: AnalyticsContent,
} as const satisfies Record<SiteContentKey, z.ZodTypeAny>;

export type SiteContentMap = {
  branding: BrandingContent;
  landing: LandingContent;
  "legal.terms": LegalContent;
  "legal.privacy": LegalContent;
  announcement: AnnouncementContent;
  seo: SeoContent;
  analytics: AnalyticsContent;
};

// ─── Assets ──────────────────────────────────────────────────────────────────

export const SITE_ASSET_KINDS = ["logo", "favicon", "og"] as const;
export type SiteAssetKind = (typeof SITE_ASSET_KINDS)[number];
export const SITE_ASSET_MIMES = ["image/png", "image/jpeg", "image/webp", "image/x-icon"] as const;
export type SiteAssetMime = (typeof SITE_ASSET_MIMES)[number];
export const SITE_ASSET_MAX_BYTES = 256 * 1024;

/**
 * An upload as JSON: the file's bytes in base64 (a data: URL is accepted
 * too). The server checks the size, sniffs the real type from the magic
 * bytes, and refuses SVG and anything else that is not PNG/JPEG/WebP/ICO.
 */
export const SiteAssetUploadInput = z.object({
  kind: z.enum(SITE_ASSET_KINDS),
  /** What the browser said the file is; must agree with the bytes when given. */
  mime: z.string().trim().max(100).optional(),
  data: z.string().min(1, "Choose a file").max(Math.ceil((SITE_ASSET_MAX_BYTES * 4) / 3) + 200, "The file is larger than 256 KB"),
});

// ─── Defaults ────────────────────────────────────────────────────────────────

export const DEFAULT_SITE_BRANDING: BrandingContent = {
  productName: "Growthdesk",
  supportEmail: "",
  primaryColor: "",
  logoAssetId: null,
  faviconAssetId: null,
  ogAssetId: null,
};

export const DEFAULT_SITE_LANDING: LandingContent = {
  hero: {
    eyebrow: "Outreach · Email marketing · CRM",
    headline: "One workspace for the whole revenue journey",
    subheadline:
      "Run outbound sequences from your own mailboxes, send email marketing to people who opted in, and work every reply and deal from one shared CRM.",
    primaryCta: { label: "Get started", href: "/register" },
    secondaryCta: { label: "See pricing", href: "/pricing" },
  },
  socialProof: {
    title: "Works with the tools you already use",
    items: ["Gmail", "Microsoft 365", "Any SMTP & IMAP mailbox", "WhatsApp", "Telegram", "Twilio calling", "Amazon SES"],
  },
  features: {
    title: "Everything between first touch and closed deal",
    subtitle: "Outreach, marketing and sales share one contact record, one automation engine and one set of reports.",
    items: [
      {
        icon: "send",
        title: "Multichannel sequences",
        body: "Email steps from connected mailboxes, plus WhatsApp, Telegram and call tasks, with waits, branches and daily sending limits per mailbox.",
      },
      {
        icon: "inbox",
        title: "Unified inbox",
        body: "Replies from email, WhatsApp and Telegram land in one inbox. Assign conversations, add notes and turn a reply into a task.",
      },
      {
        icon: "contact",
        title: "Shared CRM",
        body: "Contacts and companies with tags, custom fields, saved views, CSV import and duplicate merge, plus a full activity timeline.",
      },
      {
        icon: "megaphone",
        title: "Email marketing",
        body: "Lists, a block-based email designer and campaigns for contacts with recorded consent, sent from your own verified sending domain.",
      },
      {
        icon: "kanban",
        title: "Pipeline & deals",
        body: "Pipelines with stages, deals, meetings and tasks, so every positive reply has somewhere to go.",
      },
      {
        icon: "workflow",
        title: "Workflow automation",
        body: "Trigger actions on events such as a reply, a won deal or a booked meeting, and notify other systems with signed webhooks.",
      },
      {
        icon: "phone",
        title: "Calling",
        body: "Call from the browser through Twilio, follow call scripts and log outcomes against the contact.",
      },
      {
        icon: "sparkles",
        title: "AI assistance",
        body: "Draft replies and messages with an AI assistant, metered by plan so costs stay predictable.",
      },
      {
        icon: "shield-check",
        title: "Deliverability guardrails",
        body: "Outreach and marketing never share sending infrastructure. Suppression, one-click unsubscribe and bounce handling are built in.",
      },
    ],
  },
  steps: {
    title: "How it works",
    subtitle: "From sign-up to your first conversation in an afternoon.",
    items: [
      { title: "Connect your mailboxes", body: "Add Gmail, Microsoft 365 or any SMTP/IMAP mailbox, set daily limits and import your contacts." },
      { title: "Launch a sequence", body: "Write the steps, choose the audience and a sending window, and let the engine pace the sends." },
      { title: "Work the replies", body: "Replies arrive in the unified inbox; move interested contacts into the pipeline and follow up from there." },
    ],
  },
  testimonials: { title: "What customers say", subtitle: "", items: [] },
  faq: {
    title: "Frequently asked questions",
    subtitle: "",
    items: [
      {
        q: "Do I need to change my email provider?",
        a: "No. Outreach is sent from the mailboxes you connect — Gmail, Microsoft 365 or any SMTP/IMAP account — and replies are read back from them.",
      },
      {
        q: "Can I send newsletters to my cold leads?",
        a: "No. Email marketing only goes to contacts with recorded consent, and it is sent from a separate sending domain so outreach can never affect your newsletter deliverability.",
      },
      {
        q: "Is there a free trial?",
        a: "Paid plans include a free trial; the pricing page shows the length for each plan. There is also a free plan for trying {{product_name}} with a single mailbox.",
      },
      {
        q: "Can my team work in the same workspace?",
        a: "Yes. Invite teammates, give them roles and, on plans that include it, customise what each role may do.",
      },
      {
        q: "Can I connect {{product_name}} to other tools?",
        a: "Yes. Workspace API keys let other systems add leads, and outgoing webhooks notify your tools when contacts, deals and replies change.",
      },
      {
        q: "How do people unsubscribe?",
        a: "Every email carries a one-click unsubscribe link and header. Unsubscribes, bounces and complaints are suppressed automatically.",
      },
    ],
  },
  finalCta: {
    headline: "Start your first sequence today",
    body: "Create a workspace, connect a mailbox and send your first step in minutes.",
    primaryCta: { label: "Create your account", href: "/register" },
    secondaryCta: { label: "Compare plans", href: "/pricing" },
  },
};

export const DEFAULT_SITE_TERMS: LegalContent = {
  title: "Terms of Service",
  updatedLabel: "",
  markdown: `These terms govern your use of {{product_name}} (the "Service"). By creating an account or using the Service you agree to them. If you use the Service on behalf of an organisation, you agree on its behalf.

## 1. Your account

- You must give accurate sign-up information and keep your password safe.
- You are responsible for everything done through your account and your workspaces, including by teammates you invite and API keys you create.
- Tell us promptly if you believe your account has been accessed without permission.

## 2. Acceptable use

You may use the Service only for lawful sales and marketing communication. In particular you must not:

- send email marketing to people who have not given consent, or ignore unsubscribe requests;
- send spam, phishing, malware or deceptive content, or impersonate anyone;
- use purchased or scraped lists where the law of the recipient's country forbids it;
- try to get around plan limits, sending limits, suppression or any security measure;
- interfere with the Service or other customers' use of it.

You are responsible for complying with the laws that apply to your messages, including anti-spam and data-protection law (for example CAN-SPAM, CASL, the GDPR and the ePrivacy rules). We may pause sending, suspend a workspace or close an account that breaks these rules or puts the Service or its sending reputation at risk.

## 3. Your data

You keep all rights to the content and contact data you put into the Service ("Customer Data"). You give us permission to host, process and transmit Customer Data only as needed to provide the Service to you. You confirm you have the right to use the Customer Data you upload, including a lawful basis for contacting the people in it. See our [Privacy Policy](/privacy) for how personal data is handled.

## 4. Plans, billing and trials

- Paid plans are billed in advance for the chosen interval and renew automatically until cancelled.
- Plan limits (for example contacts, mailboxes and monthly sends) are enforced by the Service and shown on the [pricing page](/pricing).
- When a trial ends without a paid plan, or a payment fails and is not resolved, the account moves to a reduced plan as described in the product.
- Fees are exclusive of taxes unless stated otherwise.

## 5. Third-party services

The Service connects to services you choose, such as your email provider, WhatsApp, Telegram, Twilio and payment providers. Your use of those services is governed by their own terms.

## 6. Availability and changes

We work to keep the Service available and secure, but it is provided "as is" and may occasionally be unavailable, for example during maintenance. We may change or improve features; if a change materially reduces the Service you pay for, we will tell you in advance.

## 7. Liability

To the extent the law allows, we are not liable for indirect or consequential losses, lost profits or lost data, and our total liability for any claim is limited to the fees you paid for the Service in the twelve months before the claim.

## 8. Ending the agreement

You can stop using the Service and delete your account at any time. We may suspend or end your access if you materially breach these terms. After closure, Customer Data is deleted in line with our retention practices.

## 9. Changes to these terms

We may update these terms. We will post the new version here and, for material changes, notify account owners before they take effect.

## 10. Contact

Questions about these terms? Contact the {{product_name}} team using the support address shown at the bottom of this page.
`,
};

export const DEFAULT_SITE_PRIVACY: LegalContent = {
  title: "Privacy Policy",
  updatedLabel: "",
  markdown: `This policy explains what personal data {{product_name}} (the "Service") processes, why, and the choices you have.

## Two kinds of data

- **Account data** — information about you as a user of the Service: your name, email address, password (stored only as a hash), sign-in sessions, workspace membership, billing details and support requests. For this data we are the controller.
- **Customer Data** — the contacts, companies, messages and other records you and your team put into a workspace. For this data you are the controller and we process it on your behalf, only to provide the Service.

## What we collect and why

| Data | Purpose |
| --- | --- |
| Name, email, password hash | Creating and securing your account |
| Session cookie, IP address, browser user agent | Keeping you signed in, preventing abuse, security logs |
| Billing details | Charging for paid plans (card details are handled by our payment provider, not stored by us) |
| Usage of the product | Enforcing plan limits and operating the Service |
| Support conversations | Answering your questions |

## Cookies

The Service uses a small number of cookies that are needed for it to work: a session cookie that keeps you signed in and a preference cookie that remembers your light or dark appearance. If website analytics is enabled, the analytics provider shown in the page source may set or read its own identifiers.

## Emails we send you

We send account email (confirmations, password resets, invitations, billing notices) that is needed to run your account. Any product news we send can be turned off from the link in the email.

## Who we share data with

We share data only with service providers that help us run the Service — hosting, email delivery, payment processing and, where you turn them on, integrations such as WhatsApp, Telegram, Twilio and AI providers — and only as much as each needs. We do not sell personal data.

## Tracking in your emails

When you enable open and click tracking, emails you send include a tracking pixel and rewritten links so you can see engagement. Recipients can always unsubscribe with one click.

## Retention

Account data is kept while your account is active and for a limited period afterwards for legal and accounting reasons. Customer Data stays in your workspace until you delete it; when a workspace or account is closed, its data is deleted in line with our retention practices.

## Your rights

Depending on where you live, you may have the right to access, correct, export or delete your personal data, and to object to or restrict some processing. Contacts in a customer's workspace should contact that customer first. To exercise your rights, contact us at the support address at the bottom of this page.

## Security

Passwords are hashed, connection secrets are encrypted at rest, and access to customer workspaces is restricted and logged.

## Changes

We may update this policy and will post the new version here.
`,
};

export const DEFAULT_SITE_ANNOUNCEMENT: AnnouncementContent = {
  enabled: false,
  message: "",
  href: "",
  tone: "info",
  audience: "public",
  dismissible: true,
};

export const DEFAULT_SITE_SEO: SeoContent = {
  title: "",
  description:
    "Outbound sequences, email marketing and a shared CRM in one workspace: connect your mailboxes, reach people on email, WhatsApp and Telegram, and work every reply to a closed deal.",
  ogAssetId: null,
};

export const DEFAULT_SITE_ANALYTICS: AnalyticsContent = { provider: "none", plausibleDomain: "", ga4MeasurementId: "" };

export const SITE_DEFAULTS: SiteContentMap = {
  branding: DEFAULT_SITE_BRANDING,
  landing: DEFAULT_SITE_LANDING,
  "legal.terms": DEFAULT_SITE_TERMS,
  "legal.privacy": DEFAULT_SITE_PRIVACY,
  announcement: DEFAULT_SITE_ANNOUNCEMENT,
  seo: DEFAULT_SITE_SEO,
  analytics: DEFAULT_SITE_ANALYTICS,
};

// ─── What the public endpoints answer ───────────────────────────────────────

/** GET /v1/site */
export type PublicSite = {
  productName: string;
  supportEmail: string;
  primaryColor: string;
  logoUrl: string | null;
  faviconUrl: string | null;
  /** false = "/" sends visitors to /login. */
  landingEnabled: boolean;
  landing: LandingContent;
  /** null when switched off. */
  announcement: (Omit<AnnouncementContent, "enabled"> & { id: string }) | null;
  seo: { title: string; description: string; ogImageUrl: string | null };
  analytics: AnalyticsContent;
};

/** GET /v1/site/legal/:slug */
export type PublicLegalPage = LegalContent & { slug: LegalSlug; publishedAt: string | null };

/** Replaces {{product_name}} in every string of a JSON value. */
export function withProductName<T>(value: T, productName: string): T {
  if (typeof value === "string") return value.split(PRODUCT_NAME_TOKEN).join(productName) as T;
  if (Array.isArray(value)) return value.map((v) => withProductName(v, productName)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withProductName(v, productName)])) as T;
  }
  return value;
}
