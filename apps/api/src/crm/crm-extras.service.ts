import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service.js";
import { ActivityService } from "./activity.service.js";
import { badRequest, conflict, notFound } from "../common/errors.js";
import { actorId, me, ws, type RequestContext } from "../common/context.js";

/** Tags, custom fields, saved views and notes — the small CRM furniture. */
@Injectable()
export class CrmExtrasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
  ) {}

  // Tags
  async tags(ctx: RequestContext) {
    const w = ws(ctx);
    const rows = await this.prisma.db.tag.findMany({
      where: { workspaceId: w.id },
      include: { _count: { select: { contacts: true, companies: true } } },
      orderBy: { name: "asc" },
    });
    return rows.map((t) => ({ id: t.id, name: t.name, color: t.color, contactCount: t._count.contacts, companyCount: t._count.companies }));
  }

  async createTag(ctx: RequestContext, name: string, color?: string) {
    const w = ws(ctx);
    const exists = await this.prisma.db.tag.findFirst({ where: { workspaceId: w.id, name } });
    if (exists) throw conflict("That tag already exists");
    return this.prisma.db.tag.create({ data: { workspaceId: w.id, name, color: color ?? "gray" } });
  }

  async updateTag(ctx: RequestContext, id: string, name?: string, color?: string) {
    const w = ws(ctx);
    const res = await this.prisma.db.tag.updateMany({ where: { id, workspaceId: w.id }, data: { ...(name ? { name } : {}), ...(color ? { color } : {}) } });
    if (!res.count) throw notFound("That tag");
  }

  async deleteTag(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    const res = await this.prisma.db.tag.deleteMany({ where: { id, workspaceId: w.id } });
    if (!res.count) throw notFound("That tag");
  }

  // Custom fields
  fields(ctx: RequestContext, entity?: string) {
    const w = ws(ctx);
    return this.prisma.db.customFieldDefinition.findMany({
      where: { workspaceId: w.id, ...(entity ? { entity } : {}) },
      orderBy: [{ entity: "asc" }, { position: "asc" }],
    });
  }

  async createField(ctx: RequestContext, input: { entity: string; key: string; label: string; type: string; options: string[] }) {
    const w = ws(ctx);
    if (input.type === "select" && !input.options.length) throw badRequest("A select field needs at least one option");
    const exists = await this.prisma.db.customFieldDefinition.findFirst({ where: { workspaceId: w.id, entity: input.entity, key: input.key } });
    if (exists) throw conflict(`A ${input.entity} field with the key "${input.key}" already exists`);
    const position = await this.prisma.db.customFieldDefinition.count({ where: { workspaceId: w.id, entity: input.entity } });
    return this.prisma.db.customFieldDefinition.create({ data: { workspaceId: w.id, ...input, options: input.options, position } });
  }

  async updateField(ctx: RequestContext, id: string, input: { label?: string; options?: string[] }) {
    const w = ws(ctx);
    const res = await this.prisma.db.customFieldDefinition.updateMany({ where: { id, workspaceId: w.id }, data: input });
    if (!res.count) throw notFound("That field");
  }

  /** Removes the definition; values already stored on records are kept (they remain in exports). */
  async deleteField(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    const res = await this.prisma.db.customFieldDefinition.deleteMany({ where: { id, workspaceId: w.id } });
    if (!res.count) throw notFound("That field");
  }

  // Saved views
  views(ctx: RequestContext, entity: string) {
    const w = ws(ctx);
    return this.prisma.db.savedView.findMany({
      where: { workspaceId: w.id, entity, OR: [{ userId: null }, { userId: me(ctx).userId }] },
      orderBy: { name: "asc" },
    });
  }

  createView(ctx: RequestContext, input: { entity: string; name: string; filters: Record<string, unknown>; sort: Record<string, unknown>; shared: boolean }) {
    const w = ws(ctx);
    return this.prisma.db.savedView.create({
      data: { workspaceId: w.id, userId: input.shared ? null : me(ctx).userId, entity: input.entity, name: input.name, filters: input.filters as never, sort: input.sort as never },
    });
  }

  async deleteView(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    const view = await this.prisma.db.savedView.findFirst({ where: { id, workspaceId: w.id } });
    if (!view) throw notFound("That view");
    if (view.userId && view.userId !== me(ctx).userId) throw notFound("That view");
    await this.prisma.db.savedView.deleteMany({ where: { id, workspaceId: w.id } });
  }

  async getView(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    const view = await this.prisma.db.savedView.findFirst({ where: { id, workspaceId: w.id, OR: [{ userId: null }, { userId: ctx.identity?.userId ?? "" }] } });
    if (!view) throw notFound("That view");
    return view;
  }

  // Notes
  async notes(ctx: RequestContext, target: { contactId?: string; companyId?: string; dealId?: string }) {
    const w = ws(ctx);
    const notes = await this.prisma.db.note.findMany({ where: { workspaceId: w.id, ...target }, orderBy: [{ pinned: "desc" }, { createdAt: "desc" }] });
    const authors = await this.prisma.db.user.findMany({ where: { id: { in: notes.map((n) => n.authorId).filter(Boolean) as string[] } }, select: { id: true, name: true } });
    const byId = new Map(authors.map((a) => [a.id, a]));
    return notes.map((n) => ({ ...n, author: n.authorId ? (byId.get(n.authorId) ?? null) : null }));
  }

  async addNote(ctx: RequestContext, target: { contactId?: string; companyId?: string; dealId?: string }, body: string, pinned = false) {
    const w = ws(ctx);
    if (target.contactId && !(await this.prisma.db.contact.findFirst({ where: { id: target.contactId, workspaceId: w.id, deletedAt: null } }))) throw notFound("That contact");
    if (target.companyId && !(await this.prisma.db.company.findFirst({ where: { id: target.companyId, workspaceId: w.id, deletedAt: null } }))) throw notFound("That company");
    if (target.dealId && !(await this.prisma.db.deal.findFirst({ where: { id: target.dealId, workspaceId: w.id, deletedAt: null } }))) throw notFound("That deal");
    const note = await this.prisma.db.note.create({ data: { workspaceId: w.id, ...target, body, pinned, authorId: actorId(ctx) } });
    await this.activity.log({ workspaceId: w.id, ...target, actorId: actorId(ctx), type: "note.added", summary: body.slice(0, 140) });
    return note;
  }

  async updateNote(ctx: RequestContext, id: string, input: { body?: string; pinned?: boolean }) {
    const w = ws(ctx);
    const res = await this.prisma.db.note.updateMany({ where: { id, workspaceId: w.id }, data: input });
    if (!res.count) throw notFound("That note");
  }

  async deleteNote(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    const res = await this.prisma.db.note.deleteMany({ where: { id, workspaceId: w.id } });
    if (!res.count) throw notFound("That note");
  }

  async timeline(ctx: RequestContext, target: { contactId?: string; companyId?: string; dealId?: string }) {
    const w = ws(ctx);
    const rows = await this.prisma.db.activity.findMany({ where: { workspaceId: w.id, ...target }, orderBy: { occurredAt: "desc" }, take: 200 });
    const actors = await this.prisma.db.user.findMany({ where: { id: { in: rows.map((r) => r.actorId).filter(Boolean) as string[] } }, select: { id: true, name: true } });
    const byId = new Map(actors.map((a) => [a.id, a]));
    return rows.map((r) => ({ ...r, actor: r.actorId ? (byId.get(r.actorId) ?? null) : null }));
  }
}
