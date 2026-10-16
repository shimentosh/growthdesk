import { Injectable } from "@nestjs/common";
import { resolve4, resolve6, resolveMx } from "node:dns/promises";
import { FREE_MAIL_DOMAINS, normalizeEmail } from "@growthdesk/shared";
import { DISPOSABLE_DOMAINS, domainListed } from "../auth/disposable-domains.js";
import { ApiError } from "../common/errors.js";
import { PlatformSettingsService, type ContactEmailValidation } from "./platform-settings.service.js";

/*
 * Contact email validation, the free way: no paid verification API. An
 * address that reaches the CRM by hand, CSV, the leads API or MCP is checked,
 * in order, for
 *   1. syntax (the address parses),
 *   2. the platform's own blocked domains,
 *   3. a disposable / throwaway mail service (auth/disposable-domains.ts),
 *   4. a role mailbox (info@, sales@ …), when the admin turns that on,
 *   5. a mail server: the domain publishes MX records, or (RFC 5321 §5.1)
 *      at least an address record; a "null MX" (RFC 7505) means no mail.
 * The admin switches it on and picks the checks in the platform admin.
 *
 * DNS fails open: a timeout or resolver error lets the address through, so a
 * DNS outage never stops an import. Only a definite "this domain does not
 * exist / takes no mail" rejects. Answers are cached per domain in-process.
 */

export type EmailCheck = "syntax" | "blocked" | "disposable" | "role" | "mail_server";
export type EmailVerdict = {
  email: string;
  ok: boolean;
  /** The first check that failed. */
  reason?: EmailCheck;
  /** Why, in a sentence a person can act on. */
  message?: string;
  /** Every check that ran, for the admin's test box. */
  checks: { check: EmailCheck; ok: boolean; detail?: string }[];
};

/** Local parts that reach a shared inbox rather than a person. */
const ROLE_ACCOUNTS = new Set(
  `abuse accounts admin administrator billing careers contact contactus customerservice do-not-reply donotreply enquiries
   help helpdesk hostmaster hr info inquiries jobs legal mail mailer-daemon marketing newsletter no-reply noreply
   office postmaster press privacy root sales security support team webmaster`.split(/\s+/),
);

/** Sources where the person wrote to us (or the system made the contact): never refused. */
const UNCHECKED_SOURCES = new Set(["inbound", "system", "web_chat"]);

export const DEFAULT_EMAIL_VALIDATION: ContactEmailValidation = {
  enabled: false,
  blockDisposable: true,
  checkMailServer: true,
  blockRoleAccounts: false,
  blockedDomains: [],
};

type DomainAnswer = { mail: boolean | null; detail: string };

/** The DNS lookups the mail-server check makes; a class so tests can swap them (t.app.get(MailDomainResolver).mx = …). */
@Injectable()
export class MailDomainResolver {
  mx = (domain: string) => resolveMx(domain);
  address = async (domain: string): Promise<boolean> => {
    const v4 = await resolve4(domain).catch((e: NodeJS.ErrnoException) => (isMissing(e) ? [] : Promise.reject(e)));
    if (v4.length) return true;
    const v6 = await resolve6(domain).catch((e: NodeJS.ErrnoException) => (isMissing(e) ? [] : Promise.reject(e)));
    return v6.length > 0;
  };
}

/** The resolver's way of saying "no such name" or "no records of that type" (as opposed to "could not ask"). */
const isMissing = (e: NodeJS.ErrnoException) => e?.code === "ENOTFOUND" || e?.code === "ENODATA" || e?.code === "NXDOMAIN";

const LOOKUP_MS = 4_000;
const KNOWN_TTL_MS = 6 * 60 * 60_000;
const UNKNOWN_TTL_MS = 5 * 60_000;
const CACHE_MAX = 20_000;

function within<T>(work: Promise<T>, ms = LOOKUP_MS): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((_, reject) => {
      const t = setTimeout(() => reject(Object.assign(new Error("DNS lookup timed out"), { code: "ETIMEOUT" })), ms);
      t.unref?.();
    }),
  ]);
}

@Injectable()
export class EmailValidationService {
  private readonly cache = new Map<string, { at: number; answer: DomainAnswer }>();
  private readonly inflight = new Map<string, Promise<DomainAnswer>>();

  constructor(
    private readonly platform: PlatformSettingsService,
    private readonly resolver: MailDomainResolver,
  ) {}

  async settings(): Promise<ContactEmailValidation> {
    const s = await this.platform.get();
    return { ...DEFAULT_EMAIL_VALIDATION, ...s.contactEmailValidation };
  }

  /**
   * Refuses (400, code "email_rejected") the first address that fails, when
   * validation is on and the source is one people type or import into.
   * Blank entries are ignored; a contact may still have no email at all.
   */
  async assertAcceptable(raw: (string | null | undefined)[], source = "manual"): Promise<void> {
    if (UNCHECKED_SOURCES.has(source)) return;
    const emails = raw.filter((e): e is string => Boolean(e?.trim()));
    if (!emails.length) return;
    const config = await this.settings();
    if (!config.enabled) return;
    for (const email of emails) {
      const v = await this.check(email, config);
      if (!v.ok) {
        throw new ApiError(400, "email_rejected", v.message ?? "That email address was not accepted", { email: v.reason ?? "invalid" });
      }
    }
  }

  /** Every check for one address, against the given (or the saved) settings, whether or not validation is on. */
  async check(raw: string, config?: ContactEmailValidation): Promise<EmailVerdict> {
    const c = config ?? (await this.settings());
    const checks: EmailVerdict["checks"] = [];
    const fail = (email: string, reason: EmailCheck, message: string, detail?: string): EmailVerdict => {
      checks.push({ check: reason, ok: false, detail });
      return { email, ok: false, reason, message, checks };
    };

    const email = normalizeEmail(raw);
    if (!email) return fail(raw.trim(), "syntax", `"${raw.trim()}" is not a valid email address`);
    checks.push({ check: "syntax", ok: true });
    const [local = "", domain = ""] = email.split("@") as [string, string];

    const blocked = new Set(c.blockedDomains.map((d) => d.toLowerCase()));
    if (blocked.size) {
      if (domainListed(domain, blocked)) return fail(email, "blocked", `${email} was not added: ${domain} is on the blocked list`);
      checks.push({ check: "blocked", ok: true });
    }

    if (c.blockDisposable) {
      if (domainListed(domain, DISPOSABLE_DOMAINS)) return fail(email, "disposable", `${email} was not added: ${domain} is a disposable (throwaway) email service`);
      checks.push({ check: "disposable", ok: true });
    }

    if (c.blockRoleAccounts) {
      const base = local.split("+")[0] ?? local;
      if (ROLE_ACCOUNTS.has(base)) return fail(email, "role", `${email} was not added: it is a shared role mailbox (${base}@), not a person`);
      checks.push({ check: "role", ok: true });
    }

    if (c.checkMailServer) {
      const answer = await this.mailServer(domain);
      if (answer.mail === false) return fail(email, "mail_server", `${email} was not added: ${domain} cannot receive email (${answer.detail})`, answer.detail);
      checks.push({ check: "mail_server", ok: true, detail: answer.detail });
    }

    return { email, ok: true, checks };
  }

  /** Whether the domain takes mail: true, false, or null when DNS could not say (treated as yes). */
  async mailServer(domain: string): Promise<DomainAnswer> {
    if (FREE_MAIL_DOMAINS.has(domain)) return { mail: true, detail: "well-known mail provider" };
    const hit = this.cache.get(domain);
    if (hit && Date.now() - hit.at < (hit.answer.mail === null ? UNKNOWN_TTL_MS : KNOWN_TTL_MS)) return hit.answer;
    const pending = this.inflight.get(domain);
    if (pending) return pending;
    const work = this.lookup(domain)
      .then((answer) => {
        if (this.cache.size >= CACHE_MAX) this.cache.delete(this.cache.keys().next().value as string);
        this.cache.set(domain, { at: Date.now(), answer });
        return answer;
      })
      .finally(() => this.inflight.delete(domain));
    this.inflight.set(domain, work);
    return work;
  }

  /** Clears the per-domain cache (tests, or after the admin changes resolvers). */
  forget() {
    this.cache.clear();
  }

  private async lookup(domain: string): Promise<DomainAnswer> {
    try {
      const mx = await within(this.resolver.mx(domain)).catch((e: NodeJS.ErrnoException) => (isMissing(e) ? [] : Promise.reject(e)));
      if (mx.length === 1 && (mx[0]?.exchange ?? "").replace(/\.$/, "") === "") return { mail: false, detail: "the domain says it takes no mail (null MX)" };
      if (mx.length) return { mail: true, detail: `mail server ${[...mx].sort((a, b) => a.priority - b.priority)[0]?.exchange}` };
      // No MX: mail falls back to the domain's own address record.
      if (await within(this.resolver.address(domain))) return { mail: true, detail: "no MX record, but the domain has an address" };
      return { mail: false, detail: "the domain has no mail server" };
    } catch {
      return { mail: null, detail: "DNS did not answer, so the address was let through" };
    }
  }
}
