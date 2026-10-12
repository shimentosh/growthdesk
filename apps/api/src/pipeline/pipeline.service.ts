import { Injectable } from "@nestjs/common";
import type { z } from "zod";
import type { DealInput, MeetingInput, PipelineInput } from "@growthdesk/shared";
import { Prisma } from "../generated/prisma/client.js";
import { PrismaService, type Tx } from "../prisma/prisma.service.js";
import { EventsService } from "../core/events.service.js";
import { ActivityService } from "../crm/activity.service.js";
import { advanceStage } from "../crm/lifecycle.js";
import { badRequest, conflict, notFound } from "../common/errors.js";
import { actorId, ownershipScope, ws, type RequestContext } from "../common/context.js";
import { DEFAULT_STAGES } from "../workspaces/workspaces.service.js";

type PipelineInputT = z.infer<typeof PipelineInput>;
type DealInputT = z.infer<typeof DealInput>;
type MeetingInputT = z.infer<typeof MeetingInput>;

const dealInclude = {
  stage: { select: { id: true, name: true, kind: true, position: true, color: true, probability: true } },
  contact: { select: { id: true, fullName: true, email: true } },
  company: { select: { id: true, name: true } },
  owner: { select: { id: true, name: true } },
  sourceCampaign: { select: { id: true, name: true } },
} satisfies Prisma.DealInclude;

type DealRow = Prisma.DealGetPayload<{ include: typeof dealInclude }>;

export const dealDto = (d: DealRow) => ({
  id: d.id,
  name: d.name,
  pipelineId: d.pipelineId,
  stage: d.stage,
  contact: d.contact,
  company: d.company,
  owner: d.owner,
  sourceCampaign: d.sourceCampaign,
  value: Number(d.value),
  currency: d.currency,
  status: d.status,
  expectedCloseDate: d.expectedCloseDate,
  wonReason: d.wonReason,
  lostReason: d.lostReason,
  proposalUrl: d.proposalUrl,
  description: d.description,
  stageEnteredAt: d.stageEnteredAt,
  closedAt: d.closedAt,
  createdAt: d.createdAt,
  updatedAt: d.updatedAt,
});

@Injectable()
export class PipelineService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
    private readonly activity: ActivityService,
  ) {}

  // ─── Pipelines ─────────────────────────────────────────────────────────────

  async pipelines(ctx: RequestContext) {
    const w = ws(ctx);
    const rows = await this.prisma.db.pipeline.findMany({
      where: { workspaceId: w.id, archivedAt: null },
      include: { stages: { orderBy: { position: "asc" } } },
      orderBy: [{ isDefault: "desc" }, { position: "asc" }],
    });
    return rows;
  }

  async createPipeline(ctx: RequestContext, input: PipelineInputT) {
    const w = ws(ctx);
    const stages = input.stages ?? DEFAULT_STAGES.map((s) => ({ name: s.name, kind: s.kind, probability: s.probability, color: s.color }));
    this.assertStages(stages);
    return this.prisma.db.$transaction(async (tx) => {
      if (input.isDefault) await tx.pipeline.updateMany({ where: { workspaceId: w.id }, data: { isDefault: false } });
      const count = await tx.pipeline.count({ where: { workspaceId: w.id, archivedAt: null } });
      const p = await tx.pipeline.create({ data: { workspaceId: w.id, name: input.name, isDefault: input.isDefault ?? count === 0, position: count } });
      await tx.pipelineStage.createMany({
        data: stages.map((s, i) => ({ workspaceId: w.id, pipelineId: p.id, name: s.name, kind: s.kind, probability: s.probability, color: s.color ?? "gray", position: i })),
      });
      return tx.pipeline.findFirstOrThrow({ where: { id: p.id, workspaceId: w.id }, include: { stages: { orderBy: { position: "asc" } } } });
    });
  }

  private assertStages(stages: { kind: string }[]) {
    if (!stages.some((s) => s.kind === "open")) throw badRequest("A pipeline needs at least one open stage");
    if (!stages.some((s) => s.kind === "won")) throw badRequest("A pipeline needs a Won stage");
    if (!stages.some((s) => s.kind === "lost")) throw badRequest("A pipeline needs a Lost stage");
  }

  /**
   * Renames and reorders stages. Stages that keep their id keep their deals;
   * a stage removed while deals sit in it is refused rather than orphaning them.
   */
  async updatePipeline(ctx: RequestContext, id: string, input: PipelineInputT) {
    const w = ws(ctx);
    const pipeline = await this.prisma.db.pipeline.findFirst({ where: { id, workspaceId: w.id, archivedAt: null }, include: { stages: true } });
    if (!pipeline) throw notFound("That pipeline");
    return this.prisma.db.$transaction(async (tx) => {
      if (input.isDefault) await tx.pipeline.updateMany({ where: { workspaceId: w.id }, data: { isDefault: false } });
      await tx.pipeline.update({ where: { id, workspaceId: w.id }, data: { name: input.name, ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}) } });
      if (input.stages) {
        this.assertStages(input.stages);
        const keep = new Set(input.stages.map((s) => s.id).filter(Boolean));
        const removed = pipeline.stages.filter((s) => !keep.has(s.id));
        if (removed.length) {
          const occupied = await tx.deal.count({ where: { workspaceId: w.id, stageId: { in: removed.map((s) => s.id) }, deletedAt: null } });
          if (occupied) throw conflict(`Move the ${occupied} deal${occupied > 1 ? "s" : ""} out of the removed stage${removed.length > 1 ? "s" : ""} first.`);
          await tx.pipelineStage.deleteMany({ where: { workspaceId: w.id, id: { in: removed.map((s) => s.id) } } });
        }
        // Two passes so the unique positions never collide mid-update.
        for (const s of pipeline.stages.filter((s) => keep.has(s.id))) {
          await tx.pipelineStage.update({ where: { id: s.id, workspaceId: w.id }, data: { position: 1000 + s.position } });
        }
        for (const [i, s] of input.stages.entries()) {
          const data = { name: s.name, kind: s.kind, probability: s.probability, color: s.color ?? "gray", position: i };
          if (s.id && pipeline.stages.some((p) => p.id === s.id)) await tx.pipelineStage.update({ where: { id: s.id, workspaceId: w.id }, data });
          else await tx.pipelineStage.create({ data: { workspaceId: w.id, pipelineId: id, ...data } });
        }
      }
      return tx.pipeline.findFirstOrThrow({ where: { id, workspaceId: w.id }, include: { stages: { orderBy: { position: "asc" } } } });
    });
  }

  async archivePipeline(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    const p = await this.prisma.db.pipeline.findFirst({ where: { id, workspaceId: w.id, archivedAt: null } });
    if (!p) throw notFound("That pipeline");
    if (p.isDefault) throw conflict("Make another pipeline the default before archiving this one.");
    const open = await this.prisma.db.deal.count({ where: { workspaceId: w.id, pipelineId: id, status: "open", deletedAt: null } });
    if (open) throw conflict(`This pipeline still has ${open} open deal${open > 1 ? "s" : ""}.`);
    await this.prisma.db.pipeline.update({ where: { id, workspaceId: w.id }, data: { archivedAt: new Date() } });
  }

  // ─── Deals ─────────────────────────────────────────────────────────────────

  private async defaultPipeline(tx: Tx, workspaceId: string) {
    const p = await tx.pipeline.findFirst({ where: { workspaceId, archivedAt: null }, orderBy: [{ isDefault: "desc" }, { position: "asc" }], include: { stages: { orderBy: { position: "asc" } } } });
    if (!p) throw conflict("This workspace has no pipeline — create one in Settings → Pipeline.");
    return p;
  }

  async deals(ctx: RequestContext, filter: { pipelineId?: string; status?: string; ownerId?: string; q?: string; contactId?: string }, page = 1, pageSize = 500) {
    const w = ws(ctx);
    const where: Prisma.DealWhereInput = {
      workspaceId: w.id,
      deletedAt: null,
      ...(filter.pipelineId ? { pipelineId: filter.pipelineId } : {}),
      ...(filter.status ? { status: filter.status as never } : {}),
      ...(filter.ownerId === "me" ? { ownerId: ctx.identity?.userId } : filter.ownerId ? { ownerId: filter.ownerId } : {}),
      ...(filter.contactId ? { contactId: filter.contactId } : {}),
      ...(filter.q ? { name: { contains: filter.q, mode: "insensitive" } } : {}),
      ...(ownershipScope(ctx) as Prisma.DealWhereInput),
    };
    const [rows, total] = await Promise.all([
      this.prisma.db.deal.findMany({ where, include: dealInclude, orderBy: [{ stageEnteredAt: "desc" }], skip: (page - 1) * pageSize, take: pageSize }),
      this.prisma.db.deal.count({ where }),
    ]);
    return { items: rows.map(dealDto), total, page, pageSize };
  }

  async deal(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    const d = await this.prisma.db.deal.findFirst({ where: { id, workspaceId: w.id, deletedAt: null, ...(ownershipScope(ctx) as Prisma.DealWhereInput) }, include: dealInclude });
    if (!d) throw notFound("That deal");
    const [history, meetings, tasks, notes] = await Promise.all([
      this.prisma.db.dealStageChange.findMany({ where: { workspaceId: w.id, dealId: id }, orderBy: { changedAt: "desc" } }),
      this.prisma.db.meeting.findMany({ where: { workspaceId: w.id, dealId: id }, orderBy: { startsAt: "desc" } }),
      this.prisma.db.task.findMany({ where: { workspaceId: w.id, dealId: id }, orderBy: { createdAt: "desc" }, take: 50 }),
      this.prisma.db.note.findMany({ where: { workspaceId: w.id, dealId: id }, orderBy: [{ pinned: "desc" }, { createdAt: "desc" }] }),
    ]);
    const stageIds = [...new Set(history.flatMap((h) => [h.fromStageId, h.toStageId]).filter(Boolean))] as string[];
    const stages = await this.prisma.db.pipelineStage.findMany({ where: { workspaceId: w.id, id: { in: stageIds } }, select: { id: true, name: true } });
    const name = new Map(stages.map((s) => [s.id, s.name]));
    return {
      ...dealDto(d),
      history: history.map((h) => ({ ...h, fromStage: h.fromStageId ? (name.get(h.fromStageId) ?? "") : null, toStage: name.get(h.toStageId) ?? "" })),
      meetings,
      tasks,
      notes,
    };
  }

  async createDeal(ctx: RequestContext, input: DealInputT) {
    const w = ws(ctx);
    const id = await this.prisma.db.$transaction(async (tx) => {
      const pipeline = input.pipelineId
        ? await tx.pipeline.findFirst({ where: { id: input.pipelineId, workspaceId: w.id, archivedAt: null }, include: { stages: { orderBy: { position: "asc" } } } })
        : await this.defaultPipeline(tx, w.id);
      if (!pipeline) throw notFound("That pipeline");
      const stage = input.stageId ? pipeline.stages.find((s) => s.id === input.stageId) : pipeline.stages.find((s) => s.kind === "open");
      if (!stage) throw badRequest("That stage is not in this pipeline");
      await this.assertRefs(tx, w.id, input);
      const deal = await tx.deal.create({
        data: {
          workspaceId: w.id,
          pipelineId: pipeline.id,
          stageId: stage.id,
          name: input.name,
          contactId: input.contactId ?? null,
          companyId: input.companyId ?? null,
          ownerId: input.ownerId ?? ctx.identity?.userId ?? null,
          value: input.value ?? 0,
          currency: input.currency ?? w.currency,
          expectedCloseDate: input.expectedCloseDate ?? null,
          sourceCampaignId: input.sourceCampaignId ?? null,
          description: input.description ?? "",
          proposalUrl: input.proposalUrl ?? "",
          status: stage.kind === "open" ? "open" : stage.kind,
          closedAt: stage.kind === "open" ? null : new Date(),
          createdById: actorId(ctx),
        },
      });
      await tx.dealStageChange.create({ data: { workspaceId: w.id, dealId: deal.id, fromStageId: null, toStageId: stage.id, changedById: actorId(ctx) } });
      // An open deal puts the person in sales; a deal created already won makes them a contact.
      await advanceStage(tx, w.id, [deal.contactId], deal.status === "won" ? "contact" : "sales");
      await this.activity.log({ workspaceId: w.id, dealId: deal.id, contactId: deal.contactId, companyId: deal.companyId, actorId: actorId(ctx), type: "deal.created", summary: `Deal "${deal.name}" created in ${stage.name}` }, tx);
      await this.events.emitIn(tx, { workspaceId: w.id, type: "deal.created", subjectType: "deal", subjectId: deal.id, actorId: actorId(ctx), payload: { stageId: stage.id, contactId: deal.contactId } });
      return deal.id;
    });
    await this.events.kick();
    return this.deal(ctx, id);
  }

  private async assertRefs(tx: Tx, workspaceId: string, input: { contactId?: string | null; companyId?: string | null; ownerId?: string | null; sourceCampaignId?: string | null }) {
    if (input.contactId && !(await tx.contact.findFirst({ where: { id: input.contactId, workspaceId, deletedAt: null } }))) throw notFound("That contact");
    if (input.companyId && !(await tx.company.findFirst({ where: { id: input.companyId, workspaceId, deletedAt: null } }))) throw notFound("That company");
    if (input.ownerId && !(await tx.membership.findUnique({ where: { workspaceId_userId: { workspaceId, userId: input.ownerId } } }))) throw badRequest("The owner must be a member of this workspace");
    if (input.sourceCampaignId && !(await tx.campaign.findFirst({ where: { id: input.sourceCampaignId, workspaceId } }))) throw notFound("That campaign");
  }

  async updateDeal(ctx: RequestContext, id: string, input: Partial<DealInputT>) {
    const w = ws(ctx);
    const existing = await this.prisma.db.deal.findFirst({ where: { id, workspaceId: w.id, deletedAt: null, ...(ownershipScope(ctx) as Prisma.DealWhereInput) } });
    if (!existing) throw notFound("That deal");
    await this.prisma.db.$transaction(async (tx) => {
      await this.assertRefs(tx, w.id, input);
      const data: Prisma.DealUncheckedUpdateInput = {};
      for (const key of ["name", "contactId", "companyId", "ownerId", "value", "currency", "expectedCloseDate", "sourceCampaignId", "description", "proposalUrl"] as const) {
        if (input[key] !== undefined) (data as Record<string, unknown>)[key] = input[key];
      }
      await tx.deal.update({ where: { id, workspaceId: w.id }, data });
    });
    if (input.stageId && input.stageId !== existing.stageId) await this.moveDeal(ctx, id, input.stageId);
    return this.deal(ctx, id);
  }

  /** Moves a deal between stages, recording history; entering a Won or Lost stage closes it. */
  async moveDeal(ctx: RequestContext, id: string, stageId: string, reason?: string) {
    const w = ws(ctx);
    await this.prisma.db.$transaction(async (tx) => {
      const deal = await tx.deal.findFirst({ where: { id, workspaceId: w.id, deletedAt: null, ...(ownershipScope(ctx) as Prisma.DealWhereInput) }, include: { stage: true } });
      if (!deal) throw notFound("That deal");
      const stage = await tx.pipelineStage.findFirst({ where: { id: stageId, workspaceId: w.id, pipelineId: deal.pipelineId } });
      if (!stage) throw badRequest("That stage is not in this deal's pipeline");
      if (stage.id === deal.stageId) return;
      const status = stage.kind === "open" ? "open" : stage.kind;
      await tx.deal.update({
        where: { id, workspaceId: w.id },
        data: {
          stageId,
          status,
          stageEnteredAt: new Date(),
          closedAt: status === "open" ? null : new Date(),
          ...(status === "won" && reason ? { wonReason: reason } : {}),
          ...(status === "lost" && reason ? { lostReason: reason } : {}),
        },
      });
      await tx.dealStageChange.create({ data: { workspaceId: w.id, dealId: id, fromStageId: deal.stageId, toStageId: stageId, changedById: actorId(ctx) } });
      await this.activity.log({ workspaceId: w.id, dealId: id, contactId: deal.contactId, companyId: deal.companyId, actorId: actorId(ctx), type: "deal.stage_changed", summary: `${deal.stage.name} → ${stage.name}`, data: { from: deal.stageId, to: stageId, reason } }, tx);
      const payload = { fromStageId: deal.stageId, toStageId: stageId, toStage: stage.name, status, contactId: deal.contactId, value: Number(deal.value) };
      await this.events.emitIn(tx, { workspaceId: w.id, type: "deal.stage_changed", subjectType: "deal", subjectId: id, actorId: actorId(ctx), payload });
      if (status === "won" || status === "lost") {
        await this.events.emitIn(tx, { workspaceId: w.id, type: `deal.${status}`, subjectType: "deal", subjectId: id, actorId: actorId(ctx), payload });
      }
      if (status === "won" && deal.contactId) {
        await tx.contact.updateMany({ where: { id: deal.contactId, workspaceId: w.id }, data: { status: "customer" } });
        await advanceStage(tx, w.id, [deal.contactId], "contact");
      }
    });
    await this.events.kick();
    return this.deal(ctx, id);
  }

  async deleteDeal(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    const res = await this.prisma.db.deal.updateMany({ where: { id, workspaceId: w.id, deletedAt: null, ...(ownershipScope(ctx) as Prisma.DealWhereInput) }, data: { deletedAt: new Date() } });
    if (!res.count) throw notFound("That deal");
  }

  // ─── Meetings ─────────────────────────────────────────────────────────────

  async meetings(ctx: RequestContext, from?: Date, to?: Date) {
    const w = ws(ctx);
    return this.prisma.db.meeting.findMany({
      where: { workspaceId: w.id, ...(from || to ? { startsAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}) },
      include: { contact: { select: { id: true, fullName: true } }, deal: { select: { id: true, name: true } } },
      orderBy: { startsAt: "asc" },
      take: 500,
    });
  }

  /** Records a meeting. A booked meeting stops the contact's sequences where the campaign says so (engine reads meeting.booked). */
  async createMeeting(ctx: RequestContext, input: MeetingInputT) {
    const w = ws(ctx);
    const meeting = await this.prisma.db.$transaction(async (tx) => {
      await this.assertRefs(tx, w.id, { contactId: input.contactId, ownerId: input.ownerId });
      if (input.dealId && !(await tx.deal.findFirst({ where: { id: input.dealId, workspaceId: w.id, deletedAt: null } }))) throw notFound("That deal");
      const m = await tx.meeting.create({
        data: {
          workspaceId: w.id,
          title: input.title,
          startsAt: input.startsAt,
          endsAt: input.endsAt ?? null,
          location: input.location ?? "",
          contactId: input.contactId ?? null,
          dealId: input.dealId ?? null,
          ownerId: input.ownerId ?? ctx.identity?.userId ?? null,
          status: input.status ?? "scheduled",
          notes: input.notes ?? "",
          createdById: actorId(ctx),
        },
      });
      await advanceStage(tx, w.id, [m.contactId], m.status === "completed" ? "contact" : "sales");
      await this.activity.log({ workspaceId: w.id, contactId: m.contactId, dealId: m.dealId, actorId: actorId(ctx), type: "meeting.booked", summary: `Meeting booked: ${m.title}`, data: { startsAt: m.startsAt } }, tx);
      await this.events.emitIn(tx, { workspaceId: w.id, type: "meeting.booked", subjectType: "meeting", subjectId: m.id, actorId: actorId(ctx), payload: { contactId: m.contactId, dealId: m.dealId, startsAt: m.startsAt } });
      return m;
    });
    await this.events.kick();
    return meeting;
  }

  async updateMeeting(ctx: RequestContext, id: string, input: Partial<MeetingInputT>) {
    const w = ws(ctx);
    return this.prisma.db.$transaction(async (tx) => {
      await this.assertRefs(tx, w.id, { contactId: input.contactId, ownerId: input.ownerId });
      if (input.dealId && !(await tx.deal.findFirst({ where: { id: input.dealId, workspaceId: w.id, deletedAt: null } }))) throw notFound("That deal");
      const res = await tx.meeting.updateMany({
        where: { id, workspaceId: w.id },
        data: {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.startsAt !== undefined ? { startsAt: input.startsAt } : {}),
          ...(input.endsAt !== undefined ? { endsAt: input.endsAt } : {}),
          ...(input.location !== undefined ? { location: input.location } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
          ...(input.contactId !== undefined ? { contactId: input.contactId } : {}),
          ...(input.dealId !== undefined ? { dealId: input.dealId } : {}),
          ...(input.ownerId !== undefined ? { ownerId: input.ownerId } : {}),
        },
      });
      if (!res.count) throw notFound("That meeting");
      const m = await tx.meeting.findFirstOrThrow({ where: { id, workspaceId: w.id } });
      // A meeting that took place turns the person into a contact.
      if (input.status === "completed") await advanceStage(tx, w.id, [m.contactId], "contact");
      return m;
    });
  }
}
