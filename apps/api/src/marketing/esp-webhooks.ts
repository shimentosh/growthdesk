/*
 * Bounce, complaint and unsubscribe webhooks from email services that send
 * over SMTP: Postmark, SendGrid and Mailgun. Each is mapped onto the same
 * event the SES and Resend paths produce. Amazon SNS and Resend are read in
 * the controller; anything else posts Growthdesk's own JSON (EspEventInput).
 */

export type EspEvent = {
  type: "bounce" | "complaint" | "unsubscribe";
  /** Only permanent bounces suppress; transient ones are ignored. */
  permanent: boolean;
  email: string;
  providerMessageId: string | null;
  sendId: string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v: unknown) => (typeof v === "string" && v ? v : null);

/** Our Message-ID is <sendId@domain>; services that keep it hand it back, which names the send exactly. */
export function sendIdFromMessageId(v: unknown): string | null {
  const id = str(v)?.replace(/^\s*<|>\s*$/g, "").split("@")[0];
  return id && UUID.test(id) ? id : null;
}

type Postmark = { RecordType?: unknown; Type?: unknown; Inactive?: unknown; Email?: unknown; Recipient?: unknown; MessageID?: unknown; SuppressSending?: unknown; SuppressionReason?: unknown };
type SendGrid = { event?: unknown; type?: unknown; email?: unknown; sg_message_id?: unknown; "smtp-id"?: unknown };
type Mailgun = { "event-data"?: { event?: unknown; severity?: unknown; recipient?: unknown; message?: { headers?: { "message-id"?: unknown } } } };

/** Postmark: one record per request, by RecordType (Bounce, SpamComplaint, SubscriptionChange). */
function postmark(b: Postmark): EspEvent[] {
  const email = str(b.Email) ?? str(b.Recipient);
  if (!email) return [];
  const base = { email, providerMessageId: str(b.MessageID), sendId: null };
  switch (b.RecordType) {
    case "Bounce":
      // Soft bounces, auto-replies and the like are retried by Postmark; Inactive means it stopped sending there.
      return [{ ...base, type: "bounce", permanent: b.Type === "HardBounce" || b.Type === "BadEmailAddress" || b.Inactive === true }];
    case "SpamComplaint":
      return [{ ...base, type: "complaint", permanent: true }];
    case "SubscriptionChange":
      // SuppressSending false is a reactivation, which we never act on.
      if (b.SuppressSending !== true) return [];
      return [
        b.SuppressionReason === "HardBounce" ? { ...base, type: "bounce", permanent: true }
        : b.SuppressionReason === "SpamComplaint" ? { ...base, type: "complaint", permanent: true }
        : { ...base, type: "unsubscribe", permanent: true },
      ];
    default:
      return [];
  }
}

/** SendGrid Event Webhook: an array of events. `bounce` with type "blocked" is a soft block, not a dead address. */
function sendgrid(events: SendGrid[]): EspEvent[] {
  const out: EspEvent[] = [];
  for (const e of events) {
    const email = str(e.email);
    if (!email) continue;
    // sg_message_id is "<X-Message-Id>.filter…"; the part before the dot is what SendGrid's SMTP reply named.
    const base = { email, providerMessageId: str(e.sg_message_id)?.split(".")[0] ?? null, sendId: sendIdFromMessageId(e["smtp-id"]) };
    if (e.event === "bounce") out.push({ ...base, type: "bounce", permanent: e.type !== "blocked" });
    else if (e.event === "spamreport") out.push({ ...base, type: "complaint", permanent: true });
    else if (e.event === "unsubscribe" || e.event === "group_unsubscribe") out.push({ ...base, type: "unsubscribe", permanent: true });
  }
  return out;
}

/** Mailgun webhooks: { signature, "event-data": { event, severity, recipient, message.headers } }. */
function mailgun(b: Mailgun): EspEvent[] {
  const d = b["event-data"]!;
  const email = str(d.recipient);
  if (!email) return [];
  const messageId = d.message?.headers?.["message-id"];
  const base = { email, providerMessageId: str(messageId), sendId: sendIdFromMessageId(messageId) };
  if (d.event === "failed") return [{ ...base, type: "bounce", permanent: d.severity === "permanent" }];
  if (d.event === "complained") return [{ ...base, type: "complaint", permanent: true }];
  if (d.event === "unsubscribed") return [{ ...base, type: "unsubscribe", permanent: true }];
  return [];
}

/** The events in a Postmark, SendGrid or Mailgun webhook body, or null when it is none of them. */
export function parseEspWebhook(body: unknown): EspEvent[] | null {
  if (Array.isArray(body)) {
    return body.every((e) => e && typeof e === "object" && "event" in e && "email" in e) ? sendgrid(body as SendGrid[]) : null;
  }
  if (!body || typeof body !== "object") return null;
  if (typeof (body as Postmark).RecordType === "string") return postmark(body as Postmark);
  const ed = (body as Mailgun)["event-data"];
  if (ed && typeof ed === "object") return mailgun(body as Mailgun);
  return null;
}
