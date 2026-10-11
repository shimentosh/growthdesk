/*
 * Sequences and their steps. Kept in step with
 *   apps/api/src/campaigns/sequences.service.ts   (`sequenceDto`, `stepDto`, `SequencePatch`, `SequenceListQuery`)
 *   apps/api/src/campaigns/campaign-config.ts     (`StepConfigT`, `ACTION_STEPS`, `MESSAGE_STEPS`, `updateFieldTrouble`)
 *   apps/api/src/campaigns/step-rules.service.ts  (what makes a step valid, and the error keys it reports)
 *   packages/shared/src/schemas.ts                (`StepInput`, `RuleSchema`)
 *   packages/shared/src/flow.ts                   (how a branch's lanes and the trunk are walked)
 *
 * The step types here are also what campaign steps use, so the StepsEditor
 * (src/components/sequences/StepsEditor.tsx) works for both.
 */
import type { FeatureKey, RuleOp, StepType, TaskType } from "@growthdesk/shared";

export type StepRule = { field: string; op: RuleOp; value: string };
export type StepLogic = { match: "all" | "any"; rules: StepRule[] };
export type AssignStrategy = "user" | "round_robin" | "campaign_owner";

/** A step's free-form config (`StepConfigT`). Only the keys a step's type reads matter; the rest are kept as they are. */
export type StepConfig = {
  /** Minutes to wait before this step runs (on a wait step, its whole meaning). Counts from enrollment for the first step. */
  delayMinutes?: number;
  subject?: string;
  body?: string;
  templateId?: string | null;
  logic?: StepLogic;
  /** Branch: how many steps after it form the "yes" lane… */
  thenLength?: number;
  /** …and how many after those form the "no" lane. The trunk resumes past both. */
  elseLength?: number;
  taskTitle?: string;
  taskType?: TaskType;
  taskDueMinutes?: number;
  /** Task notes (the engine reads `description`, falling back to `body`). */
  description?: string;
  field?: string;
  value?: string;
  userId?: string | null;
  strategy?: AssignStrategy;
  message?: string;
  integrationId?: string | null;
  [key: string]: unknown;
};

/** One step as the editor edits it and the API accepts it (shared `StepInput`). */
export type SequenceStep = { type: StepType; config: StepConfig };

/** A stored step — `stepDto()`. */
export type StepRow = SequenceStep & { id: string; position: number };

/** GET /sequences rows, and the base of GET /sequences/:id — `sequenceDto()`. */
export type Sequence = {
  id: string;
  name: string;
  description: string;
  kind: "library" | "campaign" | string;
  archivedAt: string | null;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
  stepCount: number;
};

/** GET /sequences/:id, POST, PATCH, POST /:id/duplicate. */
export type SequenceDetail = Sequence & { steps: StepRow[] };

/** POST /sequences (shared `SequenceInput`, name required) and PATCH (`SequencePatch`; steps, when given, replace the whole list). */
export type SequenceBody = { name?: string; description?: string; steps?: SequenceStep[] };

/** Props of the controlled steps editor. */
export type StepsEditorProps = {
  steps: SequenceStep[];
  onChange: (steps: SequenceStep[]) => void;
  readOnly?: boolean;
  /**
   * Field errors from the API's 400 answer (`ApiError.fields`), keyed as the
   * API names them: `steps.3.config.body`, `steps.3.type`, or `steps` for the
   * whole list (structure, unknown variables).
   */
  errors?: Record<string, string>;
  /** The key prefix of `errors` (default "steps"). */
  errorPrefix?: string;
};

/** Steps that send a message through a channel (`MESSAGE_STEPS`). */
export const MESSAGE_STEP_TYPES: readonly StepType[] = ["email", "whatsapp", "telegram"];

/** What each step type does, and the plan feature it needs (step-rules.service.ts: multichannel / branching). */
export const STEP_META: Record<StepType, { description: string; feature?: FeatureKey }> = {
  email: { description: "Send an email from one of the campaign's mailboxes." },
  wait: { description: "Pause before the next step." },
  branch: { description: "Split the path on what the contact did or who they are.", feature: "branching" },
  call_task: { description: "Create a call task for a teammate.", feature: "multichannel" },
  whatsapp: { description: "Send a WhatsApp message.", feature: "multichannel" },
  telegram: { description: "Send a Telegram message.", feature: "multichannel" },
  update_field: { description: "Set a field on the contact." },
  assign_owner: { description: "Give the contact an owner." },
  create_task: { description: "Create a task for a teammate." },
  notify: { description: "Send a teammate an in-app notification." },
  end: { description: "Finish the sequence for the contact here." },
};

/** Stored steps → the editable shape (drops id/position, keeps config as stored). */
export const stepsOf = (rows: StepRow[] | undefined): SequenceStep[] =>
  [...(rows ?? [])]
    .sort((a, b) => a.position - b.position)
    .map((s) => ({ type: s.type, config: s.config && typeof s.config === "object" && !Array.isArray(s.config) ? { ...s.config } : {} }));

const UUID_KEYS = ["templateId", "userId", "integrationId"] as const;

/** Steps ready to send: empty id fields become null (the API wants a UUID or null) and blank keys are dropped. */
export function cleanSteps(steps: SequenceStep[]): SequenceStep[] {
  return steps.map((s) => {
    const config: StepConfig = {};
    for (const [k, v] of Object.entries(s.config ?? {})) {
      if (v === undefined) continue;
      if ((UUID_KEYS as readonly string[]).includes(k) && (v === "" || v === null)) continue;
      config[k] = v;
    }
    return { type: s.type, config };
  });
}
