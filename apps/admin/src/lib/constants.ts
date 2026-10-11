/** The session cookie the API sets (host-only, so on localhost it is shared with the customer app on :3600). */
export const SESSION_COOKIE = "gd_session";

/** Set by src/proxy.ts on every signed-in page request, so the (panel) layout can send an expired session back to /login?next=… */
export const PATH_HEADER = "x-console-path";

/** "collapsed" when the person has folded the sidebar to icons (read on the server, so there is no flash). */
export const SIDEBAR_COOKIE = "gd_admin_sidebar";
