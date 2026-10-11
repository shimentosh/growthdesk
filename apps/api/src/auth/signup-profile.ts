import { ATTRIBUTION_MAX_BYTES, SignupAttribution, type SignupAttributionT, type SignupSource } from "@growthdesk/shared";
import type { Tx } from "../prisma/prisma.service.js";

/*
 * The platform-side facts recorded when an account is created: how it signed
 * up, first-touch attribution from the `gd_attr` cookie (written by the web
 * proxy, apps/web/src/proxy.ts) and marketing consent. Stored in
 * PlatformUserProfile so the User model stays untouched.
 */

/**
 * The `gd_attr` cookie as cookie-parser hands it over: a JSON string (or an
 * object for the `j:` form). Anything oversized, malformed or empty is
 * ignored — attribution is best-effort and must never fail a sign-up.
 */
export function parseAttributionCookie(raw: unknown): SignupAttributionT | null {
  let value: unknown = raw;
  if (typeof raw === "string") {
    if (!raw || Buffer.byteLength(raw, "utf8") > ATTRIBUTION_MAX_BYTES) return null;
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  } else if (raw && typeof raw === "object") {
    if (Buffer.byteLength(JSON.stringify(raw), "utf8") > ATTRIBUTION_MAX_BYTES) return null;
  } else {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  // Non-string values are dropped field by field rather than failing the whole cookie.
  const strings = Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, v]) => typeof v === "string"));
  const parsed = SignupAttribution.safeParse(strings);
  if (!parsed.success) return null;
  const clean = Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => typeof v === "string" && v !== "")) as SignupAttributionT;
  return Object.keys(clean).length ? clean : null;
}

export type SignupProfileInput = {
  source: SignupSource;
  attribution?: SignupAttributionT | null;
  marketingConsent?: boolean;
};

/** Creates (or, for an account that somehow already has one, fills) the profile row inside the sign-up transaction. */
export async function createSignupProfile(tx: Pick<Tx, "platformUserProfile">, userId: string, input: SignupProfileInput) {
  const a = input.attribution ?? {};
  const utm = Object.fromEntries(Object.entries(a).filter(([k]) => k.startsWith("utm_")));
  const consent = Boolean(input.marketingConsent);
  const data = {
    signupSource: input.source,
    utm,
    referrer: a.referrer ?? "",
    landingPath: a.landingPath ?? "",
    marketingConsent: consent,
    consentAt: consent ? new Date() : null,
    consentSource: consent ? "signup_form" : "",
  };
  await tx.platformUserProfile.upsert({ where: { userId }, create: { userId, ...data }, update: data });
}
