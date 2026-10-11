/*
 * Template personalisation.
 *
 * Syntax: {{first_name}}, {{company}}, {{custom.industry}} — with an optional
 * fallback written after a pipe: {{first_name|there}}.
 *
 * Ported from LinkDesk's renderTokens (outreach.service.ts), keeping its rule
 * that a token with nothing behind it is left standing rather than blanked,
 * and extended with fallbacks, dotted custom-field tokens and a server-side
 * check (`missingVariables`) that the campaign engine runs before every send:
 * a message with an unresolved token is not sent at all.
 */

const TOKEN = /\{\{\s*([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)?)\s*(?:\|\s*([^}]*?))?\s*\}\}/gi;

export type Variables = Record<string, string | null | undefined>;

export const STANDARD_VARIABLES = [
  { key: "first_name", label: "First name" },
  { key: "last_name", label: "Last name" },
  { key: "full_name", label: "Full name" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "job_title", label: "Job title" },
  { key: "company", label: "Company" },
  { key: "company_domain", label: "Company domain" },
  { key: "website", label: "Website" },
  { key: "city", label: "City" },
  { key: "country", label: "Country" },
  { key: "owner_name", label: "Contact owner" },
  { key: "sender_name", label: "Sender name" },
  { key: "sender_email", label: "Sender email" },
  { key: "unsubscribe_url", label: "Unsubscribe link" },
] as const;

const STANDARD_KEYS = new Set<string>(STANDARD_VARIABLES.map((v) => v.key));

export type Token = { name: string; fallback: string | null; raw: string };

export function tokensIn(text: string): Token[] {
  return [...text.matchAll(TOKEN)].map((m) => ({
    name: (m[1] ?? "").toLowerCase(),
    fallback: m[2] !== undefined ? m[2].trim() : null,
    raw: m[0],
  }));
}

/** Fills tokens; a token with no value and no fallback stays as written. */
export function renderTemplate(text: string, vars: Variables): string {
  return text.replace(TOKEN, (whole, name: string, fallback: string | undefined) => {
    const value = vars[name.toLowerCase()];
    if (value !== undefined && value !== null && String(value).trim() !== "") return String(value);
    if (fallback !== undefined) return fallback.trim();
    return whole;
  });
}

/** Token names that would stay unresolved for these variables. */
export function missingVariables(text: string, vars: Variables): string[] {
  const missing = new Set<string>();
  for (const t of tokensIn(text)) {
    const value = vars[t.name];
    const has = value !== undefined && value !== null && String(value).trim() !== "";
    if (!has && t.fallback === null) missing.add(t.name);
  }
  return [...missing];
}

/** Tokens that name neither a standard variable nor a known custom field. */
export function unknownVariables(text: string, customFieldKeys: readonly string[] = []): string[] {
  const custom = new Set(customFieldKeys.map((k) => `custom.${k.toLowerCase()}`));
  return [...new Set(tokensIn(text).map((t) => t.name))].filter((n) => !STANDARD_KEYS.has(n) && !custom.has(n));
}

export type ContactLike = {
  firstName?: string | null;
  lastName?: string | null;
  fullName?: string | null;
  email?: string | null;
  phone?: string | null;
  jobTitle?: string | null;
  website?: string | null;
  city?: string | null;
  country?: string | null;
  customFields?: unknown;
  company?: { name?: string | null; domain?: string | null } | null;
  owner?: { name?: string | null } | null;
};

/** The variables a contact makes available to a template. */
export function variablesFor(
  contact: ContactLike,
  extra: { senderName?: string; senderEmail?: string; unsubscribeUrl?: string } = {},
): Variables {
  const vars: Variables = {
    first_name: contact.firstName ?? "",
    last_name: contact.lastName ?? "",
    full_name: contact.fullName || [contact.firstName, contact.lastName].filter(Boolean).join(" "),
    email: contact.email ?? "",
    phone: contact.phone ?? "",
    job_title: contact.jobTitle ?? "",
    company: contact.company?.name ?? "",
    company_domain: contact.company?.domain ?? "",
    website: contact.website || (contact.company?.domain ? `https://${contact.company.domain}` : ""),
    city: contact.city ?? "",
    country: contact.country ?? "",
    owner_name: contact.owner?.name ?? "",
    sender_name: extra.senderName ?? "",
    sender_email: extra.senderEmail ?? "",
    unsubscribe_url: extra.unsubscribeUrl ?? "",
  };
  const custom = contact.customFields && typeof contact.customFields === "object" ? contact.customFields : {};
  for (const [key, value] of Object.entries(custom as Record<string, unknown>)) {
    if (value === null || value === undefined) continue;
    vars[`custom.${key.toLowerCase()}`] = String(value);
  }
  return vars;
}
