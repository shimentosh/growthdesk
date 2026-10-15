import { resolveCname, resolveMx, resolveTxt } from "node:dns/promises";

/*
 * Ported nearly as-is from LinkDesk apps/api/src/modules/mailboxes/domain-auth.ts.
 * Change: the DNS lookups go through an injectable `DnsResolver`, so the
 * judgement can be exercised (and tested) without the network.
 */

/** The three lookups the checker makes. Each may reject; every lookup fails soft. */
export type DnsResolver = {
  txt(name: string): Promise<string[][]>;
  mx(name: string): Promise<{ exchange: string; priority: number }[]>;
  cname(name: string): Promise<string[]>;
};

export const systemResolver: DnsResolver = {
  txt: (name) => resolveTxt(name),
  mx: (name) => resolveMx(name),
  cname: (name) => resolveCname(name),
};

/**
 * What a domain publishes about who may send for it, and what is missing.
 *
 * The add-mailbox dialog used to say one sentence about this — "SPF published ·
 * no DMARC record · DKIM not checked" — which tells an operator that something
 * is wrong without telling them what to type into their DNS panel. Every
 * mailbox connected here sends cold outreach, and cold outreach off a domain
 * with no SPF, no DKIM signature and no DMARC policy lands in spam whatever
 * the copy says. So this answers the next question too: the exact record, at
 * the exact host, for the provider the mailbox is on.
 *
 * SPF, DMARC and MX are answerable from anywhere — they live at known names.
 * DKIM is not: the key sits at `<selector>._domainkey` and the selector is
 * chosen by whoever set the domain up. So the selectors the named providers
 * sign with are tried by name, a short list of conventional ones after them,
 * and a miss is reported as "not found at the selectors we know" rather than
 * as an absence we cannot actually prove.
 */

export type RecordState = "ok" | "warn" | "fail";

/** The record to publish, spelled out for a DNS panel. */
export type DomainFix = {
  type: "TXT" | "CNAME" | "MX";
  /** The name the record goes at, as the DNS panel wants it. */
  host: string;
  /** Omitted when only the provider can generate the value — a DKIM key. */
  value?: string;
  note: string;
  href?: string;
  hrefLabel?: string;
};

export type DomainRecord = {
  id: "spf" | "dkim" | "dmarc" | "mx";
  label: string;
  title: string;
  state: RecordState;
  detail: string;
  /** What is published today, when anything is. */
  found?: string;
  fix?: DomainFix;
};

export type DomainAuth = {
  domain: string;
  provider: string;
  /** True when the address is on the provider's own domain — gmail.com and friends. */
  shared: boolean;
  state: RecordState;
  detail: string;
  /** How many of the four are in order, for the header. */
  done: number;
  total: number;
  records: DomainRecord[];
};

/**
 * A mailbox provider, as far as its DNS advice goes.
 *
 * `guessed` marks a provider we do not know: the include is derived from the
 * SMTP host, which is a good hint and a bad assertion, so a domain that
 * already has SPF is not told its include is wrong on the strength of it.
 */
export type Profile = {
  id: string;
  name: string;
  include: string;
  guessed: boolean;
  selectors: string[];
  dkimHost: string;
  dkimNote: string;
  dkimHref?: string;
  dkimHrefLabel?: string;
  mxNote: string;
};

/** Selectors tried after the provider's own, in this order. */
const COMMON = ["default", "dkim", "mail", "s1", "s2", "k1", "selector1", "smtp"];

/** Addresses nobody can publish records for, because the domain is not theirs. */
const SHARED_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com",
  "yahoo.com", "yahoo.co.uk", "ymail.com", "aol.com", "icloud.com", "me.com", "mac.com",
  "proton.me", "protonmail.com", "pm.me", "gmx.com", "gmx.net", "mail.com",
  "yandex.com", "zoho.com", "zohomail.com", "fastmail.com", "hey.com",
]);

/** `smtp.mailhost.com` becomes `mailhost.com`; a two-label host is already the domain. */
function trimHost(host: string) {
  const parts = host.toLowerCase().replace(/\.$/, "").split(".").filter(Boolean);
  return parts.length > 2 ? parts.slice(1).join(".") : parts.join(".");
}

export function profileFor(smtpHost: string, domain: string): Profile {
  const host = (smtpHost || "").trim().toLowerCase();

  if (host.includes("gmail") || host.includes("google")) {
    return {
      id: "google",
      name: "Google Workspace",
      include: "_spf.google.com",
      guessed: false,
      selectors: ["google"],
      dkimHost: `google._domainkey.${domain}`,
      dkimNote:
        "Google generates the key: Admin console → Apps → Google Workspace → Gmail → Authenticate email → "
        + "Generate new record, then publish the TXT it shows and press Start authentication.",
      dkimHref: "https://admin.google.com/ac/apps/gmail/authenticateemail",
      dkimHrefLabel: "Authenticate email",
      mxNote: "Point the domain's MX at Google (aspmx.l.google.com and its backups) so replies arrive.",
    };
  }

  if (host.includes("office365") || host.includes("outlook") || host.includes("microsoft")) {
    return {
      id: "microsoft",
      name: "Microsoft 365",
      include: "spf.protection.outlook.com",
      guessed: false,
      selectors: ["selector1", "selector2"],
      dkimHost: `selector1._domainkey.${domain}`,
      dkimNote:
        "Microsoft publishes the key behind two CNAMEs: Defender portal → Email & collaboration → Policies → "
        + "Email authentication → DKIM → your domain → Create DKIM keys, then add the selector1 and selector2 "
        + "CNAMEs it gives you and turn signing on.",
      dkimHref: "https://security.microsoft.com/authentication",
      dkimHrefLabel: "Email authentication",
      mxNote: "Point the domain's MX at Microsoft (<domain>.mail.protection.outlook.com) so replies arrive.",
    };
  }

  if (host.includes("zoho")) {
    const region = host.endsWith(".eu") ? "eu" : host.endsWith(".in") ? "in" : host.endsWith(".au") ? "au" : "com";
    return {
      id: "zoho",
      name: "Zoho Mail",
      include: `zohomail.${region}`,
      guessed: false,
      selectors: ["zoho", "zmail"],
      dkimHost: `zoho._domainkey.${domain}`,
      dkimNote:
        "Zoho generates the key: Mail Admin Console → Domains → your domain → Email Configuration → DKIM → "
        + "Add, use the selector zoho, then publish the TXT it shows and press Verify.",
      dkimHref: "https://mailadmin.zoho.com",
      dkimHrefLabel: "Zoho Mail admin",
      mxNote: "Point the domain's MX at Zoho (mx.zoho.com and its backups) so replies arrive.",
    };
  }

  const derived = trimHost(host);
  return {
    id: "smtp",
    name: "your mail provider",
    include: derived || domain,
    guessed: true,
    selectors: [],
    dkimHost: `<selector>._domainkey.${domain}`,
    dkimNote:
      "Your provider generates the key and decides which selector it signs with. Find DKIM in its admin panel, "
      + "turn it on, and publish the record it hands you.",
    mxNote: "Point the domain's MX at whatever hosts this mailbox, so replies arrive.",
  };
}

/** Puts a mechanism into an existing record, before the trailing `all`. */
export function withInclude(record: string, include: string) {
  const parts = record.trim().split(/\s+/);
  const mech = `include:${include}`;
  if (parts.some((p) => p.toLowerCase() === mech.toLowerCase())) return record.trim();
  const allAt = parts.findIndex((p) => /^[-~?+]?all$/i.test(p));
  if (allAt === -1) return [...parts, mech].join(" ");
  return [...parts.slice(0, allAt), mech, ...parts.slice(allAt)].join(" ");
}

/** What the lookups found, kept apart from the reading of it so the reading can be tested. */
export type Resolved = {
  txt: string[];
  dmarc: string[];
  mx: string[];
  /**
   * `revoked` is a key that is published with an empty `p=`, which RFC 6376
   * says is a withdrawn key rather than a working one. It is not a curiosity:
   * example.com publishes exactly that at every selector, so a check that
   * only looked for the record would report DKIM as working on a domain that
   * cannot sign anything.
   */
  dkim: { selector: string; type: "TXT" | "CNAME"; value: string; revoked?: boolean } | null;
};

const worst = (states: RecordState[]): RecordState =>
  states.includes("fail") ? "fail" : states.includes("warn") ? "warn" : "ok";

/**
 * Reads what was found into four records. Pure, and the whole of the judgement
 * — `domainAuth` below only does the asking.
 */
export function readRecords(domain: string, profile: Profile, found: Resolved, shared: boolean): DomainAuth {
  const records: DomainRecord[] = [];

  /* SPF — one record, naming the provider, not ending in +all. */
  const spfAll = found.txt.filter((r) => r.toLowerCase().startsWith("v=spf1"));
  const spf = spfAll[0];
  const redirect = spf ? /\bredirect=([^\s]+)/i.exec(spf)?.[1] : undefined;
  const suggestedSpf = `v=spf1 include:${profile.include} ~all`;
  const includeNote = profile.guessed
    ? `The include is taken from the SMTP host — use the exact one ${profile.name} documents if it differs.`
    : `${profile.name} sends for this domain, so its include has to be in the record.`;

  if (spfAll.length > 1) {
    records.push({
      id: "spf", label: "SPF", title: "Who may send as this domain",
      state: "fail",
      detail:
        `${spfAll.length} SPF records are published. A domain may have exactly one — receivers read two as a `
        + "permanent error and stop checking.",
      found: spfAll.join("   |   "),
      fix: {
        type: "TXT", host: "@", value: withInclude(spfAll[0]!, profile.include),
        note: "Merge every mechanism into a single record and delete the others.",
      },
    });
  } else if (!spf) {
    records.push({
      id: "spf", label: "SPF", title: "Who may send as this domain",
      state: "fail",
      detail: shared
        ? `${domain} publishes no SPF record, and it is not yours to fix.`
        : "No SPF record. Without one every mailbox provider is free to treat this address as forged, and most do.",
      fix: shared ? undefined : {
        type: "TXT", host: "@", value: suggestedSpf,
        note: `Publish this at the root of ${domain}. ${includeNote}`,
      },
    });
  } else if (/\+all\b/i.test(spf)) {
    records.push({
      id: "spf", label: "SPF", title: "Who may send as this domain",
      state: "fail",
      detail:
        "The record ends in +all, which tells receivers that anyone at all may send as this domain — worse than "
        + "publishing nothing.",
      found: spf,
      fix: { type: "TXT", host: "@", value: spf.replace(/\+all\b/i, "~all"), note: "Replace +all with ~all." },
    });
  } else if (redirect) {
    /*
     * `redirect=` hands the whole policy to another domain, and following it
     * is a second lookup we do not make. A record that delegates is a record
     * that is being maintained somewhere — saying it "does not name the
     * provider" would be an accusation we cannot support. gmail.com is the
     * example: its SPF is a redirect, and this branch is why an operator is
     * not told to edit Google's DNS.
     */
    records.push({
      id: "spf", label: "SPF", title: "Who may send as this domain",
      state: "ok",
      detail: `SPF is published and hands the decision to ${redirect}, which the receiver follows.`,
      found: spf,
    });
  } else if (!shared && !profile.guessed && !spf.toLowerCase().includes(`include:${profile.include}`)) {
    records.push({
      id: "spf", label: "SPF", title: "Who may send as this domain",
      state: "warn",
      detail: `SPF is published, but it does not name ${profile.name}. Mail sent through this mailbox fails SPF.`,
      found: spf,
      fix: {
        type: "TXT", host: "@", value: withInclude(spf, profile.include),
        note: "Replace the existing record with this one — it is yours, with the include added.",
      },
    });
  } else {
    records.push({
      id: "spf", label: "SPF", title: "Who may send as this domain",
      state: "ok",
      detail: profile.guessed ? "SPF is published." : `SPF is published and names ${profile.name}.`,
      found: spf,
    });
  }

  /* DKIM — a signature, which is the half SPF cannot do. */
  if (shared) {
    records.push({
      id: "dkim", label: "DKIM", title: "The signature on every message",
      state: "ok",
      detail: `${domain} is signed by the provider with its own rotating key. There is nothing for you to publish.`,
    });
  } else if (found.dkim && !found.dkim.revoked) {
    records.push({
      id: "dkim", label: "DKIM", title: "The signature on every message",
      state: "ok",
      detail: `A key is published at ${found.dkim.selector}._domainkey, so messages can be signed.`,
      found: found.dkim.value.length > 160 ? `${found.dkim.value.slice(0, 160)}…` : found.dkim.value,
    });
  } else if (found.dkim) {
    records.push({
      id: "dkim", label: "DKIM", title: "The signature on every message",
      state: "warn",
      detail:
        `The record at ${found.dkim.selector}._domainkey carries no key — an empty p= is a withdrawn key, and `
        + "nothing signed with it verifies. Generate a new one and replace the record.",
      found: found.dkim.value,
      fix: {
        type: "TXT", host: `${found.dkim.selector}._domainkey.${domain}`, note: profile.dkimNote,
        href: profile.dkimHref, hrefLabel: profile.dkimHrefLabel,
      },
    });
  } else {
    const tried = [...profile.selectors, ...COMMON].slice(0, 6).join(", ");
    records.push({
      id: "dkim", label: "DKIM", title: "The signature on every message",
      state: "warn",
      detail:
        `No key at the selectors we know (${tried}). Either DKIM is off, or it signs with a selector of its own `
        + "— the provider's panel says which. Unsigned mail is the first thing Gmail and Outlook filter.",
      fix: {
        type: "TXT", host: profile.dkimHost, note: profile.dkimNote,
        href: profile.dkimHref, hrefLabel: profile.dkimHrefLabel,
      },
    });
  }

  /* DMARC — what a receiver should do when the other two fail. */
  const policy = found.dmarc.find((r) => r.toLowerCase().startsWith("v=dmarc1"));
  const p = policy?.match(/\bp\s*=\s*(none|quarantine|reject)/i)?.[1]?.toLowerCase();
  if (!policy) {
    records.push({
      id: "dmarc", label: "DMARC", title: "What to do when a message fails",
      state: "warn",
      detail: shared
        ? `${domain} publishes no DMARC policy, and it is not yours to fix.`
        : "No DMARC policy. Gmail and Yahoo have asked senders for one since 2024, and its reports are the only "
          + "way to see what is failing out there.",
      fix: shared ? undefined : {
        type: "TXT", host: `_dmarc.${domain}`,
        value: `v=DMARC1; p=none; rua=mailto:dmarc@${domain}`,
        note:
          "Start at p=none — it changes nothing about delivery and starts the reports arriving. Tighten to "
          + "quarantine once they are clean.",
      },
    });
  } else if (!p || p === "none") {
    records.push({
      id: "dmarc", label: "DMARC", title: "What to do when a message fails",
      state: "warn",
      detail: shared
        ? `${domain} is published at p=none by the provider, which enforces nothing — and it is not yours to tighten.`
        : "Published at p=none, which asks for reports and enforces nothing. Fine to start; tighten before volume.",
      found: policy,
      fix: shared ? undefined : {
        type: "TXT", host: `_dmarc.${domain}`,
        value: policy.replace(/\bp\s*=\s*none/i, "p=quarantine"),
        note: "Once the reports show only your own mail passing, move to quarantine.",
      },
    });
  } else {
    records.push({
      id: "dmarc", label: "DMARC", title: "What to do when a message fails",
      state: "ok",
      detail: `Published at p=${p}, which is enforced.`,
      found: policy,
    });
  }

  /* MX — because outreach that cannot receive a reply is a broadcast. */
  if (found.mx.length) {
    records.push({
      id: "mx", label: "MX", title: "Where replies arrive",
      state: "ok",
      detail: `${found.mx.length} mail server${found.mx.length === 1 ? "" : "s"} accept mail for ${domain}.`,
      found: found.mx.join(", "),
    });
  } else {
    records.push({
      id: "mx", label: "MX", title: "Where replies arrive",
      state: "fail",
      detail:
        `${domain} has no MX record, so nothing can reply to this address — a reply bounces, and a sequence that `
        + "waits for one never stops.",
      fix: shared ? undefined : { type: "MX", host: "@", note: profile.mxNote },
    });
  }

  const done = records.filter((r) => r.state === "ok").length;
  const said = records
    .map((r) => (r.state === "ok" ? `${r.label} ok` : r.state === "warn" ? `${r.label} weak` : `no ${r.label}`))
    .join(" · ");

  return {
    domain,
    provider: profile.name,
    shared,
    state: worst(records.map((r) => r.state)),
    detail: shared
      ? `${said}. ${domain} belongs to the mailbox provider, not to you — cold outreach from a free address is `
        + "filtered on sight. Send from a domain of your own."
      : done === records.length
        ? `${said}. Everything this domain can publish is published.`
        : `${said}. ${records.length - done} still to publish.`,
    done,
    total: records.length,
    records,
  };
}

/** A resolver answer is worth four seconds; a hung one is worth nothing. */
const LOOKUP_MS = 4_000;

function within<T>(work: Promise<T>, fallback: T): Promise<T> {
  return Promise.race([
    work.catch(() => fallback),
    new Promise<T>((resolve) => {
      const t = setTimeout(() => resolve(fallback), LOOKUP_MS);
      t.unref?.();
    }),
  ]);
}

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

/** The domain's mail servers, lowest priority first; [] when there are none or the lookup fails or times out. */
export function lookupMx(domain: string, resolver: DnsResolver = systemResolver): Promise<string[]> {
  if (!domain) return Promise.resolve([]);
  return within(
    resolver.mx(domain).then((rows) => [...rows].sort((a, b) => a.priority - b.priority).map((r) => r.exchange)),
    [] as string[],
  );
}

/** The domain of an address, or "" when there is nothing lookup-able in it. */
export function domainOf(email: string) {
  const host = (email.split("@")[1] ?? "").trim().toLowerCase().replace(/\.$/, "");
  return DOMAIN_RE.test(host) ? host : "";
}

/**
 * Asks DNS the four questions. Every lookup fails soft: a domain with no DMARC
 * record and a domain whose resolver timed out both come back as "nothing
 * found", which is the honest answer to give a form.
 */
export async function domainAuth(email: string, smtpHost: string, resolver: DnsResolver = systemResolver): Promise<DomainAuth> {
  const domain = domainOf(email);
  const profile = profileFor(smtpHost, domain);

  if (!domain) {
    return {
      domain: "", provider: profile.name, shared: false, state: "fail",
      detail: "That address has no domain to look up.", done: 0, total: 0, records: [],
    };
  }

  const shared = SHARED_DOMAINS.has(domain);
  const txt = (name: string) =>
    within(resolver.txt(name).then((rows) => rows.map((parts) => parts.join(""))), [] as string[]);

  const selectors = shared ? [] : [...new Set([...profile.selectors, ...COMMON])];

  const [root, dmarc, mx, keys] = await Promise.all([
    txt(domain),
    txt(`_dmarc.${domain}`),
    within(
      resolver.mx(domain).then((rows) => [...rows].sort((a, b) => a.priority - b.priority).map((r) => r.exchange)),
      [] as string[],
    ),
    Promise.all(
      selectors.map(async (selector) => {
        const name = `${selector}._domainkey.${domain}`;
        const [text, cname] = await Promise.all([txt(name), within(resolver.cname(name), [] as string[])]);
        const key = text.find((v) => /\bp=\s*[A-Za-z0-9+/=]+/.test(v));
        if (key) return { selector, type: "TXT" as const, value: key };
        if (cname[0]) return { selector, type: "CNAME" as const, value: cname[0] };
        const empty = text.find((v) => /v=dkim1/i.test(v));
        if (empty) return { selector, type: "TXT" as const, value: empty, revoked: true };
        return null;
      }),
    ),
  ]);

  /*
   * A working key anywhere beats a withdrawn one, whatever order the selectors
   * were tried in — a domain that rotated its key leaves the old selector
   * published and empty behind it.
   */
  const dkim = keys.find((k) => k && !k.revoked) ?? keys.find(Boolean) ?? null;

  return readRecords(domain, profile, { txt: root, dmarc, mx, dkim }, shared);
}
