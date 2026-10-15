import { parseEspWebhook, sendIdFromMessageId } from "./esp-webhooks.js";
import { deferralError, readDeferral } from "./sender.service.js";

const SEND = "0192f0c4-7a3e-7cc1-9a51-1f2e3d4c5b6a";

describe("parseEspWebhook", () => {
  it("reads Postmark bounces, complaints and suppressions", () => {
    expect(parseEspWebhook({ RecordType: "Bounce", Type: "HardBounce", Email: "a@x.com", MessageID: "pm-1" })).toEqual([
      { type: "bounce", permanent: true, email: "a@x.com", providerMessageId: "pm-1", sendId: null },
    ]);
    expect(parseEspWebhook({ RecordType: "Bounce", Type: "SoftBounce", Email: "a@x.com" })![0]!.permanent).toBe(false);
    expect(parseEspWebhook({ RecordType: "SpamComplaint", Email: "a@x.com" })![0]!.type).toBe("complaint");
    expect(parseEspWebhook({ RecordType: "SubscriptionChange", Recipient: "a@x.com", SuppressSending: true, SuppressionReason: "ManualSuppression" })![0]!.type).toBe("unsubscribe");
    expect(parseEspWebhook({ RecordType: "SubscriptionChange", Recipient: "a@x.com", SuppressSending: false })).toEqual([]);
    expect(parseEspWebhook({ RecordType: "Delivery", Recipient: "a@x.com" })).toEqual([]);
  });

  it("reads a SendGrid event batch", () => {
    const events = parseEspWebhook([
      { event: "bounce", type: "bounce", email: "a@x.com", sg_message_id: "abc123.filter0001", "smtp-id": `<${SEND}@news.example.com>` },
      { event: "bounce", type: "blocked", email: "b@x.com" },
      { event: "spamreport", email: "c@x.com" },
      { event: "group_unsubscribe", email: "d@x.com" },
      { event: "open", email: "e@x.com" },
    ]);
    expect(events).toEqual([
      { type: "bounce", permanent: true, email: "a@x.com", providerMessageId: "abc123", sendId: SEND },
      { type: "bounce", permanent: false, email: "b@x.com", providerMessageId: null, sendId: null },
      { type: "complaint", permanent: true, email: "c@x.com", providerMessageId: null, sendId: null },
      { type: "unsubscribe", permanent: true, email: "d@x.com", providerMessageId: null, sendId: null },
    ]);
  });

  it("reads Mailgun failures, complaints and unsubscribes", () => {
    const ev = (event: string, severity?: string) => ({ signature: {}, "event-data": { event, severity, recipient: "a@x.com", message: { headers: { "message-id": `${SEND}@news.example.com` } } } });
    expect(parseEspWebhook(ev("failed", "permanent"))).toEqual([{ type: "bounce", permanent: true, email: "a@x.com", providerMessageId: `${SEND}@news.example.com`, sendId: SEND }]);
    expect(parseEspWebhook(ev("failed", "temporary"))![0]!.permanent).toBe(false);
    expect(parseEspWebhook(ev("complained"))![0]!.type).toBe("complaint");
    expect(parseEspWebhook(ev("unsubscribed"))![0]!.type).toBe("unsubscribe");
    expect(parseEspWebhook(ev("delivered"))).toEqual([]);
  });

  it("leaves other bodies to the generic format", () => {
    expect(parseEspWebhook({ type: "bounce", email: "a@x.com" })).toBeNull();
    expect(parseEspWebhook([{ foo: 1 }])).toBeNull();
    expect(sendIdFromMessageId("<not-a-uuid@x.com>")).toBeNull();
  });
});

describe("deferral bookkeeping", () => {
  it("round-trips the count and first time through the error text", () => {
    const since = new Date("2026-10-15T10:00:00.000Z");
    const err = deferralError(3, since, "451 Try again later");
    expect(readDeferral(err)).toEqual({ tries: 3, since });
    expect(readDeferral("451 Try again later")).toBeNull();
  });
});
