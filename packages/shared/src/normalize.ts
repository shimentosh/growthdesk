import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";

/*
 * Canonical forms used for deduplication. One prospect arriving by CSV, by the
 * Business OS API and by an inbound reply must land on the same contact, so
 * every path into the CRM normalises with these before it looks anything up.
 */

const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;

/** Lower-cased, trimmed, angle brackets and "mailto:" removed; null if not an address. */
export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim().replace(/^mailto:/i, "").replace(/^<|>$/g, "").trim().toLowerCase();
  return EMAIL.test(value) ? value : null;
}

export const emailDomain = (email: string): string => email.slice(email.lastIndexOf("@") + 1).toLowerCase();

/** E.164 (+14155550123) when the number parses as a possible number; null otherwise. */
export function normalizePhone(raw: string | null | undefined, defaultCountry?: string): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const candidate = trimmed.startsWith("00") ? `+${trimmed.slice(2)}` : trimmed;
  const parsed = parsePhoneNumberFromString(
    candidate,
    defaultCountry && /^[A-Z]{2}$/.test(defaultCountry) ? (defaultCountry as CountryCode) : undefined,
  );
  if (!parsed || !parsed.isPossible()) return null;
  return parsed.number;
}

/** example.com from "https://www.Example.com/about", "www.example.com", "example.com". */
export function normalizeDomain(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let value = raw.trim().toLowerCase();
  if (!value) return null;
  if (value.includes("@")) value = emailDomain(value);
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^www\./, "");
  value = value.split(/[/?#:]/)[0] ?? "";
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(value) ? value : null;
}

const COMPANY_SUFFIXES =
  /\b(inc|incorporated|llc|l\.l\.c|ltd|limited|plc|gmbh|ag|sa|sas|bv|nv|pty|co|corp|corporation|company|pvt|private)\b\.?/g;

/** For matching companies by name: "Acme, Inc." and "ACME Inc" both become "acme". */
export function normalizeCompanyName(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(COMPANY_SUFFIXES, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Splits "Ada Lovelace" into first/last; keeps everything after the first word as the last name. */
export function splitName(full: string | null | undefined): { firstName: string; lastName: string } {
  const parts = (full ?? "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstName: "", lastName: "" };
  return { firstName: parts[0] ?? "", lastName: parts.slice(1).join(" ") };
}

export function joinName(first: string, last: string): string {
  return [first.trim(), last.trim()].filter(Boolean).join(" ");
}

/** Free-mail domains, where a shared domain says nothing about a shared company. */
export const FREE_MAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "yahoo.co.uk",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "gmx.com",
  "gmx.de",
  "mail.com",
  "yandex.com",
  "zoho.com",
]);

/** Telegram @handles and WhatsApp numbers as a peer key (ported from LinkDesk's normaliseHandle). */
export function normalizeHandle(raw: string): string {
  const value = raw.trim();
  if (value.startsWith("@")) return value.slice(1).toLowerCase();
  const digits = value.replace(/[^\d]/g, "");
  return digits || value.toLowerCase();
}
