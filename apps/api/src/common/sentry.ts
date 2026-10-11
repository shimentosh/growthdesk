import type * as SentryNode from "@sentry/node";
import type { AppConfig } from "../config/config.js";

/*
 * Optional error reporting (docs/GAP_PLAN.md 6.1). Nothing is loaded or sent
 * unless SENTRY_DSN is set. Only errors are reported — unhandled 500s (the
 * exception filter), jobs that failed for good (worker/failed-jobs.ts) and
 * process-level crashes (Sentry's default handlers) — with no request bodies,
 * cookies or user details (sendDefaultPii off). Tracing is not set up.
 */

let sentry: typeof SentryNode | null = null;

export async function initSentry(config: Pick<AppConfig, "SENTRY_DSN" | "SENTRY_ENVIRONMENT" | "SENTRY_RELEASE" | "NODE_ENV">, service: "api" | "worker"): Promise<boolean> {
  if (!config.SENTRY_DSN || sentry) return Boolean(sentry);
  const mod = await import("@sentry/node");
  mod.init({
    dsn: config.SENTRY_DSN,
    environment: config.SENTRY_ENVIRONMENT ?? config.NODE_ENV,
    release: config.SENTRY_RELEASE,
    sendDefaultPii: false,
    skipOpenTelemetrySetup: true,
    initialScope: { tags: { service } },
  });
  sentry = mod;
  return true;
}

export type ErrorContext = { requestId?: string; tags?: Record<string, string>; extra?: Record<string, unknown> };

/** Reports one error. A no-op without SENTRY_DSN; never throws. */
export function reportError(error: unknown, context: ErrorContext = {}): void {
  if (!sentry) return;
  try {
    const s = sentry;
    s.withScope((scope) => {
      if (context.requestId) scope.setTag("request_id", context.requestId);
      for (const [k, v] of Object.entries(context.tags ?? {})) scope.setTag(k, v);
      if (context.extra) scope.setExtras(context.extra);
      s.captureException(error);
    });
  } catch {
    // Reporting must never take the process down with it.
  }
}

/** Sends what is buffered (on shutdown). */
export async function flushSentry(timeoutMs = 2000): Promise<void> {
  await sentry?.flush(timeoutMs).catch(() => undefined);
}
