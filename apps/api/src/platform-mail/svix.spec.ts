import { svixSignature, verifySvix } from "./svix.js";

// The published vector from docs.svix.com/receiving/verifying-payloads/how-manual.
const SECRET = "whsec_plJ3nmyCDGBKInavdOK15jsl";
const ID = "msg_loFOjxBNrRLzqYUf";
const TS = "1731705121";
const BODY = '{"event_type":"ping","data":{"success":true}}';
const SIG = "v1,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0=";
const AT = Number(TS) * 1000;

const headers = (over: Record<string, string> = {}) => ({ "svix-id": ID, "svix-timestamp": TS, "svix-signature": SIG, ...over });

describe("verifySvix", () => {
  it("matches the Svix documentation vector", () => {
    expect(`v1,${svixSignature(SECRET, ID, TS, BODY)}`).toBe(SIG);
    expect(verifySvix(SECRET, headers(), Buffer.from(BODY), AT)).toEqual({ ok: true, id: ID, timestamp: Number(TS) });
  });

  it("accepts any one of several space-separated signatures (key rotation) and white-label headers", () => {
    expect(verifySvix(SECRET, headers({ "svix-signature": `v1,AAAA ${SIG} v2,zzz` }), BODY, AT).ok).toBe(true);
    expect(verifySvix(SECRET, { "webhook-id": ID, "webhook-timestamp": TS, "webhook-signature": SIG }, BODY, AT).ok).toBe(true);
  });

  it("refuses a changed body, a wrong secret, or a wrong id", () => {
    expect(verifySvix(SECRET, headers(), BODY.replace("true", "false"), AT)).toMatchObject({ ok: false, reason: "No matching signature" });
    expect(verifySvix("whsec_" + Buffer.from("another-secret").toString("base64"), headers(), BODY, AT).ok).toBe(false);
    expect(verifySvix(SECRET, headers({ "svix-id": "msg_other" }), BODY, AT).ok).toBe(false);
    expect(verifySvix(SECRET, headers({ "svix-signature": SIG.replace("v1,", "v2,") }), BODY, AT).ok).toBe(false);
  });

  it("refuses timestamps more than five minutes away, either side", () => {
    expect(verifySvix(SECRET, headers(), BODY, AT + 299_000).ok).toBe(true);
    expect(verifySvix(SECRET, headers(), BODY, AT + 301_000)).toMatchObject({ ok: false, reason: expect.stringMatching(/tolerance/) });
    expect(verifySvix(SECRET, headers(), BODY, AT - 301_000).ok).toBe(false);
  });

  it("refuses missing headers, a malformed timestamp, or no secret", () => {
    expect(verifySvix(SECRET, { "svix-id": ID, "svix-timestamp": TS }, BODY, AT).ok).toBe(false);
    expect(verifySvix(SECRET, headers({ "svix-timestamp": "17x" }), BODY, AT).ok).toBe(false);
    expect(verifySvix("", headers(), BODY, AT).ok).toBe(false);
  });
});
