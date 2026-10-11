/*
 * Liveness of the web server itself, for the container healthcheck
 * (docker-compose.prod.yml). It does not call the API: /api/health does that.
 */

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
}
