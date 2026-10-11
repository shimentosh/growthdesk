import type { Instrumentation } from "next";

/*
 * Optional server-side error reporting (docs/GAP_PLAN.md 6.1). Sentry is
 * loaded only when SENTRY_DSN is set at runtime; without it nothing is
 * imported and nothing leaves the server. Errors thrown while rendering a
 * page, in a route handler or in the request proxy reach onRequestError.
 * Browser errors: see instrumentation-client.ts (NEXT_PUBLIC_SENTRY_DSN).
 */

export async function register() {
  if (!process.env.SENTRY_DSN) return;
  const Sentry = await import("@sentry/nextjs");
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
    release: process.env.SENTRY_RELEASE,
    sendDefaultPii: false,
    initialScope: { tags: { service: "web" } },
  });
}

export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (!process.env.SENTRY_DSN) return;
  const Sentry = await import("@sentry/nextjs");
  Sentry.captureRequestError(error, request, context);
};
