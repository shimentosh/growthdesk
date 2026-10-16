import { z } from "zod";
import { CHANNELS, TemplateInput } from "@growthdesk/shared";
import { TemplateListQuery, TemplatePatch, TemplatesService } from "../../../campaigns/templates.service.js";
import { defineTool, pageInput, paged } from "../../tool.js";
import { id, preview, validate } from "./shared.js";

/*
 * Message templates (email / WhatsApp / Telegram) that sequence steps can use
 * by templateId. Same permissions as TemplatesController.
 */

const VARS = "Personalize with {{first_name|there}}-style tokens (a fallback after | avoids failed sends when a value is missing); get_step_reference lists the variables.";

const templateOut = (t: { id: string; channel: string; name: string; category: string; subject: string; body: string; version: number; archivedAt: Date | null; usedBySteps?: number }) => ({
  id: t.id,
  channel: t.channel,
  name: t.name,
  category: t.category,
  subject: t.subject,
  body: t.body,
  version: t.version,
  archived: Boolean(t.archivedAt),
  ...(t.usedBySteps !== undefined ? { usedBySteps: t.usedBySteps } : {}),
});

export const OUTREACH_TEMPLATE_TOOLS = [
  defineTool({
    name: "list_templates",
    title: "List message templates",
    description: "Message templates (email, WhatsApp, Telegram) a sequence step can use by templateId. Shows a short body preview; get_template has the full text.",
    input: z.object({
      channel: z.enum(CHANNELS).optional().describe("Only this channel."),
      search: z.string().trim().max(200).optional().describe("Matches name, category or subject."),
      category: z.string().trim().max(60).optional(),
      archived: z.enum(["false", "true", "all"]).default("false").describe("Archived templates (still used by steps but hidden): false (default), true or all."),
      ...pageInput,
    }),
    permission: "templates.read",
    risk: "read",
    handler: async (ctx, args, deps) => {
      const q = validate(TemplateListQuery, { page: args.page, pageSize: args.limit, channel: args.channel, q: args.search, category: args.category, archived: args.archived });
      const r = await deps.get(TemplatesService).list(ctx, q);
      return paged(
        r.items.map((t) => ({ id: t.id, channel: t.channel, name: t.name, category: t.category, subject: t.subject, bodyPreview: preview(t.body), archived: Boolean(t.archivedAt) })),
        r.total,
        args.page,
        args.limit,
      );
    },
  }),

  defineTool({
    name: "get_template",
    title: "Get a message template",
    description: "One template in full: subject, body, version, and how many sequence steps use it.",
    input: z.object({ templateId: id("template") }),
    permission: "templates.read",
    risk: "read",
    handler: async (ctx, args, deps) => templateOut(await deps.get(TemplatesService).get(ctx, args.templateId)),
  }),

  defineTool({
    name: "create_template",
    title: "Create a message template",
    description: `Saves a reusable message template. channel: email (default), whatsapp or telegram. Email bodies are plain text. ${VARS}`,
    input: TemplateInput.extend({
      subject: TemplateInput.shape.subject.describe("Email subject (email templates)."),
      body: TemplateInput.shape.body.describe("The message text."),
      category: TemplateInput.shape.category.describe("Optional grouping, e.g. Cold outreach, Follow-up."),
      waTemplate: TemplateInput.shape.waTemplate.describe("WhatsApp only: an approved Meta template name, for messages outside the 24-hour window."),
      waLanguage: TemplateInput.shape.waLanguage.describe("WhatsApp only: the template's language code, e.g. en_US."),
    }),
    permission: "templates.write",
    risk: "write",
    idempotent: false,
    handler: async (ctx, args, deps) => templateOut(await deps.get(TemplatesService).create(ctx, validate(TemplateInput, args))),
  }),

  defineTool({
    name: "update_template",
    title: "Update a message template",
    description: `Changes a template; only the fields given change. A new subject/body bumps its version (the old wording is kept). Steps that use it send the new wording from their next send. ${VARS}`,
    input: TemplatePatch.extend({ templateId: id("template") }),
    permission: "templates.write",
    risk: "write",
    handler: async (ctx, args, deps) => {
      const { templateId, ...patch } = args;
      return templateOut(await deps.get(TemplatesService).update(ctx, templateId, validate(TemplatePatch, patch)));
    },
  }),

  defineTool({
    name: "delete_template",
    title: "Delete a message template",
    description: "Deletes a template. One still used by sequence steps is archived instead, so those steps keep sending. Needs the person's confirmation.",
    input: z.object({ templateId: id("template") }),
    permission: "templates.write",
    risk: "important",
    preview: async (ctx, args, deps) => {
      const t = await deps.get(TemplatesService).get(ctx, args.templateId);
      const used = t.usedBySteps ?? 0;
      return {
        summary: used
          ? `Archive the ${t.channel} template “${t.name}”. It is used by ${used} sequence step${used === 1 ? "" : "s"}, so it is archived (hidden, still sent by those steps) rather than deleted.`
          : `Permanently delete the ${t.channel} template “${t.name}” (not used by any step).`,
        details: { templateId: t.id, name: t.name, usedBySteps: used },
      };
    },
    handler: async (ctx, args, deps) => deps.get(TemplatesService).remove(ctx, args.templateId),
  }),
];
