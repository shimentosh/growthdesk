import { advance, callSummary, dialResult, dialTwiml, isUuid, outcomeFromStatus, parentEnded, refusalTwiml, webhookReachability } from "./call-rules.js";
import { twilioSignature, twilioSignatureOk } from "./twilio.js";

describe("call status rules", () => {
  it("only moves a call forward, and never out of a final status", () => {
    expect(advance("queued", "ringing")).toBe("ringing");
    expect(advance("ringing", "in_progress")).toBe("in_progress");
    expect(advance("in_progress", "ringing")).toBeNull();
    expect(advance("ringing", "ringing")).toBeNull();
    expect(advance("in_progress", "completed")).toBe("completed");
    expect(advance("completed", "failed")).toBeNull();
    expect(advance("busy", "completed")).toBeNull();
  });

  it("reads the contact's leg from DialCallStatus", () => {
    expect(dialResult("completed")).toBe("completed");
    expect(dialResult("answered")).toBe("completed");
    expect(dialResult("busy")).toBe("busy");
    expect(dialResult("no-answer")).toBe("no_answer");
    expect(dialResult("canceled")).toBe("canceled");
    expect(dialResult("failed")).toBe("failed");
    expect(dialResult(undefined)).toBe("failed");
    expect(dialResult("ringing")).toBe("failed");
  });

  it("treats a rep leg that ended before our TwiML ran as canceled", () => {
    expect(parentEnded("queued", "no_answer")).toBe("canceled");
    expect(parentEnded("ringing", "busy")).toBe("canceled");
    expect(parentEnded("ringing", "completed")).toBe("canceled");
    expect(parentEnded("in_progress", "completed")).toBe("completed");
    expect(parentEnded("in_progress", "failed")).toBe("failed");
  });

  it("derives only the outcomes Twilio itself establishes", () => {
    expect(outcomeFromStatus("busy")).toBe("busy");
    expect(outcomeFromStatus("no_answer")).toBe("no_answer");
    expect(outcomeFromStatus("completed")).toBeNull();
    expect(outcomeFromStatus("failed")).toBeNull();
    expect(outcomeFromStatus("canceled")).toBeNull();
  });
});

describe("TwiML", () => {
  it("bridges to the contact with our caller id and escapes everything", () => {
    const xml = dialTwiml({ callerId: "+14155550100", to: "+447700900123", actionUrl: "https://app.test/api/webhooks/twilio/k/dial?call=a&b=<x>" });
    expect(xml).toContain('<Dial callerId="+14155550100" action="https://app.test/api/webhooks/twilio/k/dial?call=a&amp;b=&lt;x&gt;" method="POST" answerOnBridge="true" timeout="30">');
    expect(xml).toContain("<Number>+447700900123</Number>");
    expect(xml).not.toMatch(/<Record|<Play/);
  });

  it("speaks a refusal to the rep and hangs up", () => {
    expect(refusalTwiml(`Can't call "Bob" & co`)).toBe(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>Can&apos;t call &quot;Bob&quot; &amp; co</Say><Hangup/></Response>`);
  });
});

describe("Twilio request signatures", () => {
  // The worked example from Twilio's security documentation.
  const token = "12345";
  const url = "https://mycompany.com/myapp.php?foo=1&bar=2";
  const params = { CallSid: "CA1234567890ABCDE", Caller: "+12349013030", Digits: "1234", From: "+12349013030", To: "+18005551212" };

  it("matches Twilio's published example", () => {
    expect(twilioSignature(token, url, params)).toBe("0/KCTR6DLpKmkAf8muzZqo1nDgQ=");
    expect(twilioSignatureOk(token, url, params, "0/KCTR6DLpKmkAf8muzZqo1nDgQ=")).toBe(true);
  });

  it("refuses a changed parameter, a changed URL, a missing header or a missing token", () => {
    const sig = twilioSignature(token, url, params);
    expect(twilioSignatureOk(token, url, { ...params, To: "+18005550000" }, sig)).toBe(false);
    expect(twilioSignatureOk(token, `${url}&x=1`, params, sig)).toBe(false);
    expect(twilioSignatureOk(token, url, params, undefined)).toBe(false);
    expect(twilioSignatureOk("", url, params, sig)).toBe(false);
  });
});

describe("webhook reachability", () => {
  it("refuses loopback and .local addresses unless a local Twilio fake is configured", () => {
    expect(webhookReachability("http://localhost:3600", false)).toMatch(/public address/);
    expect(webhookReachability("http://127.0.0.1:3600", false)).toMatch(/public address/);
    expect(webhookReachability("http://outreach.local", false)).toMatch(/public address/);
    expect(webhookReachability("http://localhost:3600", true)).toBeNull();
    expect(webhookReachability("https://app.example.com", false)).toBeNull();
  });
});

describe("timeline wording", () => {
  it("names the outcome, or the status when there is none, and the length", () => {
    expect(callSummary({ contactName: "Ada", outcome: "connected", status: "completed", durationSec: 192, provider: "twilio" })).toBe("Called Ada: Connected · 3m 12s");
    expect(callSummary({ contactName: "", outcome: "left_voicemail", status: "completed", durationSec: null, provider: "manual" })).toBe("Logged a call with the contact: Left voicemail");
    expect(callSummary({ contactName: "Ada", outcome: "", status: "no_answer", durationSec: 0, provider: "twilio" })).toBe("Called Ada: No answer");
  });

  it("recognises uuids", () => {
    expect(isUuid("0199a3c0-0000-7000-8000-000000000001")).toBe(true);
    expect(isUuid("../etc")).toBe(false);
    expect(isUuid(undefined)).toBe(false);
  });
});
