import { NextResponse, type NextRequest } from "next/server";
import { contentSecurityPolicy } from "@growthdesk/shared";
import { PATH_HEADER, SESSION_COOKIE } from "@/lib/constants";

/*
 * Next 16's request proxy (formerly middleware). Every page of the operator
 * console needs a signed-in person, so a visitor with no session cookie goes
 * to /login?next=… before any app code renders. /login and the /api proxy are
 * the only exceptions.
 *
 * It only checks that the cookie exists. A stale cookie gets through here; the
 * (panel) layout's /auth/me call answers 401 and redirects to the same place,
 * and so does src/lib/api.ts for client calls.
 */

function isPublic(pathname: string): boolean {
  return pathname === "/login" || pathname.startsWith("/login/") || pathname === "/api" || pathname.startsWith("/api/");
}

/*
 * The Content-Security-Policy, with a fresh nonce per request
 * (packages/shared/src/csp.ts). Next reads the nonce from the policy on the
 * request and puts it on every script it renders, so the policy goes on both
 * the request and the response.
 */
function next(request: NextRequest, extra: Record<string, string> = {}): NextResponse {
  const nonce = btoa(crypto.randomUUID());
  const policy = contentSecurityPolicy({ nonce, dev: process.env.NODE_ENV === "development" });
  const headers = new Headers(request.headers);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  headers.set("content-security-policy", policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", policy);
  return response;
}

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (isPublic(pathname)) return next(request);
  if (request.cookies.has(SESSION_COOKIE)) return next(request, { [PATH_HEADER]: pathname + search });

  const login = request.nextUrl.clone();
  login.pathname = "/login";
  login.search = pathname === "/" ? "" : `?next=${encodeURIComponent(pathname + search)}`;
  return NextResponse.redirect(login);
}

export const config = {
  // Not the API proxy, Next's assets, or any file with an extension.
  matcher: ["/((?!api/|_next/static|_next/image|favicon.ico|robots.txt|.*\\.[a-zA-Z0-9]+$).*)"],
};
