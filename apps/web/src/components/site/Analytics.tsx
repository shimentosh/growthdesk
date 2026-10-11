"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { GA4_MEASUREMENT_ID, PLAUSIBLE_DOMAIN, type AnalyticsContent } from "@growthdesk/shared";

/*
 * Website analytics for the public pages only, and only when the
 * super-admin configured a provider (Website → SEO & analytics). The script
 * is added on first use and page views are sent by hand on each public
 * route change — never automatically — so once a visitor signs in and
 * leaves the public site, nothing about the app (workspace ids in URLs
 * included) reaches the analytics provider.
 *
 * Hosts (for a Content-Security-Policy): plausible.io; www.googletagmanager.com
 * and *.google-analytics.com.
 */

type Gtag = (...args: unknown[]) => void;
declare global {
  interface Window {
    plausible?: ((event: string, options?: Record<string, unknown>) => void) & { q?: unknown[] };
    dataLayer?: unknown[];
    gtag?: Gtag;
  }
}

function addScript(id: string, src: string, attrs: Record<string, string> = {}) {
  if (document.getElementById(id)) return;
  const s = document.createElement("script");
  s.id = id;
  s.src = src;
  s.async = true;
  for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v);
  document.head.appendChild(s);
}

function ensurePlausible(domain: string) {
  if (!window.plausible) {
    const queue: unknown[] = [];
    const stub = ((...args: unknown[]) => void queue.push(args)) as NonNullable<Window["plausible"]>;
    stub.q = queue;
    window.plausible = stub;
  }
  addScript("gd-plausible", "https://plausible.io/js/script.manual.js", { "data-domain": domain, defer: "" });
}

function ensureGa4(id: string) {
  if (!window.gtag) {
    window.dataLayer = window.dataLayer ?? [];
    // gtag.js reads the `arguments` object itself, not an array.
    window.gtag = function gtag() {
      // eslint-disable-next-line prefer-rest-params
      window.dataLayer!.push(arguments);
    };
    window.gtag("js", new Date());
    window.gtag("config", id, { send_page_view: false, anonymize_ip: true });
  }
  addScript("gd-ga4", `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`);
}

export function Analytics({ analytics }: { analytics: AnalyticsContent }) {
  const pathname = usePathname();
  const { provider, plausibleDomain, ga4MeasurementId } = analytics;

  useEffect(() => {
    if (provider === "plausible" && PLAUSIBLE_DOMAIN.test(plausibleDomain)) {
      ensurePlausible(plausibleDomain);
      window.plausible?.("pageview");
    } else if (provider === "ga4" && GA4_MEASUREMENT_ID.test(ga4MeasurementId)) {
      ensureGa4(ga4MeasurementId);
      window.gtag?.("event", "page_view", { page_location: window.location.href, page_path: pathname, page_title: document.title });
    }
  }, [provider, plausibleDomain, ga4MeasurementId, pathname]);

  return null;
}
