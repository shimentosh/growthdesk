/*
 * The browser's only door to the API.
 *
 * Ported from LinkDesk's packages/http/src/proxy.ts. The browser calls this
 * app's own /api/*; we forward to the Nest API's /v1/* and pass the answer
 * back, so every Set-Cookie arrives from the host the page came from — no
 * CORS, no third-party cookies, and the API can stay on loopback.
 *
 *   /api/auth/me  →  ${API_URL}/v1/auth/me
 *
 * The body is forwarded as the exact bytes received: payment-provider
 * webhooks (/api/webhooks/billing/:provider) are verified by a signature over
 * those bytes.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const API_VERSION = "/v1";
const BASE_PATH = "/api";

const target = () => (process.env.API_URL ?? "http://127.0.0.1:3601").replace(/\/$/, "");

/** Hop-by-hop headers, and the ones the fetch below must decide for itself. */
const DROP_FROM_REQUEST = new Set([
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "content-length",
  "accept-encoding",
]);

/** Headers that belong to the hop, not to the answer. */
const DROP_FROM_RESPONSE = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "content-encoding",
  "content-length",
  "trailer",
]);

async function proxy(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const asked = url.pathname.startsWith(BASE_PATH) ? url.pathname.slice(BASE_PATH.length) || "/" : url.pathname;
  const path = `${API_VERSION}${asked}`;

  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (!DROP_FROM_REQUEST.has(key.toLowerCase())) headers.set(key, value);
  });

  // The API decides whether a cookie may be Secure from the original scheme,
  // which only survives the hop as a header.
  const proto = request.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  headers.set("x-forwarded-proto", proto);
  headers.set("x-forwarded-host", url.host);
  // Passed on exactly as it arrived (never invented): the API reads the client
  // address from the right of this chain, knowing how many hops it runs behind.
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) headers.set("x-forwarded-for", forwardedFor);
  // The API echoes and logs this id (docs/DEPLOYMENT.md → Logs). A proxy in front may set it
  // (nginx $request_id); otherwise one is made here so this hop's own errors carry it too.
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  headers.set("x-request-id", requestId);

  // Raw bytes, read whole: a streamed body needs duplex negotiation, and
  // nothing this API accepts is large enough to be worth it.
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();

  let upstream: Response;
  try {
    upstream = await fetch(`${target()}${path}${url.search}`, {
      method: request.method,
      headers,
      body: body && body.byteLength ? body : undefined,
      redirect: "manual",
      cache: "no-store",
    });
  } catch (e) {
    console.error(`[api proxy] request ${requestId}: could not reach the API at`, target(), "-", e instanceof Error ? e.message : e);
    return Response.json(
      { error: { code: "api_unreachable", message: "Could not reach the Growthdesk API. Is it running?" } },
      { status: 502, headers: { "cache-control": "no-store", "x-request-id": requestId } },
    );
  }

  const out = new Headers();
  upstream.headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (!DROP_FROM_RESPONSE.has(k) && k !== "set-cookie") out.set(key, value);
  });
  // Set-Cookie legitimately repeats; collapsing it into one comma-joined
  // header is how a sign-in silently stops working.
  for (const cookie of upstream.headers.getSetCookie()) out.append("set-cookie", cookie);

  // 204/304 have no body by definition; redirects pass through with Location
  // (Google sign-in hands the browser to accounts.google.com and back).
  const empty = upstream.status === 204 || upstream.status === 304 || request.method === "HEAD";
  return new Response(empty ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: out,
  });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const HEAD = proxy;
export const OPTIONS = proxy;
