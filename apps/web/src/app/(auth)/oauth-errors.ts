/**
 * What the Google sign-in round-trip (apps/api auth.controller.ts googleStart /
 * googleCallback) sends back as ?error=, in words. Unknown codes show nothing
 * rather than a raw code.
 */
export const GOOGLE_ERROR_MESSAGES: Record<string, string> = {
  google_unavailable: "Google sign-in isn't set up on this server. Sign in with your email and password.",
  google_state: "The Google sign-in expired or was started in another browser. Try again.",
  google_failed: "Google sign-in didn't complete. Try again, or sign in with your email and password. If your account is suspended, contact support.",
};

export const oneParam = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
