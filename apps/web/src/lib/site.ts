/*
 * The public website's content, read on the server from GET /v1/site (and
 * /v1/site/legal/:slug, /v1/plans). Cached by Next for a short while — a
 * publish in the super-admin shows up within a minute — and never fatal:
 * when the API cannot be reached the site renders the built-in defaults, so
 * a marketing page or the root layout's metadata never turns into a crash.
 *
 * Server-only. Client components get what they need as props.
 */
import { cache } from "react";
import {
  DEFAULT_SITE_ANALYTICS,
  DEFAULT_SITE_LANDING,
  DEFAULT_SITE_SEO,
  DEFAULT_SITE_BRANDING,
  HEX_COLOR,
  withProductName,
  type LegalSlug,
  type PlanFeatures,
  type PlanLimits,
  type PublicLegalPage,
  type PublicSite,
} from "@growthdesk/shared";
import { apiTarget } from "@/lib/server-api";

export type { PublicSite, PublicLegalPage };

export { ANNOUNCEMENT_COOKIE } from "@/components/site/announcement-rules";

const REVALIDATE_SECONDS = 30;

async function getJson<T>(path: string): Promise<{ ok: true; data: T } | { ok: false; status: number }> {
  try {
    const res = await fetch(`${apiTarget()}/v1${path}`, {
      headers: { accept: "application/json" },
      next: { revalidate: REVALIDATE_SECONDS },
      signal: AbortSignal.timeout(4_000),
    });
    if (!res.ok) return { ok: false, status: res.status };
    const body = (await res.json()) as { data: T };
    return { ok: true, data: body.data };
  } catch {
    return { ok: false, status: 502 };
  }
}

/** What the site shows while the API is unreachable: the built-in content. */
export function fallbackSite(): PublicSite {
  const name = DEFAULT_SITE_BRANDING.productName;
  return {
    productName: name,
    supportEmail: "",
    primaryColor: "",
    logoUrl: null,
    faviconUrl: null,
    landingEnabled: true,
    landing: withProductName(DEFAULT_SITE_LANDING, name),
    announcement: null,
    seo: { title: DEFAULT_SITE_SEO.title, description: DEFAULT_SITE_SEO.description, ogImageUrl: null },
    analytics: DEFAULT_SITE_ANALYTICS,
  };
}

/** The published site, once per request. `live` is false when these are the fallback defaults. */
export const getSite = cache(async (): Promise<PublicSite & { live: boolean }> => {
  const res = await getJson<PublicSite>("/site");
  return res.ok ? { ...res.data, live: true } : { ...fallbackSite(), live: false };
});

export const getLegal = cache(async (slug: LegalSlug): Promise<PublicLegalPage | null> => {
  const res = await getJson<PublicLegalPage>(`/site/legal/${slug}`);
  return res.ok ? res.data : null;
});

/** One row of the public GET /v1/plans. */
export type PublicPlan = {
  key: string;
  name: string;
  description: string;
  currency: string;
  monthlyPriceCents: number;
  annualPriceCents: number;
  trialDays: number;
  limits: Partial<PlanLimits>;
  features: Partial<PlanFeatures>;
};

export async function getPublicPlans(): Promise<PublicPlan[] | null> {
  const res = await getJson<PublicPlan[]>("/plans");
  return res.ok ? res.data : null;
}

/**
 * CSS that re-points the accent tokens at the brand colour, in both
 * appearances. Only ever built from a validated #rrggbb value, so nothing a
 * stored string contains can reach the style sheet. The selector outranks
 * globals.css's `:root.dark` / `:root:not(.light)` blocks.
 */
export function accentCss(color: string): string | null {
  if (!HEX_COLOR.test(color)) return null;
  const c = color.toLowerCase();
  const mix = (pct: number, other: string) => `color-mix(in srgb, ${c} ${pct}%, ${other})`;
  // Text on the accent: white unless the colour is light (WCAG relative luminance).
  const lin = (i: number) => {
    const v = parseInt(c.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * lin(1) + 0.7152 * lin(3) + 0.0722 * lin(5);
  const onAccent = luminance > 0.45 ? "#000000" : "#ffffff";
  return (
    `:root:root:root{` +
    `--accent:${c};--accent-hi:${mix(88, "white")};--accent-deep:${mix(85, "black")};--on-accent:${onAccent};` +
    // Links and accent text lean towards the text colour, so they stay readable in both appearances.
    `--accent-soft:${mix(14, "transparent")};--accent-ring:${mix(38, "transparent")};--accent-ink:${mix(72, "var(--text-hi)")};` +
    `--tint-pick:${mix(8, "transparent")};--tint-pick-hi:${mix(12, "transparent")};` +
    `--a-chip:${mix(10, "transparent")};--a-1:${mix(7, "transparent")};--a-3:${mix(20, "transparent")};}`
  );
}
