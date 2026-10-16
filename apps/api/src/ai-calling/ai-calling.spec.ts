import { describe, expect, it } from "vitest";
import type { CallAgent } from "../generated/prisma/client.js";
import { cartesiaConfig, providerTexts, webhookProblem } from "./ai-calling-rules.js";
import { analysisPrompt, heuristicAnalysis, parseAnalysis, personSpoke, toTurns } from "./call-analysis.js";

const agent = (over: Partial<CallAgent> = {}): CallAgent => ({
  id: "0190f0f0-0000-7000-8000-000000000001",
  workspaceId: "0190f0f0-0000-7000-8000-000000000002",
  name: "Speed to lead",
  templateKey: "speed-to-lead",
  goal: "book_meeting",
  language: "en",
  voiceId: "voice_1",
  voiceName: "Ava",
  personaName: "Ava",
  businessName: "Acme",
  greeting: "Hi {{first_name}}, thanks for contacting {{business_name}}.",
  disclosure: "I'm {{agent_name}}, an AI assistant.",
  about: "Acme sells widgets to {{custom.industry}} teams.",
  goalDetails: "",
  questions: ["What prompted you to reach out?"],
  objections: [{ objection: "Too busy", response: "Offer a callback." }],
  voicemailMessage: "",
  extraInstructions: "",
  transferNumber: "",
  maxCallMinutes: 5,
  integrationId: null,
  providerAgentId: null,
  syncedAt: null,
  syncError: "",
  archivedAt: null,
  createdById: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

describe("the agent as Cartesia stores it", () => {
  it("fills the agent's name and business, renames the rest to provider variables", () => {
    const t = providerTexts(agent());
    expect(t.initialMessage).toBe("Hi {{first_name}}, thanks for contacting Acme. I'm Ava, an AI assistant.");
    expect(t.instructions).toContain("You are Ava, an AI assistant calling on behalf of Acme.");
    expect(t.instructions).toContain("{{custom__industry}}");
    expect(t.instructions).not.toContain("{{agent_name}}");
  });

  it("turns on end-call always, and transfers only with a number", () => {
    const plain = cartesiaConfig(agent());
    expect(plain.system_tools.end_call).not.toBeNull();
    expect(plain.system_tools.transfer_to_number).toBeNull();
    expect(plain.audio.output.voice_id).toBe("voice_1");
    expect(plain.dynamic_variable_placeholders).toHaveProperty("custom__industry");
    const withTransfer = cartesiaConfig(agent({ transferNumber: "+14155550100" }));
    expect(withTransfer.system_tools.transfer_to_number?.transfers[0]?.destination.phone_number).toBe("+14155550100");
  });

  it("knows when Cartesia cannot post back to us", () => {
    expect(webhookProblem("http://localhost:3600")).toMatch(/only reachable/);
    expect(webhookProblem("http://app.example.com")).toMatch(/https/);
    expect(webhookProblem("https://app.example.com")).toBeNull();
  });
});

describe("judging a call", () => {
  const raw = [
    { role: "assistant", text: "Hi Jo, I'm Ava, an AI assistant.", start_timestamp: 0.4, end_timestamp: 3.1 },
    { role: "system", text: "tool call" },
    { role: "user", text: "  ", start_timestamp: 3.2 },
    { role: "user", text: "Sure, Tuesday at 3pm works.", start_timestamp: 4.1, end_timestamp: 6.2 },
  ];

  it("keeps the spoken turns only", () => {
    const turns = toTurns(raw);
    expect(turns).toHaveLength(2);
    expect(turns[1]).toEqual({ role: "user", text: "Sure, Tuesday at 3pm works.", start: 4.1, end: 6.2 });
    expect(personSpoke(turns)).toBe(true);
    expect(personSpoke(toTurns(raw.slice(0, 2)))).toBe(false);
    expect(toTurns("nope")).toEqual([]);
  });

  it("builds a prompt that names the outcomes, the time and the transcript", () => {
    const p = analysisPrompt({ turns: toTurns(raw), questions: ["Budget?"], goal: "book_meeting", now: new Date("2026-10-14T15:00:00Z"), timeZone: "America/New_York", contactName: "Jo" });
    expect(p.system).toContain('"meeting_booked"');
    expect(p.messages[0]!.content).toContain("2026-10-14T15:00:00.000Z");
    expect(p.messages[0]!.content).toContain("Person: Sure, Tuesday at 3pm works.");
    expect(p.messages[0]!.content).toContain("1. Budget?");
  });

  it("reads the model's JSON, with or without fences, and drops a bad callback time", () => {
    const a = parseAnalysis('```json\n{"outcome":"meeting_booked","interest":"hot","summary":"Wants a demo.","callbackAt":"soon","meetingTime":"Tuesday at 3pm","nextStep":"Send invite","answers":[{"question":"Budget?","answer":"Yes"}]}\n```');
    expect(a).toMatchObject({ outcome: "meeting_booked", interest: "hot", meetingTime: "Tuesday at 3pm", callbackAt: null, method: "ai" });
    expect(parseAnalysis('{"outcome":"callback_requested","callbackAt":"2026-10-15T14:00:00Z"}').callbackAt?.toISOString()).toBe("2026-10-15T14:00:00.000Z");
    expect(() => parseAnalysis("I think it went well")).toThrow();
    expect(() => parseAnalysis('{"outcome":"great"}')).toThrow();
  });

  it("falls back to the words without a model", () => {
    const a = heuristicAnalysis(toTurns([{ role: "user", text: "Please remove me from your list" }]), "They opted out.");
    expect(a).toMatchObject({ outcome: "do_not_call", interest: "cold", summary: "They opted out.", method: "heuristic" });
  });
});
