import type { ApiError } from "@/lib/api";

/*
 * Which message goes where. A schema failure answers "field: message" with
 * the same text under `fields`, so the field shows it and the form stays
 * quiet; any other 400/409 (a failed SMTP sign-in, a domain used for
 * outreach) is the form's message. A 402 opens the upgrade dialog instead.
 */
export function formErrorOf(e: ApiError | null): string | null {
  if (!e || e.isPlanLimit) return null;
  const schema = Object.entries(e.fields).some(([k, v]) => e.message === `${k}: ${v}`);
  return schema ? null : e.message;
}
