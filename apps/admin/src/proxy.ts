import { NextResponse, type NextRequest } from "next/server";
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

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (isPublic(pathname)) return NextResponse.next();
  if (request.cookies.has(SESSION_COOKIE)) {
    const headers = new Headers(request.headers);
    headers.set(PATH_HEADER, pathname + search);
    return NextResponse.next({ request: { headers } });
  }

  const login = request.nextUrl.clone();
  login.pathname = "/login";
  login.search = pathname === "/" ? "" : `?next=${encodeURIComponent(pathname + search)}`;
  return NextResponse.redirect(login);
}

export const config = {
  // Not the API proxy, Next's assets, or any file with an extension.
  matcher: ["/((?!api/|_next/static|_next/image|favicon.ico|robots.txt|.*\\.[a-zA-Z0-9]+$).*)"],
};
