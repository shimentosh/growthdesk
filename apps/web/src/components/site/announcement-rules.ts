/*
 * Shared by the server (which skips rendering a banner the visitor already
 * closed) and the client banner (which records the dismissal). Plain module:
 * importable from both sides.
 */

/** Holds the id of the announcement a visitor closed; a new message has a new id, so it shows again. */
export const ANNOUNCEMENT_COOKIE = "gd_announce_dismissed";

/** Paths of the signed-in app — where an "app" announcement shows. */
export const APP_PATH_PREFIXES = ["/w/", "/onboarding", "/account", "/admin", "/preferences"];

export const isAppPath = (pathname: string) => APP_PATH_PREFIXES.some((p) => pathname === p.replace(/\/$/, "") || pathname.startsWith(p.endsWith("/") ? p : `${p}/`));
