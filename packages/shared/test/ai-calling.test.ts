import { describe, expect, it } from "vitest";
import {
  AI_AGENT_TEMPLATES,
  AiAgentInput,
  AiCallingSettingsInput,
  AiCallingSettingsPatch,
  AiTestCallInput,
  agentCustomKeys,
  agentFromTemplate,
  agentTokenTrouble,
  aiCallBlocker,
  aiCallVariables,
  aiCallWindow,
  composeInitialMessage,
  composeInstructions,
  endReasonResult,
  heuristicOutcome,
  mentionsAi,
  readAiCallingSettings,
  toProviderText,
  waitBefore,
  toFlow,
} from "../src/index.js";

const ready = (key: string) => ({ ...agentFromTemplate(AI_AGENT_TEMPLATES.find((t) => t.key === key)!, { businessName: "Acme", voiceId: "voice_1" }), about: "Acme sells widgets." });

describe("AI agent templates", () => {
  it("every template becomes a valid agent once a voice and business are chosen", () => {
    for (const t of AI_AGENT_TEMPLATES) {
      const parsed = AiAgentInput.safeParse({ ...agentFromTemplate(t, { businessName: "Acme", voiceId: "voice_1" }) });
      expect(parsed.success, `${t.key}: ${parsed.success ? "" : parsed.error.issues[0]?.message}`).toBe(true);
    }
  });

  it("uses only variables an AI call can fill, and every disclosure says it is an AI", () => {
    for (const t of AI_AGENT_TEMPLATES) {
      for (const text of [t.greeting, t.disclosure, t.about, t.goalDetails, t.voicemailMessage, ...t.questions, ...t.objections.flatMap((o) => [o.objection, o.response])]) {
        expect(agentTokenTrouble(text), `${t.key}: ${text}`).toBeNull();
      }
      expect(mentionsAi(t.disclosure), t.key).toBe(true);
    }
  });

  it("keys are unique", () => {
    expect(new Set(AI_AGENT_TEMPLATES.map((t) => t.key)).size).toBe(AI_AGENT_TEMPLATES.length);
  });
});

describe("AI agent input", () => {
  it("refuses a disclosure that does not say the caller is an AI", () => {
    const r = AiAgentInput.safeParse({ ...ready("speed-to-lead"), disclosure: "This is Ava from Acme." });
    expect(r.success).toBe(false);
    expect(r.success ? "" : r.error.issues[0]?.path.join(".")).toBe("disclosure");
  });

  it("refuses a transfer number that is not international", () => {
    expect(AiAgentInput.safeParse({ ...ready("speed-to-lead"), transferNumber: "555-0100" }).success).toBe(false);
    expect(AiAgentInput.safeParse({ ...ready("speed-to-lead"), transferNumber: "+14155550100" }).success).toBe(true);
  });

  it("flags unknown variables, fallbacks and missing custom fields", () => {
    expect(agentTokenTrouble("Hi {{first_name}} at {{company}}, I'm {{agent_name}}")).toBeNull();
    expect(agentTokenTrouble("Hi {{nickname}}")).toMatch(/not a variable/);
    expect(agentTokenTrouble("Hi {{first_name|there}}")).toMatch(/fallbacks/);
    expect(agentTokenTrouble("About {{custom.industry}}", ["industry"])).toBeNull();
    expect(agentTokenTrouble("About {{custom.industry}}", ["size"])).toMatch(/no contact custom field/);
  });
});

describe("prompt", () => {
  it("opens with the greeting then the disclosure", () => {
    expect(composeInitialMessage({ greeting: "Hi {{first_name}}.", disclosure: "I'm an AI assistant." })).toBe("Hi {{first_name}}. I'm an AI assistant.");
  });

  it("carries the objective, questions, objections, opt-out guardrail and voicemail rule", () => {
    const a = AiAgentInput.parse({ ...ready("speed-to-lead"), voicemailMessage: "", transferNumber: "+14155550100" });
    const p = composeInstructions(a);
    expect(p).toContain("# Objective");
    expect(p).toContain(a.questions[0]);
    expect(p).toContain(a.objections[0]!.objection);
    expect(p).toMatch(/asks not to be called again/);
    expect(p).toMatch(/never claim or imply that you are a human/);
    expect(p).toMatch(/hang up without leaving a message/);
    expect(p).toMatch(/transfer tool/);
  });

  it("fills the agent's own name and business and renames the rest for the provider", () => {
    const out = toProviderText("{{agent_name}} from {{business_name}} for {{ first_name }} about {{custom.Industry}}", { agent_name: "Ava", business_name: "Acme" });
    expect(out).toBe("Ava from Acme for {{first_name}} about {{custom__industry}}");
  });
});

describe("call variables", () => {
  it("sends every variable, falling back instead of a blank", () => {
    const v = aiCallVariables({ firstName: "", fullName: "", company: null, owner: { name: "Sam" } });
    expect(v.first_name).toBe("there");
    expect(v.company).toBe("your company");
    expect(v.owner_name).toBe("Sam");
    expect(v.job_title).toBe("");
  });

  it("adds the custom fields the script reads, case-insensitively", () => {
    expect(agentCustomKeys(["Hi {{custom.industry}}", "{{custom.size}} and {{custom.industry}}"]).sort()).toEqual(["industry", "size"]);
    const v = aiCallVariables({ firstName: "Jo", customFields: { Industry: "Retail" } }, ["industry", "size"]);
    expect(v.custom__industry).toBe("Retail");
    expect(v.custom__size).toBe("");
    expect(v.first_name).toBe("Jo");
  });
});

describe("who may be AI-called", () => {
  const ok = { phone: "+14155550100", consentStatus: "granted", doNotContact: false };
  it("needs recorded consent and a dialable number, and never do-not-contact", () => {
    expect(aiCallBlocker(ok)).toBeNull();
    expect(aiCallBlocker({ ...ok, consentStatus: "unknown" })).toMatch(/consent/);
    expect(aiCallBlocker({ ...ok, consentStatus: "denied" })).toMatch(/consent/);
    expect(aiCallBlocker({ ...ok, phone: null })).toMatch(/phone/);
    expect(aiCallBlocker({ ...ok, doNotContact: true })).toMatch(/do not contact/);
    expect(aiCallBlocker({ ...ok, archivedAt: new Date() })).toMatch(/archived/);
  });

  it("calls only inside the window, in the person's own time zone", () => {
    const s = { windowFrom: "09:00", windowTo: "20:00", days: [1, 2, 3, 4, 5] };
    // Wednesday 2026-10-14 15:00 UTC = 11:00 in New York, 16:00 in London, 00:00 Thursday in Tokyo.
    const now = new Date("2026-10-14T15:00:00Z");
    expect(aiCallWindow(s, "America/New_York", now).open).toBe(true);
    expect(aiCallWindow(s, "Europe/London", now).open).toBe(true);
    const tokyo = aiCallWindow(s, "Asia/Tokyo", now);
    expect(tokyo.open).toBe(false);
    expect(tokyo.nextAt.toISOString()).toBe("2026-10-15T00:00:00.000Z"); // 09:00 Thursday in Tokyo
  });

  it("never lets the window go outside 08:00–21:00", () => {
    expect(AiCallingSettingsInput.safeParse({ windowFrom: "07:30" }).success).toBe(false);
    expect(AiCallingSettingsInput.safeParse({ windowTo: "21:30" }).success).toBe(false);
    expect(AiCallingSettingsInput.safeParse({ windowFrom: "12:00", windowTo: "11:00" }).success).toBe(false);
    expect(AiCallingSettingsInput.parse({})).toMatchObject({ windowFrom: "09:00", windowTo: "20:00", minHoursBetweenCalls: 20 });
    expect(readAiCallingSettings({ windowFrom: "05:00" }).windowFrom).toBe("09:00");
  });

  it("a settings PATCH leaves unsent fields absent", () => {
    expect(AiCallingSettingsPatch.parse({ phoneNumberId: "ap_1" })).toEqual({ phoneNumberId: "ap_1" });
  });

  it("a test call needs the person to vouch for the number", () => {
    expect(AiTestCallInput.safeParse({ toNumber: "+14155550100" }).success).toBe(false);
    expect(AiTestCallInput.safeParse({ toNumber: "+14155550100", consent: true }).success).toBe(true);
    expect(AiTestCallInput.safeParse({ toNumber: "0170000", consent: true }).success).toBe(false);
  });
});

describe("results", () => {
  it("the end reason decides no answer, busy, voicemail and failures", () => {
    expect(endReasonResult("dial_no_answer", false, false)).toEqual({ status: "no_answer", outcome: "no_answer" });
    expect(endReasonResult("dial_timeout", false, false)).toEqual({ status: "no_answer", outcome: "no_answer" });
    expect(endReasonResult("dial_busy", false, false)).toEqual({ status: "busy", outcome: "busy" });
    expect(endReasonResult("voicemail_detected", false, false)).toEqual({ status: "completed", outcome: "left_voicemail" });
    expect(endReasonResult("dial_failed", true, false)).toEqual({ status: "failed", outcome: null });
    expect(endReasonResult("agent_error", true, false)).toEqual({ status: "failed", outcome: null });
  });

  it("a conversation is left for the transcript to decide", () => {
    expect(endReasonResult("client_hangup", false, true)).toEqual({ status: "completed", outcome: null });
    expect(endReasonResult("agent_error", true, true)).toEqual({ status: "completed", outcome: null });
    expect(endReasonResult("client_hangup", false, false)).toEqual({ status: "completed", outcome: "no_answer" });
  });

  it("reads opt-outs first, then the other outcomes", () => {
    const say = (text: string) => [
      { role: "assistant" as const, text: "Hi, I'm an AI assistant." },
      { role: "user" as const, text },
    ];
    expect(heuristicOutcome(say("I'm not interested, and please stop calling me"))).toBe("do_not_call");
    expect(heuristicOutcome(say("Sorry, wrong number"))).toBe("wrong_number");
    expect(heuristicOutcome(say("No thanks, not interested"))).toBe("not_interested");
    expect(heuristicOutcome(say("Can you call me back tomorrow?"))).toBe("callback_requested");
    expect(heuristicOutcome(say("Sure, tell me more"))).toBe("connected");
    expect(heuristicOutcome([{ role: "assistant", text: "Hello?" }])).toBe("no_answer");
  });
});

describe("flow", () => {
  it("two AI calls in a row never ring the same day", () => {
    const flow = toFlow([
      { type: "ai_call", config: {} },
      { type: "ai_call", config: {} },
    ]);
    expect(waitBefore(flow, 0, 1)).toBe(1440);
  });
});
