import { z } from "zod";
import { CALL_OUTCOMES, type CallOutcome, type CallStatus } from "./enums.js";
import { normalizePhone } from "./normalize.js";
import { patchOf } from "./patch.js";
import { isOpenNow, nextOpening } from "./schedule.js";
import { isoDate, optionalUuid, requiredText, text, uuid } from "./schemas.js";

/*
 * AI calling: a voice agent (Cartesia Managed Agents) phones a contact, talks
 * to them from a script the workspace wrote, and the result comes back as an
 * ordinary Call with a transcript, a summary and an outcome.
 *
 * This file holds what both sides read: the agent's input, the variables a
 * script may use, how an agent's fields become the prompt the voice model
 * runs on, the calling-hours and consent rules, how a finished call's end
 * reason becomes a status and outcome, and the ready-made agent templates.
 *
 * Compliance is built in rather than left to configuration, because the
 * people called are mostly in the US, UK and EU, where automated / AI-voice
 * calls need the person's prior consent (US TCPA as read by the FCC in 2024,
 * UK PECR reg. 19, EU ePrivacy art. 13):
 *   - a campaign or workflow only AI-calls contacts whose consent is recorded
 *     as granted (Contact.consentStatus), and never one on the do-not-contact
 *     list or marked do-not-contact;
 *   - calls are placed only inside the calling window in the contact's own
 *     time zone, which can never be wider than 08:00–21:00 local;
 *   - every agent opens by saying it is an AI (the disclosure must say so) and
 *     treats "stop calling me" as an opt-out that ends the call.
 */

export const AI_CALL_PROVIDERS = ["cartesia"] as const;
export type AiCallProvider = (typeof AI_CALL_PROVIDERS)[number];

export const AI_AGENT_GOALS = ["book_meeting", "qualify", "reengage", "confirm", "custom"] as const;
export type AiAgentGoal = (typeof AI_AGENT_GOALS)[number];

export const AI_AGENT_GOAL_LABELS: Record<AiAgentGoal, string> = {
  book_meeting: "Book a meeting",
  qualify: "Qualify the lead",
  reengage: "Re-engage an old lead",
  confirm: "Confirm or remind",
  custom: "Something else",
};

/** Languages the voice agent speaks (a subset of Cartesia's, the ones its voices cover best). */
export const AI_AGENT_LANGUAGES = [
  { code: "en", label: "English" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "it", label: "Italian" },
  { code: "pt", label: "Portuguese" },
  { code: "nl", label: "Dutch" },
  { code: "sv", label: "Swedish" },
  { code: "pl", label: "Polish" },
  { code: "hi", label: "Hindi" },
  { code: "bn", label: "Bengali" },
  { code: "ar", label: "Arabic" },
  { code: "tr", label: "Turkish" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
  { code: "zh", label: "Chinese" },
] as const;
export type AiAgentLanguage = (typeof AI_AGENT_LANGUAGES)[number]["code"];
const LANGUAGE_CODES = AI_AGENT_LANGUAGES.map((l) => l.code) as [AiAgentLanguage, ...AiAgentLanguage[]];

/** How interested the person sounded, as judged after the call. */
export const AI_CALL_INTEREST = ["hot", "warm", "cold", "unknown"] as const;
export type AiCallInterest = (typeof AI_CALL_INTEREST)[number];

// ─── Variables ───────────────────────────────────────────────────────────────

/**
 * What a script may say about the person being called, as {{key}}. Each is
 * sent with every call (Cartesia dynamic variables); an empty value is sent
 * as its fallback so the agent never reads out a blank ("Hi , …").
 * Contact custom fields are available as {{custom.<key>}}.
 */
export const AI_CALL_VARIABLES = [
  { key: "first_name", label: "First name", fallback: "there" },
  { key: "last_name", label: "Last name", fallback: "" },
  { key: "full_name", label: "Full name", fallback: "there" },
  { key: "company", label: "Company", fallback: "your company" },
  { key: "job_title", label: "Job title", fallback: "" },
  { key: "city", label: "City", fallback: "" },
  { key: "country", label: "Country", fallback: "" },
  { key: "owner_name", label: "Contact owner", fallback: "our team" },
  { key: "lead_source", label: "Lead source", fallback: "" },
] as const;

/** Fixed for an agent and filled in when it is saved to the voice provider: {{agent_name}}, {{business_name}}. */
export const AI_AGENT_STATIC_VARIABLES = [
  { key: "agent_name", label: "Agent's name" },
  { key: "business_name", label: "Your business name" },
] as const;

const CALL_KEYS = new Set<string>(AI_CALL_VARIABLES.map((v) => v.key));
const STATIC_KEYS = new Set<string>(AI_AGENT_STATIC_VARIABLES.map((v) => v.key));
const TOKEN = /\{\{\s*([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)?)\s*(\|[^}]*)?\}\}/gi;

/** Every {{token}} in the text, lower-cased, with whether it carried a "|fallback" (not supported in agent scripts). */
function tokens(text: string): { name: string; fallback: boolean }[] {
  return [...text.matchAll(TOKEN)].map((m) => ({
    name: (m[1] ?? "").toLowerCase(),
    fallback: m[2] !== undefined,
  }));
}

/** The provider's name for a token: custom.industry → custom__industry (Cartesia names allow letters, digits and _ only). */
export const providerVariable = (name: string) => name.toLowerCase().replace(/^custom\./, "custom__");

/**
 * Problems with the tokens in an agent's text: unknown names, and "|fallback"
 * (each variable has one fallback, AI_CALL_VARIABLES, instead). Custom field
 * keys are checked when the caller passes them.
 */
export function agentTokenTrouble(text: string, customKeys?: readonly string[]): string | null {
  const custom = customKeys ? new Set(customKeys.map((k) => `custom.${k.toLowerCase()}`)) : null;
  for (const t of tokens(text)) {
    if (t.fallback) return `{{${t.name}|…}}: fallbacks are not used in AI agent scripts — each variable already has one.`;
    if (CALL_KEYS.has(t.name) || STATIC_KEYS.has(t.name)) continue;
    if (t.name.startsWith("custom.")) {
      if (custom && !custom.has(t.name)) return `{{${t.name}}}: there is no contact custom field "${t.name.slice(7)}".`;
      continue;
    }
    return `{{${t.name}}} is not a variable an AI call can use.`;
  }
  return null;
}

/** The custom fields an agent's text reads, as keys without the "custom." prefix. */
export function agentCustomKeys(texts: string[]): string[] {
  return [
    ...new Set(
      texts
        .flatMap((t) => tokens(t).map((x) => x.name))
        .filter((n) => n.startsWith("custom."))
        .map((n) => n.slice(7)),
    ),
  ];
}

/**
 * Agent text as the provider stores it: static tokens filled in, every other
 * token renamed to its provider variable ({{custom.x}} → {{custom__x}}).
 */
export function toProviderText(text: string, statics: { agent_name: string; business_name: string }): string {
  return text.replace(TOKEN, (_whole, raw: string) => {
    const name = raw.toLowerCase();
    if (name === "agent_name") return statics.agent_name;
    if (name === "business_name") return statics.business_name;
    return `{{${providerVariable(name)}}}`;
  });
}

export type AiCallContact = {
  firstName?: string | null;
  lastName?: string | null;
  fullName?: string | null;
  jobTitle?: string | null;
  city?: string | null;
  country?: string | null;
  leadSource?: string | null;
  customFields?: unknown;
  company?: { name?: string | null } | null;
  owner?: { name?: string | null } | null;
};

/** The per-call values sent with a call: every standard variable (or its fallback) and the custom fields the agent reads. */
export function aiCallVariables(contact: AiCallContact, customKeys: readonly string[] = []): Record<string, string> {
  const raw: Record<string, string> = {
    first_name: contact.firstName ?? "",
    last_name: contact.lastName ?? "",
    full_name: contact.fullName || [contact.firstName, contact.lastName].filter(Boolean).join(" "),
    company: contact.company?.name ?? "",
    job_title: contact.jobTitle ?? "",
    city: contact.city ?? "",
    country: contact.country ?? "",
    owner_name: contact.owner?.name ?? "",
    lead_source: contact.leadSource ?? "",
  };
  const out: Record<string, string> = {};
  for (const v of AI_CALL_VARIABLES) out[v.key] = (raw[v.key] ?? "").trim().slice(0, 300) || v.fallback;
  const custom = contact.customFields && typeof contact.customFields === "object" && !Array.isArray(contact.customFields) ? (contact.customFields as Record<string, unknown>) : {};
  const lower = new Map(Object.entries(custom).map(([k, v]) => [k.toLowerCase(), v]));
  for (const key of customKeys) {
    const value = lower.get(key.toLowerCase());
    out[providerVariable(`custom.${key}`)] = value === null || value === undefined ? "" : String(value).slice(0, 300);
  }
  return out;
}

// ─── The agent ───────────────────────────────────────────────────────────────

/** True when the disclosure tells the person they are talking to an AI / automated assistant. */
export const mentionsAi = (s: string) => /\b(ai|a\.i\.|artificial|automated|virtual assistant|digital assistant)\b/i.test(s);

const e164 = (label: string) =>
  text(20)
    .optional()
    .refine((v) => !v || normalizePhone(v) !== null, `${label}: use international format, e.g. +14155550100`);

export const AiAgentObjection = z.object({
  objection: requiredText(300),
  response: requiredText(800),
});

/** POST /call-agents, PATCH /call-agents/:id (every field optional on PATCH). */
export const AiAgentInput = z.object({
  name: requiredText(80),
  /** The template it started from (AI_AGENT_TEMPLATES), for reference only. */
  templateKey: text(60).optional(),
  goal: z.enum(AI_AGENT_GOALS).default("book_meeting"),
  language: z.enum(LANGUAGE_CODES).default("en"),
  /** A Cartesia voice id (GET /ai-calling/voices). */
  voiceId: requiredText(100),
  voiceName: text(120).optional(),
  /** What the agent calls itself, e.g. "Ava". */
  personaName: requiredText(40),
  businessName: requiredText(120),
  /** The first thing it says, before the disclosure. */
  greeting: requiredText(500),
  /** Said right after the greeting; must tell the person this is an AI. */
  disclosure: requiredText(300).refine(mentionsAi, "The disclosure must say the caller is an AI (for example “I'm an AI assistant”)."),
  /** What the business does and offers: the facts the agent may use. */
  about: requiredText(4000),
  /** What a good call ends with, in the agent's terms. */
  goalDetails: text(2000).default(""),
  questions: z.array(requiredText(300)).max(10).default([]),
  objections: z.array(AiAgentObjection).max(15).default([]),
  /** Left on voicemail; empty = hang up without a message. */
  voicemailMessage: text(500).default(""),
  extraInstructions: text(4000).default(""),
  /** A person to hand the call to when asked; empty = no transfers. */
  transferNumber: e164("Transfer number"),
  maxCallMinutes: z.number().int().min(1).max(20).default(5),
});
export type AiAgentInputT = z.infer<typeof AiAgentInput>;

/** The fields composeInstructions reads (an agent row or an input). */
export type AgentScript = Pick<
  AiAgentInputT,
  | "goal"
  | "personaName"
  | "businessName"
  | "greeting"
  | "disclosure"
  | "about"
  | "goalDetails"
  | "questions"
  | "objections"
  | "voicemailMessage"
  | "extraInstructions"
  | "transferNumber"
  | "maxCallMinutes"
>;

const GOAL_LINE: Record<AiAgentGoal, string> = {
  book_meeting: "Find out whether the person is a fit and, if they are, agree a day and time for a short meeting with our team.",
  qualify: "Find out whether the person is a fit by asking the qualifying questions, and learn what they need.",
  reengage: "Reconnect with someone who showed interest before, find out where things stand, and offer a next step.",
  confirm: "Confirm the person's details or appointment, answer simple questions, and note any change they ask for.",
  custom: "Reach the outcome described below.",
};

/**
 * The prompt the voice model runs on, in the sections Cartesia recommends
 * (identity, speaking rules, objective, guardrails). Tokens stay as written;
 * toProviderText() converts them when the agent is saved to the provider.
 */
export function composeInstructions(a: AgentScript): string {
  const lines: string[] = [];
  lines.push(
    "# Identity",
    `You are {{agent_name}}, an AI assistant calling on behalf of {{business_name}}. You are on an outbound phone call with {{full_name}} (job title: {{job_title}}, company: {{company}}).`,
    "You are an AI, and you never claim or imply that you are a human. If asked, say plainly that you are an AI assistant.",
    "",
    "# Speaking rules",
    "This is a phone call: keep every reply to one or two short sentences, ask one question at a time, and stop talking when the person starts.",
    "Sound warm, relaxed and professional. Never read out lists, URLs, markdown or symbols. Say numbers and times the way people say them.",
    "If you did not catch something, ask the person to repeat it instead of guessing.",
    "",
    "# About {{business_name}}",
    a.about.trim(),
    "",
    "# Objective",
    GOAL_LINE[a.goal],
  );
  if (a.goalDetails.trim()) lines.push(a.goalDetails.trim());
  if (a.questions.length) {
    lines.push("", "# Questions to work in naturally (not as an interrogation; skip any already answered)");
    a.questions.forEach((q, i) => lines.push(`${i + 1}. ${q.trim()}`));
  }
  if (a.objections.length) {
    lines.push("", "# If they say… (answer in your own words, briefly; never argue or push more than once)");
    for (const o of a.objections) lines.push(`- "${o.objection.trim()}": ${o.response.trim()}`);
  }
  lines.push(
    "",
    "# Guardrails",
    "- If the person asks not to be called again, or to be removed from the list, apologise, confirm they will not be called again, and end the call politely. Do not try to change their mind.",
    "- If it is a bad time, offer to call back and ask when suits them, then end the call.",
    "- If you reached the wrong person or number, apologise and end the call.",
    "- Only state facts given above. If you do not know an answer, say a colleague will follow up — never invent prices, dates, features or promises.",
    "- Never ask for or accept payment details, passwords, or sensitive personal data.",
    `- Keep the whole call under ${a.maxCallMinutes} minute${a.maxCallMinutes === 1 ? "" : "s"}; wrap up politely before then.`,
  );
  if (a.transferNumber?.trim()) {
    lines.push("- If the person asks to speak to a person now, or wants details you cannot give, offer to transfer them to a colleague and use the transfer tool.");
  }
  lines.push(
    "",
    "# Voicemail",
    a.voicemailMessage.trim()
      ? `If you reach voicemail or an answering machine, leave this short message and hang up: "${a.voicemailMessage.trim()}"`
      : "If you reach voicemail or an answering machine, hang up without leaving a message.",
    "",
    "# Ending the call",
    "Before you hang up, briefly confirm what was agreed (for example the meeting day and time, or when to call back), thank them, and say goodbye.",
  );
  if (a.extraInstructions.trim()) lines.push("", "# Additional instructions", a.extraInstructions.trim());
  return lines.join("\n");
}

/** What the agent says when the person picks up: the greeting, then the AI disclosure. */
export const composeInitialMessage = (a: Pick<AgentScript, "greeting" | "disclosure">) => `${a.greeting.trim()} ${a.disclosure.trim()}`.trim();

// ─── Calling rules ───────────────────────────────────────────────────────────

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
/** The widest window any AI call may be placed in, in the contact's local time (US TCPA: 8 am – 9 pm). */
export const AI_CALL_HARD_WINDOW = { from: "08:00", to: "21:00" } as const;
const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

const AiCallingSettingsFields = z.object({
  /** Local time in the person's own time zone. */
  windowFrom: z.string().regex(HHMM, "Use HH:MM").default("09:00"),
  windowTo: z.string().regex(HHMM, "Use HH:MM").default("20:00"),
  /** Days of the week calls may go out (0 = Sunday). */
  days: z.array(z.number().int().min(0).max(6)).min(1).max(7).default([1, 2, 3, 4, 5]),
  /** The same person is not AI-called again within this many hours. */
  minHoursBetweenCalls: z
    .number()
    .int()
    .min(1)
    .max(24 * 30)
    .default(20),
  /** Which phone number on the Cartesia account places the calls. */
  phoneNumberId: text(100).optional(),
});

/** The workspace's AI calling settings (stored on the Cartesia connection). */
export const AiCallingSettingsInput = AiCallingSettingsFields.superRefine((v, ctx) => {
  if (minutes(v.windowFrom) < minutes(AI_CALL_HARD_WINDOW.from))
    ctx.addIssue({
      code: "custom",
      path: ["windowFrom"],
      message: "Calls cannot start before 08:00 local time.",
    });
  if (minutes(v.windowTo) > minutes(AI_CALL_HARD_WINDOW.to))
    ctx.addIssue({
      code: "custom",
      path: ["windowTo"],
      message: "Calls cannot go past 21:00 local time.",
    });
  if (minutes(v.windowTo) <= minutes(v.windowFrom))
    ctx.addIssue({
      code: "custom",
      path: ["windowTo"],
      message: "The window must end after it starts.",
    });
});
export type AiCallingSettingsT = z.infer<typeof AiCallingSettingsInput>;

/** PATCH /ai-calling/settings: any of the fields (merged with what is stored, then checked as a whole). */
export const AiCallingSettingsPatch = patchOf(AiCallingSettingsFields);

export const DEFAULT_AI_CALLING_SETTINGS: AiCallingSettingsT = AiCallingSettingsInput.parse({});

/** Stored settings, read leniently: anything invalid falls back to the defaults. */
export function readAiCallingSettings(raw: unknown): AiCallingSettingsT {
  const parsed = AiCallingSettingsInput.safeParse(raw && typeof raw === "object" ? raw : {});
  return parsed.success ? parsed.data : DEFAULT_AI_CALLING_SETTINGS;
}

/**
 * Whether a contact may be AI-called now, in their own time zone (the
 * workspace's when theirs is unknown or invalid). `nextAt` is when the window
 * next opens; it is the same instant as `now` when it is open now.
 */
export function aiCallWindow(settings: Pick<AiCallingSettingsT, "windowFrom" | "windowTo" | "days">, timeZone: string, now: Date = new Date()): { open: boolean; nextAt: Date } {
  const schedule = {
    timezone: timeZone,
    days: settings.days,
    from: settings.windowFrom,
    to: settings.windowTo,
  };
  if (isOpenNow(schedule, now)) return { open: true, nextAt: now };
  return { open: false, nextAt: nextOpening(schedule, now) };
}

/** Why this contact must not be AI-called at all (as opposed to "not now"), or null. */
export function aiCallBlocker(c: { phone: string | null; consentStatus: string; doNotContact: boolean; deletedAt?: Date | null; archivedAt?: Date | null }): string | null {
  if (c.deletedAt) return "The contact was deleted.";
  if (c.archivedAt) return "The contact is archived.";
  if (c.doNotContact) return "The contact is marked do not contact.";
  if (!normalizePhone(c.phone)) return "The contact has no phone number in international format.";
  if (c.consentStatus !== "granted") return "No consent to be called is recorded for this contact (AI calls need it).";
  return null;
}

// ─── Results ─────────────────────────────────────────────────────────────────

/** Cartesia's call end reasons (GET /agents/calls/{id} → end_reason). */
export const CARTESIA_END_REASONS = [
  "agent_hangup",
  "voicemail_detected",
  "client_hangup",
  "api_cancelled",
  "max_duration",
  "call_inactivity",
  "client_inactivity",
  "client_disconnected",
  "dial_no_answer",
  "dial_busy",
  "dial_failed",
  "dial_timeout",
  "concurrency_limit",
  "agent_error",
  "network_error",
  "config_error",
  "error",
] as const;

export type TranscriptTurn = {
  role: "assistant" | "user" | "system";
  text: string;
  start?: number;
  end?: number;
};

/**
 * What an ended call's end reason establishes on its own: the line status, and
 * an outcome when the reason alone decides it (nobody answered, busy,
 * voicemail). A conversation's outcome is judged from its transcript instead
 * (`outcome: null`). A call that never connected because of an error has no
 * outcome at all.
 */
export function endReasonResult(endReason: string | null | undefined, failed: boolean, personSpoke: boolean): { status: CallStatus; outcome: CallOutcome | null } {
  switch (endReason) {
    case "dial_no_answer":
    case "dial_timeout":
      return { status: "no_answer", outcome: "no_answer" };
    case "dial_busy":
      return { status: "busy", outcome: "busy" };
    case "voicemail_detected":
      return { status: "completed", outcome: "left_voicemail" };
    case "api_cancelled":
      return { status: "canceled", outcome: null };
    case "dial_failed":
    case "concurrency_limit":
    case "config_error":
      return { status: "failed", outcome: null };
  }
  if (failed && !personSpoke) return { status: "failed", outcome: null };
  return { status: "completed", outcome: personSpoke ? null : "no_answer" };
}

/**
 * The outcome read from the words alone, for when no AI model is available
 * to judge the call. Opt-outs win over everything else.
 */
export function heuristicOutcome(turns: TranscriptTurn[]): CallOutcome {
  const said = turns
    .filter((t) => t.role === "user")
    .map((t) => t.text.toLowerCase())
    .join(" \n ");
  if (!said.trim()) return "no_answer";
  if (/\b(stop calling|don'?t call|do not call|remove me|take me off|unsubscribe|never call)\b/.test(said)) return "do_not_call";
  if (/\b(wrong number|wrong person|no one by that name|nobody by that name)\b/.test(said)) return "wrong_number";
  if (/\b(not interested|no thanks|no thank you|we'?re good|not for us)\b/.test(said)) return "not_interested";
  if (/\b(call (me )?back|call later|bad time|busy right now|try (me )?(again )?later)\b/.test(said)) return "callback_requested";
  return "connected";
}

/** A finished AI call as judged after the fact (by the AI model, or heuristics without one). */
export const AiCallAnalysis = z.object({
  outcome: z.enum(CALL_OUTCOMES),
  interest: z.enum(AI_CALL_INTEREST).default("unknown"),
  summary: text(1000).default(""),
  /** When the person asked to be called back (ISO 8601), if they named a time. */
  callbackAt: isoDate.nullable().default(null),
  /** The day/time they agreed to meet, in their own words ("Tuesday at 3pm"). */
  meetingTime: text(200).default(""),
  /** What a person on the team should do next. */
  nextStep: text(500).default(""),
  /** Answers to the agent's qualifying questions, question → answer. */
  answers: z
    .array(z.object({ question: text(300), answer: text(500) }))
    .max(10)
    .default([]),
  /** heuristic: judged without an AI model. */
  method: z.enum(["ai", "heuristic"]).default("ai"),
});
export type AiCallAnalysisT = z.infer<typeof AiCallAnalysis>;

// ─── API inputs ──────────────────────────────────────────────────────────────

/** POST /ai-calling/cartesia — connect the workspace's Cartesia account. */
export const CartesiaConnectInput = z.object({
  name: text(80).optional(),
  apiKey: z.string().trim().min(10, "Paste the API key from play.cartesia.ai/keys").max(300),
});

/** POST /call-agents/:id/test-call — the agent rings a phone the person says is theirs (or someone who agreed to it). */
export const AiTestCallInput = z.object({
  toNumber: requiredText(40).refine((v) => normalizePhone(v) !== null, "Use international format, e.g. +14155550100"),
  /** Sample values for the script's variables (first_name, company…). */
  variables: z.record(z.string().max(64), z.string().max(300)).optional(),
  consent: z.literal(true, {
    error: "Confirm this is your number, or that its owner agreed to a test call.",
  }),
});

/** POST /call-agents/:id/call — one AI call to one contact now (the same rules a campaign step applies). */
export const AiCallContactInput = z.object({ contactId: uuid });

/** GET /ai-calling/voices */
export const AiVoicesQuery = z.object({
  q: text(100).optional(),
  language: z.enum(LANGUAGE_CODES).optional(),
  gender: z.enum(["feminine", "masculine", "gender_neutral"]).optional(),
});

/** GET /call-agents */
export const AiAgentListQuery = z.object({
  archived: z.enum(["exclude", "only", "all"]).default("exclude"),
});

/** The ai_call sequence step's config (StepInput.config for type ai_call). */
export const AiCallStepConfig = z.object({ agentId: optionalUuid });

// ─── Templates ───────────────────────────────────────────────────────────────

export type AiAgentTemplate = {
  key: string;
  name: string;
  /** One line for the gallery card. */
  summary: string;
  /** When to use it, for the card's detail. */
  bestFor: string;
  goal: AiAgentGoal;
  greeting: string;
  disclosure: string;
  about: string;
  goalDetails: string;
  questions: string[];
  objections: { objection: string; response: string }[];
  voicemailMessage: string;
  extraInstructions: string;
  maxCallMinutes: number;
};

const DISCLOSURE = "I'm {{agent_name}}, an AI assistant calling for {{business_name}}, and this call may be recorded.";
const ABOUT_PLACEHOLDER =
  "{{business_name}} helps [who you help] to [the result you deliver]. Replace this paragraph with two or three short facts: what you offer, who it is for, and one proof point (a customer result or a number). The agent will only say what is written here.";

const COMMON_OBJECTIONS = {
  busy: {
    objection: "I'm busy right now",
    response: "Totally understand. Ask if there is a better time later today or this week, note it, and end the call.",
  },
  email: {
    objection: "Just send me an email",
    response: "Happy to. Confirm the best email address, mention that a colleague will send a short note, and ask if there is one question they'd like answered in it.",
  },
  price: {
    objection: "How much does it cost?",
    response: "Say pricing depends on their needs and the team will go through it properly on a short call; never quote a number that is not written in the facts above.",
  },
  how: {
    objection: "How did you get my number?",
    response: "Explain they shared it with {{business_name}} (for example through a form or an earlier conversation) and offer to stop calling if they prefer.",
  },
} as const;

/** Ready-made agents: pick one, fill in "About", choose a voice, test it, use it. */
export const AI_AGENT_TEMPLATES: AiAgentTemplate[] = [
  {
    key: "speed-to-lead",
    name: "Speed-to-lead qualifier",
    summary: "Calls a new inbound lead within minutes, qualifies them and books a meeting.",
    bestFor: "Leads who just filled in a form or requested a demo and agreed to be called.",
    goal: "book_meeting",
    greeting: "Hi {{first_name}}, thanks for getting in touch with {{business_name}} just now.",
    disclosure: DISCLOSURE,
    about: ABOUT_PLACEHOLDER,
    goalDetails:
      "They reached out recently, so open by referring to their request. Learn what prompted it, check the basic fit with the questions below, then offer a 20-minute call with a specialist and agree a specific day and time (suggest two options in the next three working days).",
    questions: ["What made you reach out today?", "What are you using for this right now?", "How soon are you hoping to have something in place?", "Who else would be involved in the decision?"],
    objections: [COMMON_OBJECTIONS.busy, COMMON_OBJECTIONS.price, COMMON_OBJECTIONS.email],
    voicemailMessage: "Hi {{first_name}}, it's {{agent_name}}, an AI assistant from {{business_name}}, following up on your request. We'll send you an email with next steps. Speak soon!",
    extraInstructions: "",
    maxCallMinutes: 6,
  },
  {
    key: "appointment-setter",
    name: "Appointment setter",
    summary: "Turns an interested lead into a booked meeting with your team.",
    bestFor: "Contacts who replied, downloaded something or asked for information, and consented to calls.",
    goal: "book_meeting",
    greeting: "Hi {{first_name}}, this is {{agent_name}} from {{business_name}}.",
    disclosure: "Just so you know, I'm an AI assistant and this call may be recorded.",
    about: ABOUT_PLACEHOLDER,
    goalDetails:
      "Your one job is a booked meeting. Briefly remind them why you're calling, confirm they're still interested, and agree a specific day and time for a 15–30 minute call. Repeat the agreed time back before ending.",
    questions: ["Is this still something you're looking into?", "What would you most want to cover on a call with our team?"],
    objections: [
      COMMON_OBJECTIONS.busy,
      COMMON_OBJECTIONS.email,
      {
        objection: "Can you just tell me now?",
        response: "Answer one simple question from the facts above, then explain a specialist can tailor it to them in a short call.",
      },
    ],
    voicemailMessage: "Hi {{first_name}}, it's {{agent_name}}, an AI assistant from {{business_name}}. I was calling to set up a quick call with our team — we'll follow up by email.",
    extraInstructions: "",
    maxCallMinutes: 5,
  },
  {
    key: "demo-no-show",
    name: "Missed-meeting recovery",
    summary: "Calls people who missed a booked demo or meeting and rebooks it.",
    bestFor: "No-shows from the last few days.",
    goal: "book_meeting",
    greeting: "Hi {{first_name}}, it's {{agent_name}} from {{business_name}} — we had a call booked recently and I think we missed each other.",
    disclosure: "I'm an AI assistant, and this call may be recorded.",
    about: ABOUT_PLACEHOLDER,
    goalDetails: "Be understanding — no guilt. Check whether they still want the meeting and, if so, rebook it for a specific day and time. If not, ask briefly what changed.",
    questions: ["Is this still a priority for you?", "What day and time usually works best for you?"],
    objections: [
      COMMON_OBJECTIONS.busy,
      {
        objection: "We went another way",
        response: "Thank them for letting you know, ask in one sentence what made the difference, and end politely.",
      },
    ],
    voicemailMessage: "Hi {{first_name}}, it's {{agent_name}}, an AI assistant from {{business_name}}. Sorry we missed each other — we'll email you a link to pick a new time.",
    extraInstructions: "",
    maxCallMinutes: 4,
  },
  {
    key: "reengagement",
    name: "Old lead re-engagement",
    summary: "Reconnects with leads that went quiet and finds out where they stand.",
    bestFor: "Contacts who showed interest months ago and are still opted in to calls.",
    goal: "reengage",
    greeting: "Hi {{first_name}}, it's {{agent_name}} from {{business_name}} — you looked into working with us a while back.",
    disclosure: "I'm an AI assistant, and this call may be recorded.",
    about: ABOUT_PLACEHOLDER,
    goalDetails:
      "Ask what happened since, whether the need is still there, and whether anything changed. If there is renewed interest, offer a short catch-up call with the team; otherwise ask whether it's OK to check in again in a few months.",
    questions: ["Did you end up solving this another way?", "Is it something you're thinking about this quarter?"],
    objections: [
      COMMON_OBJECTIONS.busy,
      COMMON_OBJECTIONS.how,
      {
        objection: "We're happy with what we have",
        response: "Great to hear. Ask if it's OK to check back in later in the year, then end politely.",
      },
    ],
    voicemailMessage: "",
    extraInstructions: "",
    maxCallMinutes: 4,
  },
  {
    key: "event-follow-up",
    name: "Event / webinar follow-up",
    summary: "Follows up with event or webinar sign-ups while the topic is fresh.",
    bestFor: "Registrants and attendees who agreed to be contacted.",
    goal: "qualify",
    greeting: "Hi {{first_name}}, it's {{agent_name}} from {{business_name}}, following up on the session you signed up for.",
    disclosure: "I'm an AI assistant, and this call may be recorded.",
    about: ABOUT_PLACEHOLDER,
    goalDetails: "Ask what they thought (or whether they caught the recording), what they'd like to apply, and offer a short call with a specialist if it fits.",
    questions: ["Did you get a chance to watch it?", "Which part was most relevant to you?", "Is this something you're working on right now?"],
    objections: [COMMON_OBJECTIONS.busy, COMMON_OBJECTIONS.email],
    voicemailMessage: "Hi {{first_name}}, it's {{agent_name}}, an AI assistant from {{business_name}}. Thanks for signing up for our session — we'll send the recording and resources by email.",
    extraInstructions: "",
    maxCallMinutes: 5,
  },
  {
    key: "renewal-check-in",
    name: "Customer check-in",
    summary: "Checks in with customers before a renewal and flags anyone at risk.",
    bestFor: "Existing customers (they are already your customers, so consent is usually on file).",
    goal: "confirm",
    greeting: "Hi {{first_name}}, it's {{agent_name}} from {{business_name}}, doing a quick check-in.",
    disclosure: "I'm an AI assistant, and this call may be recorded.",
    about: ABOUT_PLACEHOLDER,
    goalDetails:
      "Find out how things are going, whether anything is getting in the way, and whether they'd like time with their account manager. Note any problem precisely so the team can follow up.",
    questions: ["How has it been going so far?", "Is there anything you'd like to work better?", "Would a call with your account manager help?"],
    objections: [COMMON_OBJECTIONS.busy],
    voicemailMessage: "Hi {{first_name}}, it's {{agent_name}}, an AI assistant from {{business_name}}, with a quick check-in. Your account manager will follow up by email.",
    extraInstructions: "Be extra careful to be accurate: never promise discounts, credits or changes — say the account manager will follow up.",
    maxCallMinutes: 5,
  },
];

/** A template as an agent input, ready to edit (the voice and name are the person's to pick). */
export function agentFromTemplate(
  t: AiAgentTemplate,
  fill: {
    personaName?: string;
    businessName?: string;
    voiceId?: string;
    voiceName?: string;
  } = {},
): AiAgentInputT {
  return {
    name: t.name,
    templateKey: t.key,
    goal: t.goal,
    language: "en",
    voiceId: fill.voiceId ?? "",
    voiceName: fill.voiceName ?? "",
    personaName: fill.personaName ?? "Ava",
    businessName: fill.businessName ?? "",
    greeting: t.greeting,
    disclosure: t.disclosure,
    about: t.about,
    goalDetails: t.goalDetails,
    questions: [...t.questions],
    objections: t.objections.map((o) => ({ ...o })),
    voicemailMessage: t.voicemailMessage,
    extraInstructions: t.extraInstructions,
    transferNumber: "",
    maxCallMinutes: t.maxCallMinutes,
  };
}
