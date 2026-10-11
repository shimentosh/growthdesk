import path from "node:path";
import type { NextConfig } from "next";

/*
 * The repository root. `next build` runs from apps/web, so two levels up is the
 * pnpm workspace — the standalone output has to trace @growthdesk/shared from
 * there, and Turbopack has to treat it as the project root to resolve the
 * workspace symlink.
 */
const root = path.resolve(process.cwd(), "../..");

/**
 * Sent with every page and every /api response. The API sets its own headers
 * (helmet) on what it answers; these cover what Next itself serves.
 *
 * microphone=(self): the calling workspace may place calls from the browser.
 */
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(self), geolocation=(), payment=(), usb=(), interest-cohort=()",
  },
];

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: root,
  turbopack: { root },
  transpilePackages: ["@growthdesk/shared"],
  poweredByHeader: false,
  reactStrictMode: true,
  // Dev only: lets HMR work when the app is opened at 127.0.0.1 instead of localhost.
  allowedDevOrigins: ["127.0.0.1"],
  // Dev only: keeps the Next badge off the sidebar's pinned Settings link.
  devIndicators: { position: "bottom-right" },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // Pages get a per-request nonce policy from src/proxy.ts; the API proxy never serves a document.
      { source: "/api/:path*", headers: [{ key: "Content-Security-Policy", value: "default-src 'none'; frame-ancestors 'none'" }] },
    ];
  },
};

export default nextConfig;
