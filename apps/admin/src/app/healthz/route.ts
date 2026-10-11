/*
 * Liveness of the operator console's server, for the container healthcheck
 * (docker-compose.prod.yml). Public (src/proxy.ts) and it does not call the API.
 */

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
}
