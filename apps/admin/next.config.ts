import path from "node:path";
import type { NextConfig } from "next";

/*
 * The repository root. `next build` runs from apps/admin, so two levels up is
 * the pnpm workspace — the standalone output has to trace @growthdesk/shared
 * from there, and Turbopack has to treat it as the project root to resolve the
 * workspace symlink.
 */
const root = path.resolve(process.cwd(), "../..");

/**
 * Sent with every page and every /api response. The API sets its own headers
 * (helmet) on what it answers; these cover what Next itself serves. The
 * operator console never needs the camera, microphone or location, and is
 * never framed.
 */
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Robots-Tag", value: "noindex, nofollow" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
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
  devIndicators: { position: "bottom-right" },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
