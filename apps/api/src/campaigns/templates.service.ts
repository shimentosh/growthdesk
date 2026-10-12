import { Injectable } from "@nestjs/common";
import { z } from "zod";
import {
  CHANNELS,
  STANDARD_VARIABLES,
  TEMPLATE_LIBRARY_CATEGORIES,
  type TemplateInput,
  missingVariables,
  renderTemplate,
  requiredText,
  text,
  unknownVariables,
  variablesFor,
} from "@growthdesk/shared";
import { Prisma, type Template } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { AuditService } from "../core/audit.service.js";
import { actorId, ownershipScope, ws, type RequestContext } from "../common/context.js";
import { notFound } from "../common/errors.js";
import { StepRulesService } from "./step-rules.service.js";
import { isUuid } from "./campaign-config.js";

type TemplateInputT = z.infer<typeof TemplateInput>;

/** PATCH body: TemplateInput without its defaults (a missing channel must not reset a WhatsApp template to email). */
export const TemplatePatch = z.object({
  channel: z.enum(CHANNELS).optional(),
  name: requiredText(120).optional(),
  category: text(60).optional(),
  subject: text(300).optional(),
  body: requiredText(50000).optional(),
  waTemplate: text(200).optional(),
  waLanguage: text(20).optional(),
});
export type TemplatePatchT = z.infer<typeof TemplatePatch>;

export const TemplatePreviewInput = z.object({
  contactId: z.string().uuid(),
  mailboxId: z.string().uuid().nullable().optional(),
  /** Unsaved editor content to preview instead of the stored version. */
  subject: text(300).optional(),
  body: text(50000).optional(),
});

export const TemplateListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  channel: z.enum(CHANNELS).optional(),
  q: text(200).optional(),
  category: text(60).optional(),
  archived: z.enum(["true", "false", "all"]).default("false"),
});

export function templateDto(t: Template, usage?: number) {
  return {
    id: t.id,
    channel: t.channel,
    name: t.name,
    category: t.category,
    subject: t.subject,
    body: t.body,
    version: t.version,
    waTemplate: t.waTemplate,
    waLanguage: t.waLanguage,
    fromLibrary: Boolean(t.libraryKey),
    archivedAt: t.archivedAt,
    createdById: t.createdById,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    ...(usage !== undefined ? { usedBySteps: usage } : {}),
  };
}

/** Message templates with an append-only version history. */
@Injectable()
export class TemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly rules: StepRulesService,
  ) {}

  private async find(workspaceId: string, id: string) {
    if (!isUuid(id)) throw notFound("That template");
    const t = await this.prisma.db.template.findFirst({ where: { id, workspaceId } });
    if (!t) throw notFound("That template");
    return t;
  }

  /** Sequence steps (library or campaign) that point at a template. */
  private usage(workspaceId: string, templateId: string) {
    return this.prisma.db.sequenceStep.count({ where: { workspaceId, config: { path: ["templateId"], equals: templateId } } });
  }

  /** Categories in use on active templates, with counts, in the library's order first and then by name. */
  async categories(ctx: RequestContext) {
    const rows = await this.prisma.db.template.groupBy({ by: ["category"], where: { workspaceId: ws(ctx).id, archivedAt: null, category: { not: "" } }, _count: { _all: true } });
    const order = new Map(TEMPLATE_LIBRARY_CATEGORIES.map((c, i) => [c, i]));
    return rows
      .map((r) => ({ category: r.category, count: r._count._all }))
      .sort((a, b) => (order.get(a.category) ?? 999) - (order.get(b.category) ?? 999) || a.category.localeCompare(b.category));
  }

  async list(ctx: RequestContext, q: z.infer<typeof TemplateListQuery>) {
    const w = ws(ctx);
    const where: Prisma.TemplateWhereInput = {
      workspaceId: w.id,
      ...(q.channel ? { channel: q.channel } : {}),
      ...(q.category ? { category: q.category } : {}),
      ...(q.archived === "false" ? { archivedAt: null } : q.archived === "true" ? { archivedAt: { not: null } } : {}),
      ...(q.q
        ? { OR: [{ name: { contains: q.q, mode: "insensitive" } }, { category: { contains: q.q, mode: "insensitive" } }, { subject: { contains: q.q, mode: "insensitive" } }] }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.db.template.findMany({ where, orderBy: [{ updatedAt: "desc" }, { id: "asc" }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      this.prisma.db.template.count({ where }),
    ]);
    return { items: rows.map((t) => templateDto(t)), total, page: q.page, pageSize: q.pageSize };
  }

  async get(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    const t = await this.find(w.id, id);
    return templateDto(t, await this.usage(w.id, id));
  }

  async create(ctx: RequestContext, input: TemplateInputT) {
    const w = ws(ctx);
    const actor = actorId(ctx);
    const t = await this.prisma.db.$transaction(async (tx) => {
      const row = await tx.template.create({
        data: {
          workspaceId: w.id,
          channel: input.channel,
          name: input.name,
          category: input.category ?? "",
          subject: input.subject ?? "",
          body: input.body,
          version: 1,
          waTemplate: input.waTemplate ?? "",
          waLanguage: input.waLanguage ?? "",
          createdById: actor,
        },
      });
      await tx.templateVersion.create({ data: { workspaceId: w.id, templateId: row.id, version: 1, subject: row.subject, body: row.body, createdById: actor } });
      return row;
    });
    await this.audit.record(ctx, { action: "template.created", targetType: "template", targetId: t.id, metadata: { name: t.name } });
    return templateDto(t, 0);
  }

  /** Every change to the subject or body bumps the version and keeps the previous wording in TemplateVersion. */
  async update(ctx: RequestContext, id: string, input: TemplatePatchT) {
    const w = ws(ctx);
    const actor = actorId(ctx);
    const existing = await this.find(w.id, id);
    const subject = input.subject ?? existing.subject;
    const body = input.body ?? existing.body;
    const reworded = subject !== existing.subject || body !== existing.body;
    const updated = await this.prisma.db.$transaction(async (tx) => {
      const version = reworded ? existing.version + 1 : existing.version;
      const res = await tx.template.updateMany({
        // Conditional on the version read, so two concurrent edits cannot both claim the same next version.
        where: { id, workspaceId: w.id, version: existing.version },
        data: {
          ...(input.channel !== undefined ? { channel: input.channel } : {}),
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.category !== undefined ? { category: input.category } : {}),
          ...(input.waTemplate !== undefined ? { waTemplate: input.waTemplate } : {}),
          ...(input.waLanguage !== undefined ? { waLanguage: input.waLanguage } : {}),
          subject,
          body,
          version,
        },
      });
      if (!res.count) throw notFound("That template");
      if (reworded) await tx.templateVersion.create({ data: { workspaceId: w.id, templateId: id, version, subject, body, createdById: actor } });
      return tx.template.findFirstOrThrow({ where: { id, workspaceId: w.id } });
    });
    return templateDto(updated, await this.usage(w.id, id));
  }

  async versions(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    await this.find(w.id, id);
    const rows = await this.prisma.db.templateVersion.findMany({ where: { workspaceId: w.id, templateId: id }, orderBy: { version: "desc" } });
    return rows.map((v) => ({ id: v.id, version: v.version, subject: v.subject, body: v.body, createdById: v.createdById, createdAt: v.createdAt }));
  }

  /** Deletes an unused template; one still referenced by a sequence step is archived instead, so those steps keep sending. */
  async remove(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    const t = await this.find(w.id, id);
    const used = await this.usage(w.id, id);
    if (used > 0) {
      await this.prisma.db.template.updateMany({ where: { id, workspaceId: w.id }, data: { archivedAt: t.archivedAt ?? new Date() } });
      await this.audit.record(ctx, { action: "template.archived", targetType: "template", targetId: id, metadata: { name: t.name, usedBySteps: used } });
      return { archived: true, deleted: false, usedBySteps: used };
    }
    await this.prisma.db.template.deleteMany({ where: { id, workspaceId: w.id } });
    await this.audit.record(ctx, { action: "template.deleted", targetType: "template", targetId: id, metadata: { name: t.name } });
    return { archived: false, deleted: true, usedBySteps: 0 };
  }

  async variables(ctx: RequestContext) {
    const w = ws(ctx);
    const defs = await this.prisma.db.customFieldDefinition.findMany({ where: { workspaceId: w.id, entity: "contact" }, orderBy: { position: "asc" } });
    return {
      standard: STANDARD_VARIABLES.map((v) => ({ key: v.key, label: v.label, token: `{{${v.key}}}` })),
      custom: defs.map((d) => ({ key: `custom.${d.key}`, label: d.label, type: d.type, token: `{{custom.${d.key}}}` })),
      fallbackSyntax: "{{first_name|there}}",
    };
  }

  /** The template rendered for one contact, with what would be missing (blocks a send) and unknown (a typo). */
  async preview(ctx: RequestContext, id: string, input: z.infer<typeof TemplatePreviewInput>) {
    const w = ws(ctx);
    const t = await this.find(w.id, id);
    const contact = await this.prisma.db.contact.findFirst({
      where: { id: input.contactId, workspaceId: w.id, deletedAt: null, ...(ownershipScope(ctx) as Prisma.ContactWhereInput) },
      include: { company: { select: { name: true, domain: true } }, owner: { select: { name: true } } },
    });
    if (!contact) throw notFound("That contact");
    const mailbox = input.mailboxId
      ? await this.prisma.db.mailbox.findFirst({ where: { id: input.mailboxId, workspaceId: w.id, deletedAt: null } })
      : await this.prisma.db.mailbox.findFirst({ where: { workspaceId: w.id, deletedAt: null, status: "connected" }, orderBy: { createdAt: "asc" } });
    if (input.mailboxId && !mailbox) throw notFound("That mailbox");
    const sender = mailbox
      ? { senderName: mailbox.displayName, senderEmail: mailbox.email }
      : { senderName: ctx.identity?.name ?? "", senderEmail: ctx.identity?.email ?? "" };
    // The real link is minted per message at send time.
    const vars = variablesFor(contact, { ...sender, unsubscribeUrl: "[unsubscribe link]" });
    const subject = input.subject ?? t.subject;
    const body = input.body ?? t.body;
    const both = `${subject}\n${body}`;
    return {
      templateId: t.id,
      version: t.version,
      channel: t.channel,
      contact: { id: contact.id, fullName: contact.fullName, email: contact.email },
      sender: { name: sender.senderName, email: sender.senderEmail, mailboxId: mailbox?.id ?? null },
      subject: renderTemplate(subject, vars),
      body: renderTemplate(body, vars),
      missing: missingVariables(both, vars),
      unknown: unknownVariables(both, await this.rules.customKeys(w.id)),
    };
  }
}
