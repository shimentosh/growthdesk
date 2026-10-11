const BASE = "http://same.origin.invalid";

/**
 * Only a same-site path survives as ?next=, so the sign-in form cannot be an
 * open redirect. Browsers strip tabs and newlines from URLs and read "\" as
 * "/", so "/\t/evil.com" or "/\evil.com" would become "//evil.com": anything
 * with control characters or a backslash is refused, and the rest must
 * resolve to this origin.
 */
export function safeNext(value: string | string[] | undefined): string {
  const v = Array.isArray(value) ? value[0] : value;
  if (!v || !v.startsWith("/") || /[\u0000-\u001f\u007f\\]/.test(v)) return "/";
  try {
    const url = new URL(v, BASE);
    if (url.origin !== BASE) return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}
