import { z } from "zod";
import { SequenceInput } from "@growthdesk/shared";
import { SequenceListQuery, SequencePatch, SequencesService } from "../../../campaigns/sequences.service.js";
import { TemplatesService } from "../../../campaigns/templates.service.js";
import { defineTool, pageInput, paged } from "../../tool.js";
import { STEP_REFERENCE, describeSteps, id, stepOut, stepsInput, validate } from "./shared.js";

/*
 * The sequence library: reusable step lists a campaign copies when it is
 * created from one (create_campaign fromSequenceId). Editing a library
 * sequence never changes a campaign already made from it.
 */

const seqOut = (s: { id: string; name: string; description: string; stepCount: number; updatedAt: Date; steps?: { position: number; type: string; config: unknown }[] }) => ({
  id: s.id,
  name: s.name,
  description: s.description,
  stepCount: s.stepCount,
  ...(s.steps ? { outline: describeSteps(s.steps), steps: s.steps.map(stepOut) } : {}),
  updatedAt: s.updatedAt,
});

export const OUTREACH_SEQUENCE_TOOLS = [
  defineTool({
    name: "get_step_reference",
    title: "Sequence step reference",
    description: "How sequence steps work: every step kind and its config, timing rules, and the personalization variables this workspace has (standard and contact custom fields). Read it before writing steps.",
    input: z.object({}),
    permission: ["campaigns.read", "templates.read"],
    risk: "read",
    handler: async (ctx, _args, deps) => {
      const vars = await deps.get(TemplatesService).variables(ctx);
      return {
        steps: STEP_REFERENCE,
        variables: { standard: vars.standard.map((v) => v.token), custom: vars.custom.map((v) => ({ token: v.token, label: v.label })), fallbackSyntax: vars.fallbackSyntax },
        tips: [
          "Cold sequences: 2–4 short plain-text emails, 2–4 days apart; follow-ups with an empty subject reply in the same thread.",
          "Every token needs a fallback: {{first_name|there}}, {{company|your team}}.",
          "Unknown variables are refused when saving; missing values fail that contact at that step.",
        ],
      };
    },
  }),

  defineTool({
    name: "list_sequences",
    title: "List saved sequences",
    description: "The library of reusable sequences (step lists). A campaign is created from one with create_campaign { fromSequenceId } and gets its own copy.",
    input: z.object({ search: z.string().trim().max(200).optional().describe("Matches the name."), ...pageInput }),
    permission: "campaigns.read",
    risk: "read",
    handler: async (ctx, args, deps) => {
      const r = await deps.get(SequencesService).list(ctx, validate(SequenceListQuery, { page: args.page, pageSize: args.limit, q: args.search }));
      return paged(r.items.map(seqOut), r.total, args.page, args.limit);
    },
  }),

  defineTool({
    name: "get_sequence",
    title: "Get a sequence with its steps",
    description: "One library sequence with every step (position, kind, config) and a one-line outline.",
    input: z.object({ sequenceId: id("sequence") }),
    permission: "campaigns.read",
    risk: "read",
    handler: async (ctx, args, deps) => seqOut(await deps.get(SequencesService).get(ctx, args.sequenceId)),
  }),

  defineTool({
    name: "create_sequence",
    title: "Create a sequence",
    description:
      "Saves a reusable sequence to the library (nothing is sent). Steps are validated as on the sequence page: the first email needs a subject, every message needs a body or template, variables must exist, plan features (multichannel, branching) must be included.",
    input: z.object({
      name: z.string().trim().min(1).max(120),
      description: z.string().trim().max(1000).optional(),
      steps: stepsInput,
    }),
    permission: "campaigns.write",
    risk: "write",
    idempotent: false,
    handler: async (ctx, args, deps) => seqOut(await deps.get(SequencesService).create(ctx, validate(SequenceInput, args))),
  }),

  defineTool({
    name: "update_sequence",
    title: "Update a sequence",
    description: "Renames a library sequence or replaces its steps (steps, when given, replace the whole list). Campaigns already made from it keep their own copy.",
    input: z.object({
      sequenceId: id("sequence"),
      name: z.string().trim().min(1).max(120).optional(),
      description: z.string().trim().max(1000).optional(),
      steps: stepsInput.optional(),
    }),
    permission: "campaigns.write",
    risk: "write",
    handler: async (ctx, args, deps) => {
      const { sequenceId, ...patch } = args;
      return seqOut(await deps.get(SequencesService).update(ctx, sequenceId, validate(SequencePatch, patch)));
    },
  }),

  defineTool({
    name: "duplicate_sequence",
    title: "Duplicate a sequence",
    description: 'Copies a library sequence as "<name> (copy)".',
    input: z.object({ sequenceId: id("sequence") }),
    permission: "campaigns.write",
    risk: "write",
    idempotent: false,
    handler: async (ctx, args, deps) => seqOut(await deps.get(SequencesService).duplicate(ctx, args.sequenceId)),
  }),

  defineTool({
    name: "delete_sequence",
    title: "Delete a sequence",
    description: "Deletes a library sequence. Campaigns made from it are not affected (they hold their own copy). Needs the person's confirmation.",
    input: z.object({ sequenceId: id("sequence") }),
    permission: "campaigns.write",
    risk: "important",
    preview: async (ctx, args, deps) => {
      const s = await deps.get(SequencesService).get(ctx, args.sequenceId);
      return {
        summary: `Permanently delete the saved sequence “${s.name}” (${s.stepCount} step${s.stepCount === 1 ? "" : "s"}: ${describeSteps(s.steps ?? [])}). Campaigns created from it keep their own copy and are not affected.`,
        details: { sequenceId: s.id, name: s.name, steps: s.stepCount },
      };
    },
    handler: async (ctx, args, deps) => deps.get(SequencesService).remove(ctx, args.sequenceId),
  }),
];
