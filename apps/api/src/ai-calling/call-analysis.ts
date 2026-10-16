import { AiCallAnalysis, CALL_OUTCOMES, heuristicOutcome, type AiCallAnalysisT, type TranscriptTurn } from "@growthdesk/shared";
import type { AiRequest } from "../ai/ai.provider.js";

/*
 * Judging a finished AI call: what happened (the outcome a rep would have
 * recorded), how interested the person sounded, and what the team should do
 * next. With an AI model this reads the transcript (one light-tier request,
 * one AI credit); without one, heuristicOutcome() reads the words. Pure, so
 * it is unit-tested on its own (call-analysis.spec.ts).
 */

const MAX_TRANSCRIPT_CHARS = 24_000;

/** Cartesia's transcript turns → ours (system turns and empty text dropped). */
export function toTurns(raw: unknown): TranscriptTurn[] {
  if (!Array.isArray(raw)) return [];
  const out: TranscriptTurn[] = [];
  for (const t of raw) {
    if (!t || typeof t !== "object") continue;
    const r = t as Record<string, unknown>;
    const role = r.role === "assistant" || r.role === "user" ? r.role : null;
    const text = typeof r.text === "string" ? r.text.trim() : "";
    if (!role || !text) continue;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) / 100 : undefined);
    out.push({
      role,
      text: text.slice(0, 4000),
      start: num(r.start_timestamp ?? r.start),
      end: num(r.end_timestamp ?? r.end),
    });
  }
  return out.slice(0, 500);
}

export const personSpoke = (turns: TranscriptTurn[]) => turns.some((t) => t.role === "user" && t.text.trim().length > 0);

/** The transcript as the model reads it: "Agent: …" / "Person: …", newest cut first when it is very long. */
export function transcriptText(turns: TranscriptTurn[]): string {
  const lines = turns.map((t) => `${t.role === "assistant" ? "Agent" : "Person"}: ${t.text}`);
  let text = lines.join("\n");
  if (text.length > MAX_TRANSCRIPT_CHARS) text = `${text.slice(0, MAX_TRANSCRIPT_CHARS)}\n[transcript cut short]`;
  return text;
}

export function analysisPrompt(input: { turns: TranscriptTurn[]; questions: string[]; goal: string; now: Date; timeZone: string; contactName: string }): AiRequest {
  const system = [
    "You review the transcript of a phone call that an AI assistant made on behalf of a business, and report what happened for the sales team's CRM.",
    "Answer with one JSON object and nothing else (no code fences), with exactly these keys:",
    `  "outcome": one of ${CALL_OUTCOMES.map((o) => `"${o}"`).join(", ")}.`,
    "    meeting_booked = they agreed a specific day/time to meet; callback_requested = they asked to be called back later; not_interested = they declined;",
    "    do_not_call = they asked not to be called again or to be removed (this wins over everything else); wrong_number = wrong person or number;",
    "    left_voicemail = the agent reached voicemail; connected = a real conversation with none of the above; other = anything else.",
    '  "interest": "hot" (wants to move forward now), "warm" (open, not urgent), "cold" (not interested) or "unknown".',
    '  "summary": two sentences at most, factual, in English, naming what they said they need.',
    '  "callbackAt": the ISO 8601 date-time they asked to be called back at, resolved against the current time and their time zone below, or null.',
    '  "meetingTime": the meeting day/time they agreed to, in plain words ("Tuesday 14 October at 3pm"), or "".',
    '  "nextStep": one sentence: what a person on the team should do next, or "".',
    '  "answers": an array of {"question", "answer"} for the qualifying questions below that the person actually answered (omit unanswered ones).',
    "Judge only from what the Person said, not from what the Agent hoped. Never invent details.",
  ].join("\n");
  const user = [
    `Current time: ${input.now.toISOString()} (the person's time zone: ${input.timeZone}).`,
    `Person called: ${input.contactName || "unknown"}. The call's goal: ${input.goal}.`,
    input.questions.length ? `Qualifying questions:\n${input.questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}` : "Qualifying questions: none.",
    "",
    "Transcript:",
    transcriptText(input.turns),
  ].join("\n");
  return {
    system,
    messages: [{ role: "user", content: user }],
    maxTokens: 800,
  };
}

/** The model's answer, checked against AiCallAnalysis. Throws when it is not usable (the engine then refunds the credit). */
export function parseAnalysis(text: string): AiCallAnalysisT {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in the answer");
  const raw = JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
  if (raw.callbackAt === "" || raw.callbackAt === undefined) raw.callbackAt = null;
  if (typeof raw.callbackAt === "string" && Number.isNaN(Date.parse(raw.callbackAt))) raw.callbackAt = null;
  if (Array.isArray(raw.answers)) raw.answers = raw.answers.slice(0, 10);
  if (typeof raw.summary === "string") raw.summary = raw.summary.slice(0, 1000);
  if (typeof raw.nextStep === "string") raw.nextStep = raw.nextStep.slice(0, 500);
  if (typeof raw.meetingTime === "string") raw.meetingTime = raw.meetingTime.slice(0, 200);
  return AiCallAnalysis.parse({ ...raw, method: "ai" });
}

/** The analysis without a model: the outcome from the words, the provider's own summary. */
export function heuristicAnalysis(turns: TranscriptTurn[], summary: string): AiCallAnalysisT {
  const outcome = heuristicOutcome(turns);
  return AiCallAnalysis.parse({
    outcome,
    interest: outcome === "not_interested" || outcome === "do_not_call" ? "cold" : "unknown",
    summary: summary.slice(0, 1000),
    method: "heuristic",
  });
}
