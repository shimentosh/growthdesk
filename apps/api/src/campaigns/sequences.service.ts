import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { type SequenceInput, StepInput, requiredText, text } from "@growthdesk/shared";
import type { Prisma, Sequence, SequenceStep, StepType } from "../generated/prisma/client.js";
import { PrismaService, type Tx } from "../prisma/prisma.service.js";
import { AuditService } from "../core/audit.service.js";
import { actorId, ws, type RequestContext } from "../common/context.js";
import { notFound } from "../common/errors.js";
import { StepRulesService } from "./step-rules.service.js";
import { isUuid } from "./campaign-config.js";

export type StepInputT = z.infer<typeof StepInput>;

/** PATCH body for a library sequence: steps, when given, replace the whole list. */
export const SequencePatch = z.object({
  name: requiredText(120).optional(),
  description: text(1000).optional(),
  steps: z.array(StepInput).max(50).optional(),
});

export const SequenceListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  q: text(200).optional(),
});

export const stepDto = (s: SequenceStep) => ({ id: s.id, position: s.position, type: s.type, config: s.config });

export function sequenceDto(s: Sequence, steps?: SequenceStep[], stepCount?: number) {
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    kind: s.kind,
    archivedAt: s.archivedAt,
    createdById: s.createdById,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    stepCount: steps ? steps.length : (stepCount ?? 0),
    ...(steps ? { steps: steps.map(stepDto) } : {}),
  };
}

/**
 * Steps are stored as a flat list addressed by position 0..n-1. A list nobody
 * is enrolled in is replaced as a whole; a campaign with enrollments goes
 * through structureChange/editStepsInPlace instead.
 */
export async function replaceSteps(tx: Tx, workspaceId: string, sequenceId: string, steps: { type: StepType | string; config: unknown }[]) {
  await tx.sequenceStep.deleteMany({ where: { workspaceId, sequenceId } });
  if (!steps.length) return;
  await tx.sequenceStep.createMany({
    data: steps.map((s, position) => ({ workspaceId, sequenceId, position, type: s.type as StepType, config: (s.config ?? {}) as Prisma.InputJsonValue })),
  });
}

type StepLike = { type: StepType | string; config: unknown };

const laneOf = (s: StepLike) => {
  const cfg = (s.config && typeof s.config === "object" ? s.config : {}) as Record<string, unknown>;
  return `${Number(cfg.thenLength ?? 0)}/${Number(cfg.elseLength ?? 0)}`;
};

/**
 * Why `next` cannot replace `current` while enrollments hold places in it,
 * or null when it can. An enrollment's place is a step number (and a branch's
 * lanes are counts of the steps after it), so once anyone is enrolled the
 * existing steps must keep their number, kind and lane sizes: content and
 * timing may change, and steps may be added at the end. Anything else —
 * inserting, removing, reordering — would silently re-send a step to some
 * contacts and skip one for others.
 */
export function structureChange(current: StepLike[], next: StepLike[]): string | null {
  if (next.length < current.length) return `This removes ${current.length - next.length === 1 ? "a step" : `${current.length - next.length} steps`}`;
  for (let i = 0; i < current.length; i++) {
    const was = current[i]!;
    const now = next[i]!;
    if (was.type !== now.type) return `Step ${i + 1} changes from ${was.type} to ${now.type}`;
    if (was.type === "branch" && laneOf(was) !== laneOf(now)) return `Step ${i + 1} changes how many steps its branches hold`;
  }
  return null;
}

/**
 * Applies a list that passed structureChange without renumbering anything:
 * existing steps are updated in place (keeping their ids) and new ones are
 * added after them.
 */
export async function editStepsInPlace(tx: Tx, workspaceId: string, sequenceId: string, current: SequenceStep[], next: StepLike[]) {
  for (const [position, step] of current.entries()) {
    const config = (next[position]!.config ?? {}) as Prisma.InputJsonValue;
    if (JSON.stringify(config) === JSON.stringify(step.config)) continue;
    await tx.sequenceStep.updateMany({ where: { id: step.id, workspaceId, sequenceId, position }, data: { config } });
  }
  const added = next.slice(current.length);
  if (!added.length) return;
  await tx.sequenceStep.createMany({
    data: added.map((s, k) => ({ workspaceId, sequenceId, position: current.length + k, type: s.type as StepType, config: (s.config ?? {}) as Prisma.InputJsonValue })),
  });
}

/*
 * The library of reusable sequences. A campaign copies a library sequence
 * into its own (kind "campaign"), so editing one here never changes what a
 * running campaign sends.
 */
@Injectable()
export class SequencesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rules: StepRulesService,
    private readonly audit: AuditService,
  ) {}

  async find(workspaceId: string, id: string) {
    if (!isUuid(id)) throw notFound("That sequence");
    const s = await this.prisma.db.sequence.findFirst({ where: { id, workspaceId, kind: "library", archivedAt: null } });
    if (!s) throw notFound("That sequence");
    return s;
  }

  async steps(workspaceId: string, sequenceId: string) {
    return this.prisma.db.sequenceStep.findMany({ where: { workspaceId, sequenceId }, orderBy: { position: "asc" } });
  }

  async list(ctx: RequestContext, q: z.infer<typeof SequenceListQuery>) {
    const w = ws(ctx);
    const where: Prisma.SequenceWhereInput = {
      workspaceId: w.id,
      kind: "library",
      archivedAt: null,
      ...(q.q ? { name: { contains: q.q, mode: "insensitive" } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.db.sequence.findMany({
        where,
        include: { _count: { select: { steps: true } } },
        orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      this.prisma.db.sequence.count({ where }),
    ]);
    return { items: rows.map((s) => sequenceDto(s, undefined, s._count.steps)), total, page: q.page, pageSize: q.pageSize };
  }

  async get(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    const s = await this.find(w.id, id);
    return sequenceDto(s, await this.steps(w.id, id));
  }

  async create(ctx: RequestContext, input: z.infer<typeof SequenceInput>) {
    const w = ws(ctx);
    const steps = input.steps ?? [];
    await this.rules.validate(w.id, w.billingAccountId, steps);
    const created = await this.prisma.db.$transaction(async (tx) => {
      const s = await tx.sequence.create({
        data: { workspaceId: w.id, name: input.name, description: input.description ?? "", kind: "library", createdById: actorId(ctx) },
      });
      await replaceSteps(tx, w.id, s.id, steps);
      return s;
    });
    await this.audit.record(ctx, { action: "sequence.created", targetType: "sequence", targetId: created.id, metadata: { name: created.name, steps: steps.length } });
    return this.get(ctx, created.id);
  }

  async update(ctx: RequestContext, id: string, input: z.infer<typeof SequencePatch>) {
    const w = ws(ctx);
    await this.find(w.id, id);
    if (input.steps) await this.rules.validate(w.id, w.billingAccountId, input.steps);
    await this.prisma.db.$transaction(async (tx) => {
      await tx.sequence.updateMany({
        where: { id, workspaceId: w.id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          // Touch updatedAt even when only the steps changed.
          updatedAt: new Date(),
        },
      });
      if (input.steps) await replaceSteps(tx, w.id, id, input.steps);
    });
    return this.get(ctx, id);
  }

  async remove(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    const s = await this.find(w.id, id);
    // Campaigns hold their own copies, so a library sequence can go without touching any campaign.
    await this.prisma.db.sequence.deleteMany({ where: { id, workspaceId: w.id, kind: "library" } });
    await this.audit.record(ctx, { action: "sequence.deleted", targetType: "sequence", targetId: id, metadata: { name: s.name } });
    return { deleted: true };
  }

  async duplicate(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    const s = await this.find(w.id, id);
    const steps = await this.steps(w.id, id);
    const copy = await this.prisma.db.$transaction(async (tx) => {
      const c = await tx.sequence.create({
        data: { workspaceId: w.id, name: `${s.name} (copy)`.slice(0, 120), description: s.description, kind: "library", createdById: actorId(ctx) },
      });
      await replaceSteps(tx, w.id, c.id, steps);
      return c;
    });
    return this.get(ctx, copy.id);
  }
}
