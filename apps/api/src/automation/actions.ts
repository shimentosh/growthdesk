import { z } from "zod";
import { CONTACT_STATUSES, PRIORITIES, QUALIFICATIONS, TASK_TYPES, WORKSPACE_ROLES, type WorkflowActionInput } from "@growthdesk/shared";

/*
 * The config each workflow action accepts. WorkflowInput (shared) keeps
 * `config` as an open record so the web form can evolve; the API validates
 * each action's config against these before a workflow is saved, and the
 * executor re-parses them before it acts, so a stored workflow can never
 * smuggle in a field the executor would trust.
 */

const userId = z.string().uuid();

export const ACTION_CONFIG = {
  assign_contact: z
    .object({
      strategy: z.enum(["user", "round_robin"]).default("user"),
      userId: userId.optional(),
      /** Round-robin pool; defaults to every member who can own records (not viewers). */
      userIds: z.array(userId).max(50).optional(),
      /** Re-assign a contact that already has an owner. */
      overwrite: z.boolean().default(false),
    })
    .refine((c) => c.strategy === "round_robin" || Boolean(c.userId), { message: "Choose a person, or the round-robin strategy" }),
  update_contact: z
    .object({
      field: z.union([z.enum(["status", "qualification", "priority", "leadSource"]), z.string().regex(/^custom\.[a-z][a-z0-9_]{0,39}$/)]),
      value: z.string().trim().max(500),
    })
    .superRefine((c, ctx) => {
      const allowed: Record<string, readonly string[]> = { status: CONTACT_STATUSES, qualification: QUALIFICATIONS, priority: PRIORITIES };
      const list = allowed[c.field];
      if (list && !list.includes(c.value)) ctx.addIssue({ code: "custom", message: `${c.field} must be one of: ${list.join(", ")}`, path: ["value"] });
    }),
  create_task: z.object({
    title: z.string().trim().min(1, "A task needs a title").max(300),
    description: z.string().trim().max(5000).optional(),
    type: z.enum(TASK_TYPES).default("follow_up"),
    priority: z.enum(PRIORITIES).default("medium"),
    dueInMinutes: z.number().int().min(0).max(60 * 24 * 365).optional(),
    /** "owner" = the contact's (or deal's) owner; otherwise a member's user id. */
    assignTo: z.union([z.literal("owner"), userId]).default("owner"),
  }),
  notify: z
    .object({
      userIds: z.array(userId).max(50).optional(),
      roles: z.array(z.enum(WORKSPACE_ROLES)).max(5).optional(),
      /** Also notify the contact's owner. */
      contactOwner: z.boolean().default(false),
      title: z.string().trim().max(200).optional(),
      message: z.string().trim().max(2000).optional(),
      email: z.boolean().default(false),
    })
    .refine((c) => Boolean(c.userIds?.length || c.roles?.length || c.contactOwner), { message: "Choose who to notify" }),
  enroll_campaign: z.object({ campaignId: z.string().uuid() }),
  stop_campaigns: z.object({ campaignId: z.string().uuid().optional() }),
  add_tag: z
    .object({ tag: z.string().trim().min(1).max(50).optional(), tags: z.array(z.string().trim().min(1).max(50)).max(20).optional() })
    .refine((c) => Boolean(c.tag || c.tags?.length), { message: "Name at least one tag" }),
} as const;

export type ActionType = keyof typeof ACTION_CONFIG;
export type WorkflowAction = z.infer<typeof WorkflowActionInput>;

export type ParsedAction =
  | { type: "assign_contact"; delayMinutes: number; config: z.infer<(typeof ACTION_CONFIG)["assign_contact"]> }
  | { type: "update_contact"; delayMinutes: number; config: z.infer<(typeof ACTION_CONFIG)["update_contact"]> }
  | { type: "create_task"; delayMinutes: number; config: z.infer<(typeof ACTION_CONFIG)["create_task"]> }
  | { type: "notify"; delayMinutes: number; config: z.infer<(typeof ACTION_CONFIG)["notify"]> }
  | { type: "enroll_campaign"; delayMinutes: number; config: z.infer<(typeof ACTION_CONFIG)["enroll_campaign"]> }
  | { type: "stop_campaigns"; delayMinutes: number; config: z.infer<(typeof ACTION_CONFIG)["stop_campaigns"]> }
  | { type: "add_tag"; delayMinutes: number; config: z.infer<(typeof ACTION_CONFIG)["add_tag"]> };

/** Parses one stored or submitted action. Returns the problem as text instead of throwing. */
export function parseAction(raw: unknown): { action: ParsedAction } | { error: string } {
  const a = (raw ?? {}) as { type?: string; delayMinutes?: unknown; config?: unknown };
  const schema = ACTION_CONFIG[a.type as ActionType];
  if (!schema) return { error: `Unknown action "${String(a.type)}"` };
  const parsed = schema.safeParse(a.config ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { error: `${a.type}: ${issue?.path.length ? `${issue.path.join(".")}: ` : ""}${issue?.message ?? "invalid config"}` };
  }
  const delay = typeof a.delayMinutes === "number" && Number.isFinite(a.delayMinutes) ? Math.max(0, Math.floor(a.delayMinutes)) : 0;
  return { action: { type: a.type, delayMinutes: delay, config: parsed.data } as ParsedAction };
}
