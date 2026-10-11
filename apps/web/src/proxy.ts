import { NextResponse, type NextRequest } from "next/server";

/*
 * Next 16's request proxy (formerly middleware). First job: a visitor with no
 * session cookie who asks for an app route goes to /login?next=… before any
 * app code renders.
 *
 * It only checks that the cookie exists — it cannot tell a valid session from
 * an expired one without calling the API. A stale cookie gets through here,
 * and the first API call answers 401, which src/lib/api.ts turns into the
 * same /login redirect. Public pages are never redirected, so there is no loop.
 */

const SESSION_COOKIE = "gd_session";

/**
 * Routes that require a signed-in person. Everything else is public —
 * including "/", which shows the landing page to a visitor without a session
 * (or sends them to /login itself when the landing page is switched off).
 */
function isAppRoute(pathname: string): boolean {
  return (
    pathname === "/onboarding" ||
    pathname.startsWith("/w/") ||
    pathname === "/admin" ||
    pathname.startsWith("/admin/") ||
    pathname === "/account" ||
    pathname.startsWith("/account/")
  );
}

/*
 * Second job: first-touch sign-up attribution. The first visit that carries
 * utm_* parameters or comes from another site leaves a `gd_attr` cookie (JSON,
 * 30 days, never overwritten); the API reads it when the account is created
 * (apps/api/src/auth/signup-profile.ts). The referrer keeps only origin + path.
 */
const ATTRIBUTION_COOKIE = "gd_attr";
const ATTRIBUTION_MAX_AGE_S = 30 * 86_400;
const UTM_LIMITS = { utm_source: 100, utm_medium: 100, utm_campaign: 150, utm_term: 150, utm_content: 150 } as const;

function firstTouch(request: NextRequest): string | null {
  if (request.cookies.has(ATTRIBUTION_COOKIE)) return null;
  const attr: Record<string, string> = {};
  for (const [key, max] of Object.entries(UTM_LIMITS)) {
    const value = request.nextUrl.searchParams.get(key)?.trim();
    if (value) attr[key] = value.slice(0, max);
  }
  const referer = request.headers.get("referer");
  if (referer) {
    try {
      const from = new URL(referer);
      const ours = [request.nextUrl.host, request.headers.get("x-forwarded-host"), request.headers.get("host")];
      if ((from.protocol === "https:" || from.protocol === "http:") && !ours.includes(from.host)) attr.referrer = `${from.origin}${from.pathname}`.slice(0, 500);
    } catch {
      // Not a URL: no referrer.
    }
  }
  if (!Object.keys(attr).length) return null;
  attr.landingPath = request.nextUrl.pathname.slice(0, 300);
  const value = JSON.stringify(attr);
  return value.length <= 2048 ? value : null;
}

function route(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;
  if (!isAppRoute(pathname) || request.cookies.has(SESSION_COOKIE)) return NextResponse.next();

  const login = request.nextUrl.clone();
  login.pathname = "/login";
  login.search = `?next=${encodeURIComponent(pathname + search)}`;
  return NextResponse.redirect(login);
}

export function proxy(request: NextRequest) {
  const response = route(request);
  const attribution = firstTouch(request);
  if (attribution) {
    response.cookies.set(ATTRIBUTION_COOKIE, attribution, {
      maxAge: ATTRIBUTION_MAX_AGE_S,
      sameSite: "lax",
      httpOnly: true,
      path: "/",
      secure: request.nextUrl.protocol === "https:" || request.headers.get("x-forwarded-proto") === "https",
    });
  }
  return response;
}

export const config = {
  // Not the API proxy, Next's assets, or any file with an extension.
  matcher: ["/((?!api/|_next/static|_next/image|favicon.ico|robots.txt|.*\\.[a-zA-Z0-9]+$).*)"],
};
