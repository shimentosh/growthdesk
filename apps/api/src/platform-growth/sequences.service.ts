import { Injectable } from "@nestjs/common";
import type { PlatformDripSequenceInput, PlatformDripSequenceUpdate, PlatformDripStepInput, PlatformDripStepUpdate } from "@growthdesk/shared";
import type { z } from "zod";
import { Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { AuditService } from "../core/audit.service.js";
import type { RequestContext } from "../common/context.js";
import { ApiError, badRequest, conflict, notFound } from "../common/errors.js";
import { contentOf, marketingProblems } from "./marketing-mailer.js";
import { starterMarketingBlocks } from "./broadcasts.service.js";

/*
 * Onboarding drip sequences (admin side).
 *
 * The activation watermark: enrollment only takes triggers that happened
 * after activation, and the schema has no activatedAt column, so while a
 * sequence is active its `updatedAt` holds the activation time. Every write to
 * an ACTIVE sequence row therefore passes `updatedAt` explicitly (Prisma then
 * keeps it); activate() is the only write that moves it. Steps live in their
 * own table, so editing them never touches the watermark.
 *
 * Deactivating pauses: enrollments stay, nothing is sent or enrolled until it
 * is active again (and re-activation does not backfill the paused period).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type StepRow = { id: string; position: number; delayHours: number; subject: string; preheader: string; blocks: unknown; createdAt: Date; updatedAt: Date };

const stepDto = (s: StepRow) => {
  const content = contentOf(s);
  return { id: s.id, position: s.position, delayHours: s.delayHours, subject: s.subject, preheader: s.preheader, blocks: content.blocks, problems: marketingProblems(content), updatedAt: s.updatedAt };
};

@Injectable()
export class SequencesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private record(ctx: RequestContext, action: string, targetId: string, metadata: Record<string, unknown> = {}) {
    return this.audit.record(ctx, { workspaceId: null, action, targetType: "platform_drip_sequence", targetId, metadata }, "platform_admin");
  }

  private async find(id: string) {
    if (!UUID.test(id)) throw notFound("That sequence");
    const row = await this.prisma.db.platformDripSequence.findUnique({ where: { id }, include: { steps: { orderBy: { position: "asc" } } } });
    if (!row) throw notFound("That sequence");
    return row;
  }

  private async enrollmentCounts(ids: string[]) {
    if (!ids.length) return [];
    return this.prisma.db.platformDripEnrollment.groupBy({ by: ["sequenceId", "status"], where: { sequenceId: { in: ids } }, _count: { _all: true } });
  }

  async list() {
    const rows = await this.prisma.db.platformDripSequence.findMany({ orderBy: { createdAt: "desc" }, include: { _count: { select: { steps: true } } } });
    const counts = await this.enrollmentCounts(rows.map((r) => r.id));
    return rows.map((r) => {
      const of = (s: string) => counts.find((c) => c.sequenceId === r.id && c.status === s)?._count._all ?? 0;
      return {
        id: r.id,
        name: r.name,
        trigger: r.trigger,
        active: r.active,
        activatedAt: r.active ? r.updatedAt : null,
        steps: r._count.steps,
        enrollments: { active: of("active"), completed: of("completed"), stopped: of("stopped") },
        createdAt: r.createdAt,
      };
    });
  }

  async detail(id: string) {
    const r = await this.find(id);
    const counts = await this.enrollmentCounts([id]);
    const of = (s: string) => counts.find((c) => c.status === s)?._count._all ?? 0;
    return {
      id: r.id,
      name: r.name,
      trigger: r.trigger,
      active: r.active,
      activatedAt: r.active ? r.updatedAt : null,
      steps: r.steps.map(stepDto),
      enrollments: { active: of("active"), completed: of("completed"), stopped: of("stopped") },
      createdAt: r.createdAt,
    };
  }

  async create(ctx: RequestContext, input: z.infer<typeof PlatformDripSequenceInput>) {
    const row = await this.prisma.db.platformDripSequence.create({
      data: {
        name: input.name,
        trigger: input.trigger,
        active: false,
        steps: {
          create: [{ position: 1, delayHours: 0, subject: "Welcome to {{product_name}}", preheader: "", blocks: starterMarketingBlocks() as never }],
        },
      },
    });
    await this.record(ctx, "platform.growth_sequence_created", row.id, { name: row.name, trigger: row.trigger });
    return this.detail(row.id);
  }

  async update(ctx: RequestContext, id: string, input: z.infer<typeof PlatformDripSequenceUpdate>) {
    const r = await this.find(id);
    if (r.active && input.trigger && input.trigger !== r.trigger) throw conflict("Deactivate the sequence before changing its trigger.");
    await this.prisma.db.platformDripSequence.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.trigger !== undefined ? { trigger: input.trigger } : {}),
        // Keeps the activation watermark (see the header).
        ...(r.active ? { updatedAt: r.updatedAt } : {}),
      },
    });
    await this.record(ctx, "platform.growth_sequence_updated", id, { fields: Object.keys(input) });
    return this.detail(id);
  }

  async remove(ctx: RequestContext, id: string) {
    const r = await this.find(id);
    if (r.active) throw conflict("Deactivate the sequence before deleting it.");
    await this.prisma.db.platformDripSequence.delete({ where: { id } });
    await this.record(ctx, "platform.growth_sequence_deleted", id, { name: r.name });
    return { ok: true };
  }

  async activate(ctx: RequestContext, id: string) {
    const r = await this.find(id);
    if (r.active) return this.detail(id);
    if (!r.steps.length) throw badRequest("Add at least one step first.");
    const problems = r.steps.flatMap((s) => marketingProblems(contentOf(s)).map((p) => `Step ${s.position}: ${p}`));
    if (problems.length) throw new ApiError(400, "bad_request", problems[0]!, undefined, { problems });
    // updatedAt moves to now: the watermark from which triggers enroll.
    await this.prisma.db.platformDripSequence.updateMany({ where: { id, active: false }, data: { active: true } });
    await this.record(ctx, "platform.growth_sequence_activated", id, { name: r.name, trigger: r.trigger });
    return this.detail(id);
  }

  async deactivate(ctx: RequestContext, id: string) {
    const r = await this.find(id);
    if (!r.active) return this.detail(id);
    await this.prisma.db.platformDripSequence.updateMany({ where: { id, active: true }, data: { active: false } });
    await this.record(ctx, "platform.growth_sequence_deactivated", id, { name: r.name });
    return this.detail(id);
  }

  /** A step's content, for a test send. */
  async stepContent(id: string, stepId: string) {
    const r = await this.find(id);
    const step = r.steps.find((s) => s.id === stepId);
    if (!step) throw notFound("That step");
    return contentOf(step);
  }

  // ─── Steps ─────────────────────────────────────────────────────────────────

  private assertValidWhenActive(active: boolean, content: { subject: string; preheader: string; blocks: unknown }) {
    if (!active) return;
    const problems = marketingProblems(contentOf(content));
    if (problems.length) throw new ApiError(400, "bad_request", `This sequence is live, so the step must be ready to send: ${problems[0]}`, undefined, { problems });
  }

  async addStep(ctx: RequestContext, id: string, input: z.infer<typeof PlatformDripStepInput>) {
    const r = await this.find(id);
    if (r.steps.length >= 50) throw badRequest("A sequence has at most 50 steps.");
    this.assertValidWhenActive(r.active, input);
    const position = (r.steps.at(-1)?.position ?? 0) + 1;
    const step = await this.prisma.db.platformDripStep.create({
      data: { sequenceId: id, position, delayHours: input.delayHours, subject: input.subject, preheader: input.preheader, blocks: input.blocks as never },
    });
    await this.record(ctx, "platform.growth_step_added", id, { stepId: step.id, position });
    return this.detail(id);
  }

  async updateStep(ctx: RequestContext, id: string, stepId: string, input: z.infer<typeof PlatformDripStepUpdate>) {
    const r = await this.find(id);
    const step = r.steps.find((s) => s.id === stepId);
    if (!step) throw notFound("That step");
    const merged = {
      subject: input.subject ?? step.subject,
      preheader: input.preheader ?? step.preheader,
      blocks: input.blocks ?? step.blocks,
    };
    this.assertValidWhenActive(r.active, merged);
    await this.prisma.db.platformDripStep.update({
      where: { id: stepId },
      data: { ...(input.delayHours !== undefined ? { delayHours: input.delayHours } : {}), subject: merged.subject, preheader: merged.preheader, blocks: merged.blocks as never },
    });
    await this.record(ctx, "platform.growth_step_updated", id, { stepId, fields: Object.keys(input) });
    return this.detail(id);
  }

  /** Removes a step and closes the gap; enrollments waiting for a later step keep waiting for that same step. */
  async deleteStep(ctx: RequestContext, id: string, stepId: string) {
    const r = await this.find(id);
    const step = r.steps.find((s) => s.id === stepId);
    if (!step) throw notFound("That step");
    if (r.active && r.steps.length === 1) throw conflict("A live sequence needs at least one step. Deactivate it first.");
    await this.prisma.db.$transaction(async (tx) => {
      await tx.platformDripStep.delete({ where: { id: stepId } });
      await tx.$executeRaw`UPDATE "PlatformDripStep" SET position = -(position - 1) WHERE "sequenceId" = ${id}::uuid AND position > ${step.position}::int`;
      await tx.$executeRaw`UPDATE "PlatformDripStep" SET position = -position WHERE "sequenceId" = ${id}::uuid AND position < 0`;
      await tx.$executeRaw`UPDATE "PlatformDripEnrollment" SET "nextStepPosition" = "nextStepPosition" - 1 WHERE "sequenceId" = ${id}::uuid AND "nextStepPosition" > ${step.position}::int`;
    });
    await this.record(ctx, "platform.growth_step_deleted", id, { stepId, position: step.position });
    return this.detail(id);
  }

  /** New order (every step id once). Enrollments keep pointing at the same next step. */
  async reorder(ctx: RequestContext, id: string, stepIds: string[]) {
    const r = await this.find(id);
    const current = r.steps.map((s) => s.id);
    if (stepIds.length !== current.length || new Set(stepIds).size !== stepIds.length || !stepIds.every((s) => current.includes(s))) {
      throw badRequest("List every step of the sequence exactly once.");
    }
    const moves = stepIds.map((sid, i) => ({ from: r.steps.find((s) => s.id === sid)!.position, to: i + 1, id: sid }));
    await this.prisma.db.$transaction(async (tx) => {
      for (const m of moves) await tx.$executeRaw`UPDATE "PlatformDripStep" SET position = ${-m.to}::int WHERE id = ${m.id}::uuid`;
      await tx.$executeRaw`UPDATE "PlatformDripStep" SET position = -position WHERE "sequenceId" = ${id}::uuid AND position < 0`;
      for (const m of moves) {
        await tx.$executeRaw`UPDATE "PlatformDripEnrollment" SET "nextStepPosition" = ${-m.to}::int WHERE "sequenceId" = ${id}::uuid AND status = 'active' AND "nextStepPosition" = ${m.from}::int`;
      }
      await tx.$executeRaw`UPDATE "PlatformDripEnrollment" SET "nextStepPosition" = -"nextStepPosition" WHERE "sequenceId" = ${id}::uuid AND "nextStepPosition" < 0`;
    });
    await this.record(ctx, "platform.growth_steps_reordered", id, { order: stepIds });
    return this.detail(id);
  }

  async stats(id: string) {
    const r = await this.find(id);
    const rows = r.steps.length
      ? await this.prisma.db.$queryRaw<
          { stepId: string; total: number; sent: number; delivered: number; opened: number; clicked: number; bounced: number; complained: number; failed: number; queued: number }[]
        >`
        SELECT "dripStepId" AS "stepId", count(*)::int AS total,
          count(*) FILTER (WHERE status = 'queued')::int AS queued,
          count(*) FILTER (WHERE status NOT IN ('queued', 'failed', 'suppressed'))::int AS sent,
          count(*) FILTER (WHERE "deliveredAt" IS NOT NULL OR status IN ('delivered', 'complained'))::int AS delivered,
          count(*) FILTER (WHERE "openedAt" IS NOT NULL)::int AS opened,
          count(*) FILTER (WHERE "clickedAt" IS NOT NULL)::int AS clicked,
          count(*) FILTER (WHERE status = 'bounced')::int AS bounced,
          count(*) FILTER (WHERE status = 'complained')::int AS complained,
          count(*) FILTER (WHERE status IN ('failed', 'suppressed'))::int AS failed
        FROM "EmailLog" WHERE "dripStepId" IN (${this.uuidList(r.steps.map((s) => s.id))}) GROUP BY "dripStepId"`
      : [];
    const unsubs = r.steps.length
      ? await this.prisma.db.$queryRaw<{ stepId: string; n: number }[]>`
        SELECT l."dripStepId" AS "stepId", count(DISTINCT l."userId")::int AS n FROM "PlatformEmailEvent" e JOIN "EmailLog" l ON l.id = e."emailLogId"
        WHERE e.type = 'unsubscribed' AND l."dripStepId" IN (${this.uuidList(r.steps.map((s) => s.id))}) GROUP BY l."dripStepId"`
      : [];
    const waiting = await this.prisma.db.platformDripEnrollment.groupBy({ by: ["nextStepPosition"], where: { sequenceId: id, status: "active" }, _count: { _all: true } });
    const empty = { total: 0, queued: 0, sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, complained: 0, failed: 0 };
    return {
      id: r.id,
      steps: r.steps.map((s) => {
        const { stepId: _ignored, ...email } = rows.find((x) => x.stepId === s.id) ?? { stepId: s.id, ...empty };
        return {
          stepId: s.id,
          position: s.position,
          subject: s.subject,
          waiting: waiting.find((w) => w.nextStepPosition === s.position)?._count._all ?? 0,
          email,
          unsubscribes: unsubs.find((u) => u.stepId === s.id)?.n ?? 0,
        };
      }),
    };
  }

  private uuidList(ids: string[]) {
    return Prisma.join(ids.map((x) => Prisma.sql`${x}::uuid`));
  }
}

