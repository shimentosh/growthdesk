import { z } from "zod";
import { CALL_OUTCOMES } from "./enums.js";
import { requiredText, text } from "./schemas.js";

/*
 * Lead scoring: a 0–100 score per contact, the sum of two parts.
 *
 *   fit         who they are — rules on the contact's own fields (job title
 *               contains "founder", has a phone, lead source is referral…)
 *   engagement  what they did — rules on events counted from the database
 *               (emails opened, replies, meetings, call outcomes, quotes…),
 *               each repeat adding points up to the rule's cap, and only
 *               events in the last `decayDays` counting, so it fades.
 *
 * Points may be negative (unsubscribed, bounced, "do not call"). The total
 * is clamped to 0–100 and is what Contact.score holds while scoring is on;
 * off, Contact.score is left to people and the lead API. The settings live
 * in Workspace.settings.leadScoring; the rules are ScoringRule rows.
 */

export const SCORING_CATEGORIES = ["fit", "engagement"] as const;
export type ScoringCategory = (typeof SCORING_CATEGORIES)[number];

export const SCORING_OPS = ["is", "is_not", "contains", "exists", "gt", "lt"] as const;
export type ScoringOp = (typeof SCORING_OPS)[number];

export const SCORING_OP_LABELS: Record<ScoringOp, string> = {
  is: "is",
  is_not: "is not",
  contains: "contains",
  exists: "is filled in",
  gt: "is more than",
  lt: "is less than",
};

/** Contact fields a fit rule can test. Custom fields are `custom.<key>`. */
export const SCORING_FIT_FIELDS = [
  { key: "jobTitle", label: "Job title" },
  { key: "company", label: "Company" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "leadSource", label: "Lead source" },
  { key: "country", label: "Country" },
  { key: "city", label: "City" },
  { key: "website", label: "Website" },
  { key: "linkedinUrl", label: "LinkedIn URL" },
  { key: "lifecycleStage", label: "Lifecycle stage" },
  { key: "status", label: "Status" },
  { key: "qualification", label: "Qualification" },
  { key: "priority", label: "Priority" },
  { key: "tags", label: "Tags" },
] as const;
export type ScoringFitField = (typeof SCORING_FIT_FIELDS)[number]["key"];

const FIT_FIELD_KEYS = new Set<string>(SCORING_FIT_FIELDS.map((f) => f.key));
export const isScoringFitField = (field: string) => FIT_FIELD_KEYS.has(field) || /^custom\.[A-Za-z0-9_-]{1,60}$/.test(field);

/**
 * Events an engagement rule can count. `flag` events are states (counted
 * once while true); the rest count rows in the decay window. Call outcomes
 * are `call.outcome:<outcome>`.
 */
export const SCORING_EVENTS = [
  { key: "email.opened", label: "Opened a sales email", flag: false },
  { key: "email.clicked", label: "Clicked a link in a sales email", flag: false },
  { key: "email.replied", label: "Replied (email, chat or SMS)", flag: false },
  { key: "meeting.booked", label: "Booked a meeting", flag: false },
  { key: "quote.viewed", label: "Viewed a quote", flag: false },
  { key: "quote.accepted", label: "Accepted a quote", flag: false },
  { key: "marketing.opened", label: "Opened a marketing email", flag: false },
  { key: "marketing.clicked", label: "Clicked a marketing email", flag: false },
  { key: "lead.returning", label: "Came back as a lead again (form, API)", flag: false },
  { key: "contact.unsubscribed", label: "Unsubscribed", flag: true },
  { key: "contact.bounced", label: "Email bounced", flag: true },
  ...CALL_OUTCOMES.map((o) => ({ key: `call.outcome:${o}`, label: `Call outcome: ${o.replace(/_/g, " ")}`, flag: false })),
] as const satisfies readonly { key: string; label: string; flag: boolean }[];

const EVENT_KEYS = new Set<string>(SCORING_EVENTS.map((e) => e.key));
export const isScoringEvent = (event: string) => EVENT_KEYS.has(event);
export const scoringEventLabel = (event: string) => SCORING_EVENTS.find((e) => e.key === event)?.label ?? event;

// ─── Settings ─────────────────────────────────────────────────────────────────

export const LeadScoringSettings = z
  .object({
    enabled: z.boolean(),
    /** At or above: a hot lead (the owner is told the first time). */
    hot: z.number().int().min(1).max(100).default(70),
    /** At or above (and below hot): warm. Below: cold. */
    warm: z.number().int().min(0).max(99).default(40),
  })
  .refine((s) => s.warm < s.hot, { message: "Warm must be lower than hot", path: ["warm"] });
export type LeadScoringSettingsT = z.infer<typeof LeadScoringSettings>;

export const DEFAULT_LEAD_SCORING: LeadScoringSettingsT = { enabled: false, hot: 70, warm: 40 };

export type ScoreBand = "hot" | "warm" | "cold";

export function scoreBand(score: number | null | undefined, t: Pick<LeadScoringSettingsT, "hot" | "warm">): ScoreBand | null {
  if (score === null || score === undefined) return null;
  return score >= t.hot ? "hot" : score >= t.warm ? "warm" : "cold";
}

// ─── Rules ────────────────────────────────────────────────────────────────────

/** The fields of a rule; `ScoringRuleInput` adds the checks that depend on the category. */
export const ScoringRuleFields = z.object({
  name: requiredText(120),
  category: z.enum(SCORING_CATEGORIES),
  field: text(80).default(""),
  op: z.enum([...SCORING_OPS, ""]).default(""),
  value: text(500).default(""),
  event: text(80).default(""),
  points: z.number().int().min(-100).max(100),
  maxPoints: z.number().int().min(1).max(100).nullable().default(null),
  decayDays: z.number().int().min(1).max(3650).nullable().default(null),
  active: z.boolean().default(true),
});
export type ScoringRuleFieldsT = z.infer<typeof ScoringRuleFields>;

/** Why a rule cannot be saved, as [field, message], or null. */
export function scoringRuleProblem(r: Pick<ScoringRuleFieldsT, "category" | "field" | "op" | "value" | "event" | "points">): [string, string] | null {
  if (r.points === 0) return ["points", "Give it some points (or negative points)"];
  if (r.category === "fit") {
    if (!isScoringFitField(r.field)) return ["field", "Choose a contact field"];
    if (!r.op) return ["op", "Choose how to compare"];
    if (r.op !== "exists" && !r.value.trim()) return ["value", "Enter a value to compare with"];
    if ((r.op === "gt" || r.op === "lt") && !Number.isFinite(Number(r.value))) return ["value", "Enter a number"];
    return null;
  }
  if (!isScoringEvent(r.event)) return ["event", "Choose an event"];
  return null;
}

export const ScoringRuleInput = ScoringRuleFields.superRefine((r, ctx) => {
  const problem = scoringRuleProblem(r);
  if (problem) ctx.addIssue({ code: "custom", message: problem[1], path: [problem[0]] });
});
export type ScoringRuleInputT = z.infer<typeof ScoringRuleInput>;

export const ScoringReorderInput = z.object({ ids: z.array(z.string().uuid()).min(1).max(200) });

export const ScoringRecommendedInput = z.object({
  /** Replace every rule with the recommended set; otherwise only add the ones missing (by name). */
  replace: z.boolean().default(false),
});

/** A rule as stored and returned. */
export type ScoringRuleT = ScoringRuleFieldsT & { id: string; position: number };

const fit = (name: string, field: string, op: ScoringOp, value: string, points: number): ScoringRuleInputT => ({ name, category: "fit", field, op, value, event: "", points, maxPoints: null, decayDays: null, active: true });
const engaged = (name: string, event: string, points: number, maxPoints: number | null = null, decayDays: number | null = null): ScoringRuleInputT => ({
  name,
  category: "engagement",
  field: "",
  op: "",
  value: "",
  event,
  points,
  maxPoints,
  decayDays,
  active: true,
});

/** "Use recommended rules": a sensible start for B2B outreach. */
export const RECOMMENDED_SCORING_RULES: ScoringRuleInputT[] = [
  fit("Decision-maker title", "jobTitle", "contains", "founder, ceo, owner, director, vp, head", 15),
  fit("Has a phone number", "phone", "exists", "", 5),
  fit("Has a company", "company", "exists", "", 5),
  fit("Referred to us", "leadSource", "is", "referral", 10),
  engaged("Opened a sales email", "email.opened", 3, 9, 30),
  engaged("Clicked a sales email link", "email.clicked", 5, 15, 30),
  engaged("Replied", "email.replied", 20, null, 60),
  engaged("Booked a meeting", "meeting.booked", 25, null, 90),
  engaged("Call: connected", "call.outcome:connected", 10),
  engaged("Call: asked for a callback", "call.outcome:callback_requested", 10),
  engaged("Call: meeting booked", "call.outcome:meeting_booked", 25),
  engaged("Viewed a quote", "quote.viewed", 10),
  engaged("Accepted a quote", "quote.accepted", 30),
  engaged("Clicked a marketing email", "marketing.clicked", 5, 15),
  engaged("Came back as a lead", "lead.returning", 10, null, 30),
  engaged("Unsubscribed", "contact.unsubscribed", -30),
  engaged("Email bounced", "contact.bounced", -20),
  engaged("Call: not interested", "call.outcome:not_interested", -15),
  engaged("Call: do not call", "call.outcome:do_not_call", -50),
];

// ─── The math ─────────────────────────────────────────────────────────────────

/** What fit rules read about a contact. */
export type ScoringFacts = {
  jobTitle: string;
  company: string;
  email: string;
  phone: string;
  leadSource: string;
  country: string;
  city: string;
  website: string;
  linkedinUrl: string;
  lifecycleStage: string;
  status: string;
  qualification: string;
  priority: string;
  tags: string[];
  custom: Record<string, unknown>;
};

/** The rule fields the math reads. */
export type ScoringRuleLike = Pick<ScoringRuleT, "id" | "name" | "category" | "field" | "op" | "value" | "event" | "points" | "maxPoints" | "decayDays" | "active">;

export type ScoreBreakdownItem = { ruleId: string; name: string; points: number };
export type ScoreResult = { fit: number; engagement: number; total: number; breakdown: ScoreBreakdownItem[] };

const norm = (s: string) => s.trim().toLowerCase();
/** "founder, CEO" → ["founder", "ceo"]: a rule's value is any of these. */
const terms = (value: string) => value.split(",").map(norm).filter(Boolean);

function factValue(f: ScoringFacts, field: string): string | string[] {
  if (field.startsWith("custom.")) {
    const v = f.custom[field.slice(7)];
    if (v === null || v === undefined) return "";
    if (Array.isArray(v)) return v.map(String);
    return String(v);
  }
  const v = (f as unknown as Record<string, unknown>)[field];
  if (Array.isArray(v)) return v.map(String);
  return v === null || v === undefined ? "" : String(v);
}

/** Does a fit rule hold for these facts? Text compares ignore case; a list field holds if any item does. */
export function fitMatches(rule: Pick<ScoringRuleLike, "field" | "op" | "value">, f: ScoringFacts): boolean {
  const raw = factValue(f, rule.field);
  const values = (Array.isArray(raw) ? raw : [raw]).map(norm).filter(Boolean);
  const want = terms(rule.value);
  switch (rule.op) {
    case "exists":
      return values.length > 0;
    case "is":
      return values.some((v) => want.includes(v));
    case "is_not":
      return !values.some((v) => want.includes(v));
    case "contains":
      return values.some((v) => want.some((w) => v.includes(w)));
    case "gt":
    case "lt": {
      const limit = Number(rule.value);
      if (!Number.isFinite(limit)) return false;
      return values.some((v) => {
        const n = Number(v);
        return v !== "" && Number.isFinite(n) && (rule.op === "gt" ? n > limit : n < limit);
      });
    }
    default:
      return false;
  }
}

/** Points from `count` events: each earns `points`, capped at ±maxPoints when set. */
export function engagementPoints(rule: Pick<ScoringRuleLike, "points" | "maxPoints">, count: number): number {
  if (!count || count < 0) return 0;
  const raw = rule.points * count;
  if (rule.maxPoints === null || rule.maxPoints === undefined) return raw;
  const cap = Math.abs(rule.maxPoints);
  return Math.max(-cap, Math.min(cap, raw));
}

/** The key engagement counts are looked up by: the same event over the same window is counted once. */
export const signalKey = (rule: Pick<ScoringRuleLike, "event" | "decayDays">) => `${rule.event}|${rule.decayDays ?? ""}`;

export const clampScore = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

/**
 * A contact's score from the active rules, its facts, and the engagement
 * counts by signalKey(). The breakdown lists every rule that gave points
 * (positive or negative), in rule order.
 */
export function computeScore(rules: readonly ScoringRuleLike[], facts: ScoringFacts, counts: Record<string, number>): ScoreResult {
  let fitTotal = 0;
  let engagement = 0;
  const breakdown: ScoreBreakdownItem[] = [];
  for (const r of rules) {
    if (!r.active) continue;
    let points = 0;
    if (r.category === "fit") points = fitMatches(r, facts) ? r.points : 0;
    else points = engagementPoints(r, counts[signalKey(r)] ?? 0);
    if (!points) continue;
    if (r.category === "fit") fitTotal += points;
    else engagement += points;
    breakdown.push({ ruleId: r.id, name: r.name, points });
  }
  return { fit: fitTotal, engagement, total: clampScore(fitTotal + engagement), breakdown };
}
