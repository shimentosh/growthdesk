import { createHmac, timingSafeEqual } from "node:crypto";

/*
 * Resend signs webhooks with Svix (docs.svix.com/receiving/verifying-payloads/how-manual):
 *   signed content = `${svix-id}.${svix-timestamp}.${raw body}`
 *   key            = base64-decode(secret without the "whsec_" prefix)
 *   svix-signature = space-separated "v1,<base64 HMAC-SHA256>" entries (several during key rotation)
 *   svix-timestamp = Unix seconds; we refuse anything more than 5 minutes off (replay defence).
 * White-labelled Svix accounts send the same values as webhook-id / webhook-timestamp / webhook-signature.
 */

export const SVIX_TOLERANCE_SECONDS = 5 * 60;

type Headers = Record<string, string | string[] | undefined>;

export type SvixResult = { ok: true; id: string; timestamp: number } | { ok: false; reason: string };

const header = (h: Headers, name: string) => {
  const v = h[name] ?? h[name.toLowerCase()];
  return (Array.isArray(v) ? v[0] : v)?.trim() ?? "";
};

export function svixSignature(secret: string, id: string, timestamp: string | number, body: string | Buffer): string {
  const key = Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");
  return createHmac("sha256", key).update(`${id}.${timestamp}.`).update(body).digest("base64");
}

export function verifySvix(secret: string, headers: Headers, rawBody: string | Buffer, nowMs = Date.now()): SvixResult {
  if (!secret) return { ok: false, reason: "No webhook signing secret is configured" };
  const id = header(headers, "svix-id") || header(headers, "webhook-id");
  const ts = header(headers, "svix-timestamp") || header(headers, "webhook-timestamp");
  const sigs = header(headers, "svix-signature") || header(headers, "webhook-signature");
  if (!id || !ts || !sigs) return { ok: false, reason: "Missing signature headers" };
  if (!/^\d{1,12}$/.test(ts)) return { ok: false, reason: "Bad timestamp" };
  const timestamp = Number(ts);
  if (Math.abs(nowMs / 1000 - timestamp) > SVIX_TOLERANCE_SECONDS) return { ok: false, reason: "Timestamp outside the 5-minute tolerance" };
  const expected = Buffer.from(svixSignature(secret, id, ts, rawBody));
  for (const part of sigs.split(" ")) {
    const [version, sig] = part.split(",", 2);
    if (version !== "v1" || !sig) continue;
    const given = Buffer.from(sig);
    if (given.length === expected.length && timingSafeEqual(given, expected)) return { ok: true, id, timestamp };
  }
  return { ok: false, reason: "No matching signature" };
}
