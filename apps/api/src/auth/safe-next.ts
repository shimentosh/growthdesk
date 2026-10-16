const BASE = "http://same.origin.invalid";

/**
 * Where to land after Google sign-in: only a same-site path ("/invite/abc",
 * "/w/1?tab=x"), never "//evil.test" or an absolute URL, so the callback is
 * not an open redirect. Browsers strip tabs and newlines and read "\" as "/",
 * so anything with control characters or a backslash is refused too. Mirrors
 * apps/web/src/app/(auth)/safe-next.ts. Anything else gives "/".
 */
export function safeNextPath(value: unknown): string {
  const v = Array.isArray(value) ? value[0] : value;
  if (typeof v !== "string" || !v.startsWith("/") || v.startsWith("//") || v.length > 500 || /[\u0000-\u001f\u007f\\]/.test(v)) return "/";
  try {
    const url = new URL(v, BASE);
    if (url.origin !== BASE) return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}
