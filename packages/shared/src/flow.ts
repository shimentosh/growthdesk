/*
 * How an enrollment walks a sequence.
 *
 * Ported from LinkDesk (packages/domain/src/services/outreach.service.ts:
 * nextPosition, branchPosition, waitBefore, threadOf, evaluate) with their
 * tests (packages/domain/tests/flow.test.ts → test/flow.test.ts). The
 * arithmetic is unchanged; the step kinds and the facts a rule may read are
 * Growthdesk's own, and a send window now honours its time zone (schedule.ts).
 *
 * Steps are one flat list. A branch owns the steps after it as two contiguous
 * lanes — `thenLength` of them, then `elseLength` — and the trunk resumes past
 * both, so an enrollment's place in a sequence is a single integer.
 */

export const MINUTES_PER_DAY = 1440;

export const RULE_FIELDS = [
  "replied",
  "opened",
  "clicked",
  "has_phone",
  "has_email",
  "status",
  "qualification",
  "priority",
  "job_title",
  "company",
  "country",
  "tag",
  "call_outcome",
] as const;
export type RuleField = (typeof RULE_FIELDS)[number] | `custom.${string}`;

export const RULE_OPS = ["is", "is_not", "contains", "gt", "lt"] as const;
export type RuleOp = (typeof RULE_OPS)[number];

export type Rule = { field: RuleField; op: RuleOp; value: string };
export type Logic = { match: "all" | "any"; rules: Rule[] };

export type StepConfig = {
  /** Minutes to wait before this step runs (a wait step's whole meaning). */
  delayMinutes?: number;
  logic?: Logic;
  thenLength?: number;
  elseLength?: number;
  [key: string]: unknown;
};

export type FlowStep = { kind: string; delayMinutes: number; config: StepConfig };

const laneLengths = (step: FlowStep | undefined) => ({
  then: Math.max(0, Number(step?.config?.thenLength ?? 0)),
  otherwise: Math.max(0, Number(step?.config?.elseLength ?? 0)),
});

const at = (steps: FlowStep[], pos: number) => (pos >= 0 && pos < steps.length ? pos : null);

/** Where an enrollment goes after finishing the step at `pos`, or null when the run is over. */
export function nextPosition(steps: FlowStep[], pos: number): number | null {
  for (let b = 0; b < steps.length; b++) {
    if (steps[b]?.kind !== "branch") continue;
    const { then: k, otherwise: m } = laneLengths(steps[b]);
    // The end of the matched lane rejoins the trunk, past the other lane.
    if (k > 0 && pos === b + k) return at(steps, b + k + m + 1);
  }
  return at(steps, pos + 1);
}

/** Where a branch at `pos` sends an enrollment, given the verdict on its rules. */
export function branchPosition(steps: FlowStep[], pos: number, matched: boolean): number | null {
  const { then: k, otherwise: m } = laneLengths(steps[pos]);
  if (matched) return at(steps, k > 0 ? pos + 1 : pos + 1 + m);
  return at(steps, pos + 1 + k);
}

/**
 * Minutes to wait on the way from one step to another. Two messages with
 * nothing between them never land the same day; an explicit wait step is
 * honoured exactly, including waits shorter than a day.
 */
export function waitBefore(steps: FlowStep[], from: number, to: number): number {
  const target = steps[to];
  if (!target) return 0;
  // An AI call counts as a message here: two in a row never ring the same person twice in one day.
  const isMessage = (k: string | undefined) => k === "email" || k === "whatsapp" || k === "telegram" || k === "ai_call";
  const backToBack = isMessage(target.kind) && isMessage(steps[from]?.kind) && target.kind === steps[from]?.kind;
  return Math.max(backToBack ? MINUTES_PER_DAY : 0, target.delayMinutes);
}

/**
 * The subject a follow-up email sends with: its own subject starts a new
 * thread; an empty subject replies to the opener ("Re: …" + In-Reply-To).
 */
export function threadOf(
  subject: string,
  opener: { subject: string; messageId: string | null } | null,
): { subject: string; inReplyTo?: string } {
  const own = subject.trim();
  if (own) return { subject: own };
  if (!opener?.subject.trim()) return { subject: "Following up" };
  const stem = opener.subject.replace(/^\s*(re\s*:\s*)+/i, "").trim();
  return { subject: `Re: ${stem}`, ...(opener.messageId ? { inReplyTo: opener.messageId } : {}) };
}

const num = (v: string): number | null => {
  const n = Number(v.replace(/[^0-9.-]/g, ""));
  return v.trim() && Number.isFinite(n) ? n : null;
};

/** Whether one enrollment answers a branch's question. An empty question is a yes. */
export function evaluate(logic: Logic | undefined, facts: Record<string, string>): boolean {
  const rules = logic?.rules ?? [];
  if (!rules.length) return true;
  const one = (r: Rule) => {
    const got = (facts[r.field] ?? "").trim();
    const want = (r.value ?? "").trim();
    switch (r.op) {
      case "is":
        // Multi-valued facts (tags) are newline-separated.
        return got.toLowerCase().split("\n").includes(want.toLowerCase());
      case "is_not":
        return !got.toLowerCase().split("\n").includes(want.toLowerCase());
      case "contains":
        return got.toLowerCase().includes(want.toLowerCase());
      case "gt":
        return num(got) !== null && num(want) !== null && num(got)! > num(want)!;
      case "lt":
        return num(got) !== null && num(want) !== null && num(got)! < num(want)!;
      default:
        return false;
    }
  };
  return logic?.match === "any" ? rules.some(one) : rules.every(one);
}

/** Structural problems that would make a sequence unwalkable (adapted from LinkDesk's assertWalkable). */
export function flowTrouble(steps: FlowStep[]): string | null {
  if (!steps.length) return "A sequence needs at least one step.";
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!;
    if (s.kind !== "branch") continue;
    const { then: k, otherwise: m } = laneLengths(s);
    if (i + k + m > steps.length - 1) return `Step ${i + 1}: the branch's lanes run past the end of the sequence.`;
    for (let j = i + 1; j <= i + k + m && j < steps.length; j++) {
      if (steps[j]?.kind === "branch") return `Step ${i + 1}: branches inside a branch's lanes are not supported.`;
    }
  }
  return null;
}

export const toFlow = (steps: { type: string; config: unknown }[]): FlowStep[] =>
  steps.map((s) => {
    const config = (s.config && typeof s.config === "object" ? s.config : {}) as StepConfig;
    return { kind: s.type, delayMinutes: Math.max(0, Number(config.delayMinutes ?? 0)), config };
  });
