/*
 * What the top bar says about where this console is running, and where the
 * customer app lives. Server-only (read per request, so a Docker image built
 * once can be told its environment at runtime).
 *
 *   ADMIN_ENV_LABEL   optional override for the badge ("Staging", "Production", …)
 *   PUBLIC_APP_URL    the customer app (same variable as the API); falls back to
 *   NEXT_PUBLIC_APP_URL, then to this host on port 3600 when the console runs on 3602.
 */

export type EnvTone = "info" | "warn" | "bad";
export type EnvInfo = { label: string; tone: EnvTone };

const LOCAL_HOSTS = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$|\.(local|localhost|test)$/i;

export function environmentFor(host: string | null): EnvInfo {
  const override = process.env.ADMIN_ENV_LABEL?.trim();
  const hostname = (host ?? "").replace(/:\d+$/, "");
  if (override) {
    const l = override.toLowerCase();
    return { label: override, tone: l.startsWith("prod") ? "bad" : l.startsWith("local") || l.startsWith("dev") ? "info" : "warn" };
  }
  if (!hostname || LOCAL_HOSTS.test(hostname)) return { label: "Local", tone: "info" };
  if (/(^|[.-])(staging|stage|preview|dev)([.-]|$)/i.test(hostname)) return { label: "Staging", tone: "warn" };
  return { label: "Production", tone: "bad" };
}

export function customerAppUrl(host: string | null, proto: string | null): string | null {
  const configured = process.env.PUBLIC_APP_URL || process.env.NEXT_PUBLIC_APP_URL;
  if (configured) return configured.replace(/\/$/, "");
  if (!host) return null;
  const m = host.match(/^(.*):3602$/);
  return m ? `${proto ?? "http"}://${m[1]}:3600` : null;
}
