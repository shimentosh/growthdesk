/*
 * Mailbox providers for the connect dialog: where each one's SMTP and IMAP
 * servers are, how to get the password it accepts, and how to recognise it
 * from an address. Picking a provider only fills in hostnames — every one of
 * them connects over SMTP + IMAP with an app password, or (Google and
 * Microsoft, when the installation has an OAuth client) by signing in.
 *
 * Adapted from LinkDesk's preset table (packages/core/src/lib/mail.ts), with
 * more providers and recognition by domain and MX so nobody has to know their
 * own server names.
 */

export type MailSecurityT = "ssl" | "starttls" | "none";
export type MailServer = { host: string; port: number; security: MailSecurityT };

export type MailProviderStep = { text: string; href?: string; hrefLabel?: string };

export type MailProviderId = "google" | "microsoft" | "zoho" | "yahoo" | "icloud" | "fastmail" | "godaddy" | "titan" | "hostinger" | "privateemail" | "smtp";

export type MailProvider = {
  id: MailProviderId;
  name: string;
  /** What the password field asks for. */
  secretLabel: string;
  secretPlaceholder: string;
  /** Exact length when the provider issues fixed-length codes (Google: 16, spaces ignored). */
  secretLength?: number;
  smtp: MailServer;
  imap: MailServer;
  /** Where the password comes from, in order. */
  steps: MailProviderStep[];
  note?: { tone: "warn" | "bad"; text: string };
  /** Signing in instead of an app password, when the installation has the OAuth client. */
  oauth?: "gmail" | "microsoft";
};

const starttls = (host: string): MailServer => ({ host, port: 587, security: "starttls" });
const ssl = (host: string, port = 465): MailServer => ({ host, port, security: "ssl" });
const imap = (host: string): MailServer => ({ host, port: 993, security: "ssl" });

export const MAIL_PROVIDERS: Record<MailProviderId, MailProvider> = {
  google: {
    id: "google",
    name: "Gmail & Google Workspace",
    secretLabel: "App password",
    secretPlaceholder: "abcd efgh ijkl mnop",
    secretLength: 16,
    smtp: starttls("smtp.gmail.com"),
    imap: imap("imap.gmail.com"),
    steps: [
      { text: "Turn on 2-Step Verification — app passwords do not exist without it.", href: "https://myaccount.google.com/signinoptions/two-step-verification", hrefLabel: "Google 2-Step settings" },
      { text: "Create an app password (any name, e.g. Growthdesk). Google shows the 16-character code once.", href: "https://myaccount.google.com/apppasswords", hrefLabel: "App passwords page" },
      { text: "Paste it below. The normal account password will not work — Google turned that off in 2024." },
    ],
    note: { tone: "warn", text: "Google Workspace address: an admin may first have to allow app passwords under Admin console → Security → Authentication." },
    oauth: "gmail",
  },
  microsoft: {
    id: "microsoft",
    name: "Outlook & Microsoft 365",
    secretLabel: "Mailbox or app password",
    secretPlaceholder: "mailbox or app password",
    smtp: starttls("smtp.office365.com"),
    imap: imap("outlook.office365.com"),
    steps: [
      { text: "Microsoft 365 admin centre → Active users → the mailbox → Mail → Manage email apps → tick Authenticated SMTP.", href: "https://admin.microsoft.com/#/users", hrefLabel: "Active users" },
      { text: "If the account has multi-factor sign-in, create an app password instead of using the sign-in password.", href: "https://mysignins.microsoft.com/security-info", hrefLabel: "Security info" },
      { text: "Paste the password below." },
    ],
    note: {
      tone: "bad",
      text: "Personal outlook.com / hotmail.com addresses stopped accepting passwords in September 2024, and Microsoft is retiring password sign-in for Microsoft 365 SMTP. Signing in with Microsoft is the route that keeps working.",
    },
    oauth: "microsoft",
  },
  zoho: {
    id: "zoho",
    name: "Zoho Mail",
    secretLabel: "App password",
    secretPlaceholder: "generated app password",
    smtp: ssl("smtp.zoho.com"),
    imap: imap("imap.zoho.com"),
    steps: [
      { text: "Sign in to Zoho and open Security → App passwords.", href: "https://accounts.zoho.com/home#security/app_password", hrefLabel: "Zoho app passwords" },
      { text: "Generate one (any name, e.g. Growthdesk) and copy it." },
      { text: "Paste it below. In Zoho Mail settings, IMAP access must be on for reply tracking." },
    ],
  },
  yahoo: {
    id: "yahoo",
    name: "Yahoo Mail",
    secretLabel: "App password",
    secretPlaceholder: "generated app password",
    secretLength: 16,
    smtp: ssl("smtp.mail.yahoo.com"),
    imap: imap("imap.mail.yahoo.com"),
    steps: [
      { text: "Open Account security and choose Generate app password.", href: "https://login.yahoo.com/account/security", hrefLabel: "Yahoo account security" },
      { text: "Name it (e.g. Growthdesk) and copy the code." },
      { text: "Paste it below — the normal password will not work." },
    ],
    note: { tone: "warn", text: "Free addresses are a poor fit for outreach: mail from a domain you own is far more likely to be delivered." },
  },
  icloud: {
    id: "icloud",
    name: "iCloud Mail",
    secretLabel: "App-specific password",
    secretPlaceholder: "abcd-efgh-ijkl-mnop",
    smtp: starttls("smtp.mail.me.com"),
    imap: imap("imap.mail.me.com"),
    steps: [
      { text: "Sign in to your Apple Account → Sign-In and Security → App-Specific Passwords.", href: "https://account.apple.com/account/manage", hrefLabel: "Apple Account" },
      { text: "Generate one (e.g. Growthdesk) and copy it." },
      { text: "Paste it below. The username is your full iCloud address." },
    ],
  },
  fastmail: {
    id: "fastmail",
    name: "Fastmail",
    secretLabel: "App password",
    secretPlaceholder: "generated app password",
    smtp: ssl("smtp.fastmail.com"),
    imap: imap("imap.fastmail.com"),
    steps: [
      { text: "Settings → Privacy & Security → Integrations → New app password, with access to IMAP and SMTP.", href: "https://app.fastmail.com/settings/security/integrations", hrefLabel: "Fastmail integrations" },
      { text: "Paste it below." },
    ],
  },
  godaddy: {
    id: "godaddy",
    name: "GoDaddy Email",
    secretLabel: "Mailbox password",
    secretPlaceholder: "mailbox password",
    smtp: ssl("smtpout.secureserver.net"),
    imap: imap("imap.secureserver.net"),
    steps: [
      { text: "Use the password you sign in to GoDaddy webmail with." },
      { text: "If GoDaddy moved this mailbox to Microsoft 365, pick Outlook & Microsoft 365 instead." },
    ],
  },
  titan: {
    id: "titan",
    name: "Titan Email",
    secretLabel: "Mailbox password",
    secretPlaceholder: "mailbox password",
    smtp: ssl("smtp.titan.email"),
    imap: imap("imap.titan.email"),
    steps: [{ text: "Use the mailbox password you sign in to Titan webmail with." }],
  },
  hostinger: {
    id: "hostinger",
    name: "Hostinger Email",
    secretLabel: "Mailbox password",
    secretPlaceholder: "mailbox password",
    smtp: ssl("smtp.hostinger.com"),
    imap: imap("imap.hostinger.com"),
    steps: [{ text: "Use the mailbox password set in hPanel → Emails." }],
  },
  privateemail: {
    id: "privateemail",
    name: "Namecheap Private Email",
    secretLabel: "Mailbox password",
    secretPlaceholder: "mailbox password",
    smtp: ssl("mail.privateemail.com"),
    imap: imap("mail.privateemail.com"),
    steps: [{ text: "Use the mailbox password you sign in to Private Email webmail with." }],
  },
  smtp: {
    id: "smtp",
    name: "Another provider",
    secretLabel: "Password",
    secretPlaceholder: "mailbox or app password",
    smtp: starttls(""),
    imap: imap(""),
    steps: [
      { text: "Copy the SMTP and IMAP server names from your mail provider's help or settings page (often smtp.yourdomain.com / imap.yourdomain.com)." },
      { text: "Port 587 with STARTTLS or 465 with SSL/TLS for sending; 993 with SSL/TLS for IMAP." },
      { text: "Use the mailbox password, or an app password if the provider issues them." },
    ],
    note: { tone: "warn", text: "Use a real mailbox, not a bulk relay: SendGrid, Mailgun, Amazon SES, Postmark and Resend forbid cold outreach in their terms." },
  },
};

/** The order providers are offered in. */
export const MAIL_PROVIDER_ORDER: MailProviderId[] = ["google", "microsoft", "zoho", "yahoo", "icloud", "fastmail", "godaddy", "titan", "hostinger", "privateemail", "smtp"];

/** Free-mail domains, recognised without a lookup. */
const BY_DOMAIN: Record<string, MailProviderId> = {
  "gmail.com": "google",
  "googlemail.com": "google",
  "outlook.com": "microsoft",
  "hotmail.com": "microsoft",
  "live.com": "microsoft",
  "msn.com": "microsoft",
  "yahoo.com": "yahoo",
  "ymail.com": "yahoo",
  "rocketmail.com": "yahoo",
  "icloud.com": "icloud",
  "me.com": "icloud",
  "mac.com": "icloud",
  "zoho.com": "zoho",
  "zohomail.com": "zoho",
  "fastmail.com": "fastmail",
  "fastmail.fm": "fastmail",
};

/** MX host suffixes, checked against the domain's mail servers (lowest priority first). */
const BY_MX: [RegExp, MailProviderId][] = [
  [/(^|\.)(google|googlemail)\.com$/, "google"],
  [/(^|\.)(mail\.protection\.outlook\.com|outlook\.com|office365\.us)$/, "microsoft"],
  [/(^|\.)zoho(mail)?\.(com|eu|in|com\.au|jp|com\.cn|sa)$/, "zoho"],
  [/(^|\.)yahoodns\.net$/, "yahoo"],
  [/(^|\.)icloud\.com$/, "icloud"],
  [/(^|\.)messagingengine\.com$/, "fastmail"],
  [/(^|\.)secureserver\.net$/, "godaddy"],
  [/(^|\.)titan\.email$/, "titan"],
  [/(^|\.)hostinger\.(com|io)$/, "hostinger"],
  [/(^|\.)privateemail\.com$/, "privateemail"],
];

/** MX hosts of services that only forward incoming mail: there is no mailbox behind them to send from. */
const FORWARDERS: [RegExp, string][] = [
  [/(^|\.)mx\.cloudflare\.net$/, "Cloudflare Email Routing"],
  [/(^|\.)improvmx\.com$/, "ImprovMX"],
  [/(^|\.)forwardemail\.net$/, "Forward Email"],
];

export type MailDetection = {
  provider: MailProviderId;
  /** How it was recognised: the address's own domain, its MX records, or not at all. */
  via: "domain" | "mx" | "none";
  smtp: MailServer;
  imap: MailServer;
  /** The forwarding service the domain's MX points at, when it only forwards (nothing to sign in to). */
  forwarder?: string;
};

/** Zoho runs a data centre per region; the hosts follow the MX's top-level domain. */
function zohoServers(mx: string): Pick<MailDetection, "smtp" | "imap"> {
  const tld = /\.zoho(?:mail)?\.([a-z.]+)$/.exec(mx)?.[1] ?? "com";
  return { smtp: ssl(`smtp.zoho.${tld}`), imap: imap(`imap.zoho.${tld}`) };
}

/**
 * Which provider an address is on: by its domain when that is a free-mail
 * domain, else by the first MX that names a known provider. `mx` is the
 * domain's MX hosts, lowest priority first (empty when it was not looked up).
 */
export function detectMailProvider(email: string, mx: string[] = []): MailDetection {
  const domain = (email.split("@")[1] ?? "").trim().toLowerCase().replace(/\.$/, "");
  const known = BY_DOMAIN[domain];
  if (known) return { provider: known, via: "domain", smtp: MAIL_PROVIDERS[known].smtp, imap: MAIL_PROVIDERS[known].imap };
  for (const host of mx.map((h) => h.trim().toLowerCase().replace(/\.$/, ""))) {
    const hit = BY_MX.find(([re]) => re.test(host));
    if (!hit) continue;
    const id = hit[1];
    const servers = id === "zoho" ? zohoServers(host) : { smtp: MAIL_PROVIDERS[id].smtp, imap: MAIL_PROVIDERS[id].imap };
    return { provider: id, via: "mx", ...servers };
  }
  const forwarder = mx.map((h) => h.trim().toLowerCase().replace(/\.$/, "")).map((h) => FORWARDERS.find(([re]) => re.test(h))?.[1]).find(Boolean);
  return { provider: "smtp", via: "none", smtp: MAIL_PROVIDERS.smtp.smtp, imap: MAIL_PROVIDERS.smtp.imap, ...(forwarder ? { forwarder } : {}) };
}
