/*
 * The Content-Security-Policy for the web app and the operator console.
 *
 * Scripts run only with the per-request nonce (Next.js puts it on its own
 * scripts when the proxy passes the policy on the request), and
 * 'strict-dynamic' lets those scripts load others (the public site's
 * analytics). Injected markup — an email body in the inbox, say — cannot run
 * script: no inline handlers, no javascript: URLs, no foreign script hosts.
 * Styles stay 'unsafe-inline' because React style attributes and the brand
 * accent <style> need it; that cannot run code.
 */

/** Hosts the public site's analytics may call (apps/web/src/components/site/Analytics.tsx). */
export const ANALYTICS_CONNECT_HOSTS = [
  "https://plausible.io",
  "https://www.googletagmanager.com",
  "https://*.google-analytics.com",
  "https://*.analytics.google.com",
] as const;

export type CspOptions = {
  nonce: string;
  /** next dev needs eval (React debugging) and a websocket for hot reload. */
  dev?: boolean;
  /** Extra origins fetch/XHR/beacons may reach. */
  connect?: readonly string[];
};

export function contentSecurityPolicy({ nonce, dev = false, connect = [] }: CspOptions): string {
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'", ...(dev ? ["'unsafe-eval'"] : [])],
    "style-src": ["'self'", "'unsafe-inline'"],
    // Remote images appear in received emails and branding; images cannot run code.
    "img-src": ["'self'", "data:", "blob:", "https:"],
    "font-src": ["'self'", "data:"],
    "connect-src": ["'self'", ...connect, ...(dev ? ["ws:", "wss:"] : [])],
    "frame-src": ["'self'"],
    "frame-ancestors": ["'none'"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
  };
  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(" ")}`)
    .join("; ");
}