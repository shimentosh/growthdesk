import { z } from "zod";
import {
  CONTACT_STATUSES,
  DEAL_STATUSES,
  KIND_ACTIONS,
  PRIORITIES,
  QUALIFICATIONS,
  TRIGGER_EVENT_FIELDS,
  TRIGGER_KIND,
  WORKFLOW_ACTIONS,
  WORKFLOW_TRIGGERS,
  type WorkflowTrigger,
} from "@growthdesk/shared";
import { ACTION_CONFIG } from "../../automation/actions.js";
import { CrmExtrasService } from "../../crm/crm-extras.service.js";
import { defineTool } from "../tool.js";

/*
 * Everything a model needs to build any workflow from scratch with
 * create_workflow: every trigger (and the event fields its conditions can
 * read), every action with the JSON schema of its config, and the condition
 * paths, operators and allowed values — generated from the same definitions
 * the API validates against, so it never drifts.
 */

const ACTION_NOTES: Partial<Record<string, string>> = {
  assign_contact: 'strategy "user" needs userId (list members first); "round_robin" spreads across userIds or every member who can own records.',
  update_contact: 'field is status | qualification | priority | leadSource | custom.<key>; value must be one of the allowed values for enum fields.',
  create_task: 'assignTo is "owner" (the contact\'s or deal\'s owner) or a member\'s user id; dueInMinutes is from when the action runs.',
  notify: "Pick userIds, roles and/or contactOwner; email:true also emails it.",
  enroll_campaign: "campaignId of a launched outreach campaign — use one with Always on (settings.keepOpen) for leads that keep arriving.",
  stop_campaigns: "Without campaignId it stops every active or paused enrollment of the contact.",
  add_to_list: "listId of an active lead list; on a double opt-in list people without consent get a confirmation email.",
};

const ENUM_VALUES: Record<string, readonly string[]> = {
  "contact.status": CONTACT_STATUSES,
  "contact.qualification": QUALIFICATIONS,
  "contact.priority": PRIORITIES,
  "deal.status": DEAL_STATUSES,
};

export const WORKFLOW_REFERENCE_TOOLS = [
  defineTool({
    name: "get_workflow_reference",
    title: "Workflow building reference",
    description:
      "The complete vocabulary for building ANY workflow with create_workflow: every trigger (sales or email marketing) with the event fields its conditions can read, every action with the JSON schema of its config and usage notes, condition paths (contact.*, deal.*, event.*, this workspace's custom fields), operators and allowed values, and limits. Call it before designing a workflow that no template covers.",
    input: z.object({}),
    permission: "automation.read",
    risk: "read",
    idempotent: true,
    handler: async (ctx, _args, deps) => {
      const fields = await deps.get(CrmExtrasService).fields(ctx, "contact").catch(() => []);
      return {
        howItWorks:
          "When the trigger fires, every condition must hold (AND); then the actions run in order, each optionally after delayMinutes (0–43200, i.e. up to 30 days). New workflows are created OFF; enable_workflow turns one on after the user approves. requiresApproval:true holds every run for a person to approve.",
        triggers: (WORKFLOW_TRIGGERS as readonly WorkflowTrigger[]).map((t) => ({
          trigger: t,
          kind: TRIGGER_KIND[t],
          eventFields: (TRIGGER_EVENT_FIELDS[t] ?? []).map((f) => ({ path: `event.${f.key}`, label: f.label })),
        })),
        actions: WORKFLOW_ACTIONS.map((a) => ({
          type: a,
          suggestedFor: (Object.keys(KIND_ACTIONS) as (keyof typeof KIND_ACTIONS)[]).filter((k) => KIND_ACTIONS[k].includes(a)),
          config: a in ACTION_CONFIG ? z.toJSONSchema(ACTION_CONFIG[a as keyof typeof ACTION_CONFIG], { io: "input", unrepresentable: "any" }) : null,
          note: ACTION_NOTES[a],
        })),
        conditions: {
          operators: { is: "equals", is_not: "not equal", contains: "text contains (case-insensitive) / list contains", gt: "number greater than", lt: "number less than", exists: "has a value (value ignored)" },
          paths: [
            ...Object.entries(ENUM_VALUES).map(([path, values]) => ({ path, values })),
            { path: "contact.leadSource", values: "free text" },
            { path: "contact.tags", values: "tag names (use contains)" },
            { path: "contact.country", values: "country name or code as stored" },
            { path: "deal.value", values: "number (use gt / lt)" },
            { path: "deal.stage", values: "the stage name, e.g. Proposal (use contains for partial names)" },
            ...fields.map((f) => ({ path: `contact.custom.${f.key}`, values: `custom field "${f.label}" (${f.type})` })),
            { path: "event.<key>", values: "a field of the trigger's event — see each trigger's eventFields" },
          ],
          note: "A missing subject (e.g. no deal on a contact trigger) makes is false, is_not true and exists false.",
        },
        limits: { conditions: 20, actions: 20, maxDelayMinutes: 60 * 24 * 30, nameMax: 120 },
      };
    },
  }),
];
