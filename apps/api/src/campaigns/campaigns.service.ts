import { Injectable } from "@nestjs/common";
import { z } from "zod";
import {
  AudienceInput,
  CAMPAIGN_STATUSES,
  CampaignInput,
  ENROLLMENT_STATUSES,
  FEATURE_LABELS,
  type FeatureKey,
  ListQuery,
  StepInput,
  isoDate,
  missingVariables,
  optionalUuid,
  requiredText,
  text,
  uuid,
  variablesFor,
} from "@growthdesk/shared";
import type { Campaign, CampaignStatus, Enrollment, Prisma, SequenceStep } from "../generated/prisma/client.js";
import { PrismaService, type Tx } from "../prisma/prisma.service.js";
import { EntitlementsService } from "../billing/entitlements.service.js";
import { AuditService } from "../core/audit.service.js";
import { ActivityService } from "../crm/activity.service.js";
import { CrmExtrasService } from "../crm/crm-extras.service.js";
import { ApiError, badRequest, conflict, notFound } from "../common/errors.js";
import { actorId, ownershipScope, ws, type RequestContext } from "../common/context.js";
import {
  ACTION_STEPS,
  type AudienceT,
  LooseObject,
  MESSAGE_STEPS,
  campaignDefaults,
  configOf,
  describeAudience,
  isUuid,
  mergeSchedule,
  mergeSettings,
  readAudience,
  readSchedule,
  readSettings,
} from "./campaign-config.js";
import { SKIP_LABELS, SKIP_REASONS, type Skipped, EnrollmentService } from "./enrollment.service.js";
import { EngineService } from "./engine.service.js";
import { StepRulesService } from "./step-rules.service.js";
import { SequencesService, editStepsInPlace, replaceSteps, stepDto, structureChange } from "./sequences.service.js";

// ─── Request schemas ─────────────────────────────────────────────────────────

/** Create: schedule/settings arrive loose and are merged over the workspace defaults before they are validated. */
export const CampaignCreateBody = CampaignInput.extend({ schedule: LooseObject.optional(), settings: LooseObject.optional() });

/** Update: every field optional; schedule/settings merge over what is stored; steps and mailboxes replace the whole list. */
export const CampaignPatchBody = z.object({
  name: requiredText(120).optional(),
  description: text(1000).optional(),
  audience: AudienceInput.nullable().optional(),
  schedule: LooseObject.optional(),
  settings: LooseObject.optional(),
  mailboxIds: z.array(uuid).max(50).optional(),
  steps: z.array(StepInput).max(50).optional(),
  ownerId: optionalUuid,
  startAt: isoDate.nullable().optional(),
});

export const CampaignListQuery = ListQuery.extend({
  status: z.enum(CAMPAIGN_STATUSES).optional(),
  q: text(200).optional(),
  ownerId: z.string().uuid().optional(),
});

export const EnrollmentListQuery = ListQuery.extend({
  status: z.enum(ENROLLMENT_STATUSES).optional(),
  q: text(200).optional(),
});

type CreateT = z.infer<typeof CampaignCreateBody>;
type PatchT = z.infer<typeof CampaignPatchBody>;

// ─── Shapes ──────────────────────────────────────────────────────────────────

export type SkipItem = { reason: string; label: string; count: number };
/** Where to fix a problem: a link inside the workspace app (prefix it with /w/:workspaceId). */
export type ProblemFix = { label: string; href: string };
export type Problem = { field: string; message: string; fix?: ProblemFix };

/** The campaign tab (or workspace page) that fixes a problem on `field`, unless the problem named its own. */
const withFix = (campaignId: string, p: Problem): Problem & { fix: ProblemFix } => {
  if (p.fix) return { ...p, fix: p.fix };
  const tab = (t: string, label: string) => ({ ...p, fix: { label, href: `/campaigns/${campaignId}?tab=${t}` } });
  const root = p.field.split(".")[0];
  if (root === "audience") return tab("audience", "Edit audience");
  if (root === "mailboxIds") return tab("mailboxes", "Choose mailboxes");
  if (root === "schedule" || root === "settings" || root === "startAt") return tab("schedule", "Edit schedule");
  return tab("steps", "Edit steps");
};

const skipList = (s: Skipped): SkipItem[] =>
  SKIP_REASONS.filter((r) => (s[r] ?? 0) > 0).map((r) => ({ reason: r, label: SKIP_LABELS[r], count: s[r]! }));

const addSkipped = (a: Skipped, b: Skipped): Skipped => {
  const out: Skipped = { ...a };
  for (const r of SKIP_REASONS) if (b[r]) out[r] = (out[r] ?? 0) + b[r]!;
  return out;
};

/** A launch that cannot go ahead: 422 with every blocking problem (and the audience breakdown) for the UI. */
const notReady = (problems: Problem[], details: Record<string, unknown>) =>
  new ApiError(422, "not_ready", problems[0]?.message ?? "The campaign is not ready to launch", Object.fromEntries(problems.map((p) => [p.field, p.message])), {
    problems,
    ...details,
  });

const OPEN_ENROLLMENT: Prisma.EnrollmentWhereInput["status"] = { in: ["active", "paused"] };
const STRUCTURE_KEYS = ["audience", "schedule", "settings", "mailboxIds", "steps", "startAt"] as const;
const EDITABLE: CampaignStatus[] = ["draft", "paused"];
const ENROLLABLE: CampaignStatus[] = ["scheduled", "running", "paused"];
const SAMPLE = 200;

const CONTACT_FOR_VARS = {
  company: { select: { name: true, domain: true } },
  owner: { select: { name: true } },
} satisfies Prisma.ContactInclude;

type CampaignWithMailboxes = Campaign & {
  mailboxes: { mailbox: { id: string; email: string; displayName: string; status: string; deletedAt: Date | null } }[];
};

/*
 * Campaigns as the workspace manages them: a campaign owns a private copy of
 * its steps (a kind="campaign" Sequence), an audience, a send window,
 * settings and the mailboxes it may send from. Launching enrolls the
 * audience and hands the enrollments to the engine (EngineService), which
 * the worker drives; pausing and stopping only change rows the engine
 * re-reads before every step.
 */
@Injectable()
export class CampaignsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rules: StepRulesService,
    private readonly enrollment: EnrollmentService,
    private readonly engine: EngineService,
    private readonly sequences: SequencesService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly activity: ActivityService,
    private readonly extras: CrmExtrasService,
  ) {}

  // ─── Reads ─────────────────────────────────────────────────────────────────

  private async find(workspaceId: string, id: string): Promise<Campaign> {
    if (!isUuid(id)) throw notFound("That campaign");
    const c = await this.prisma.db.campaign.findFirst({ where: { id, workspaceId, deletedAt: null } });
    if (!c) throw notFound("That campaign");
    return c;
  }

  private steps(workspaceId: string, sequenceId: string) {
    return this.prisma.db.sequenceStep.findMany({ where: { workspaceId, sequenceId }, orderBy: { position: "asc" } });
  }

  /** Builds list/detail DTOs for a page of campaigns with a fixed number of queries. */
  private async dtos(workspaceId: string, rows: CampaignWithMailboxes[]) {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const userIds = [...new Set(rows.flatMap((r) => [r.ownerId, r.createdById]).filter((v): v is string => Boolean(v)))];
    const viewIds = [...new Set(rows.map((r) => readAudience(r.audience)).flatMap((a) => (a?.type === "view" ? [a.viewId] : [])))];
    const [users, views, byStatus, stepCounts] = await Promise.all([
      userIds.length ? this.prisma.db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } }) : Promise.resolve([]),
      viewIds.length ? this.prisma.db.savedView.findMany({ where: { workspaceId, id: { in: viewIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
      this.prisma.db.enrollment.groupBy({ by: ["campaignId", "status"], where: { workspaceId, campaignId: { in: ids } }, _count: { _all: true } }),
      this.prisma.db.sequenceStep.groupBy({ by: ["sequenceId"], where: { workspaceId, sequenceId: { in: rows.map((r) => r.sequenceId) } }, _count: { _all: true } }),
    ]);
    const userById = new Map(users.map((u) => [u.id, u]));
    const viewName = new Map(views.map((v) => [v.id, v.name]));
    const steps = new Map(stepCounts.map((s) => [s.sequenceId, s._count._all]));
    return rows.map((c) => {
      const audience = readAudience(c.audience);
      const enrollments = Object.fromEntries(ENROLLMENT_STATUSES.map((s) => [s, 0])) as Record<(typeof ENROLLMENT_STATUSES)[number], number>;
      for (const g of byStatus) if (g.campaignId === c.id) enrollments[g.status] = g._count._all;
      return {
        id: c.id,
        name: c.name,
        description: c.description,
        status: c.status,
        sequenceId: c.sequenceId,
        audience,
        audienceDescription: describeAudience(audience, audience?.type === "view" ? (viewName.get(audience.viewId) ?? null) : null),
        schedule: readSchedule(c.schedule),
        settings: readSettings(c.settings),
        owner: c.ownerId ? (userById.get(c.ownerId) ?? null) : null,
        ownerId: c.ownerId,
        createdBy: c.createdById ? (userById.get(c.createdById) ?? null) : null,
        mailboxes: c.mailboxes
          .filter((m) => !m.mailbox.deletedAt)
          .map((m) => ({ id: m.mailbox.id, email: m.mailbox.email, displayName: m.mailbox.displayName, status: m.mailbox.status })),
        stepCount: steps.get(c.sequenceId) ?? 0,
        startAt: c.startAt,
        startedAt: c.startedAt,
        pausedAt: c.pausedAt,
        completedAt: c.completedAt,
        canceledAt: c.canceledAt,
        // Counters recounted from Enrollment/Message rows by EngineService.refreshStats (statsUpdatedAt says when).
        stats: {
          enrolled: c.enrolledCount,
          sent: c.sentCount,
          opened: c.openCount,
          clicked: c.clickCount,
          replied: c.replyCount,
          bounced: c.bounceCount,
          unsubscribed: c.unsubscribeCount,
          failed: c.failedCount,
          updatedAt: c.statsUpdatedAt,
        },
        // Live counts by enrollment status, straight from the rows.
        enrollments,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      };
    });
  }

  private loadWithMailboxes(workspaceId: string, id: string) {
    return this.prisma.db.campaign.findFirstOrThrow({
      where: { id, workspaceId },
      include: { mailboxes: { include: { mailbox: { select: { id: true, email: true, displayName: true, status: true, deletedAt: true } } } } },
    });
  }

  async list(ctx: RequestContext, q: z.infer<typeof CampaignListQuery>) {
    const w = ws(ctx);
    const where: Prisma.CampaignWhereInput = {
      workspaceId: w.id,
      deletedAt: null,
      ...(q.status ? { status: q.status } : {}),
      ...(q.ownerId ? { ownerId: q.ownerId } : {}),
      ...(q.q ? { name: { contains: q.q, mode: "insensitive" } } : {}),
    };
    const sortable: Record<string, keyof Prisma.CampaignOrderByWithRelationInput> = { name: "name", createdAt: "createdAt", updatedAt: "updatedAt", status: "status" };
    const sortKey = (q.sort && sortable[q.sort]) || "updatedAt";
    const [rows, total] = await Promise.all([
      this.prisma.db.campaign.findMany({
        where,
        include: { mailboxes: { include: { mailbox: { select: { id: true, email: true, displayName: true, status: true, deletedAt: true } } } } },
        orderBy: [{ [sortKey]: q.dir }, { id: "asc" }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      this.prisma.db.campaign.count({ where }),
    ]);
    return { items: await this.dtos(w.id, rows), total, page: q.page, pageSize: q.pageSize };
  }

  async get(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    const c = await this.find(w.id, id);
    // The cached counters are recounted from the rows before they are shown.
    await this.engine.refreshStats(w.id, c.id);
    const [row, steps] = await Promise.all([this.loadWithMailboxes(w.id, c.id), this.steps(w.id, c.sequenceId)]);
    const [dto] = await this.dtos(w.id, [row]);
    return { ...dto!, steps: steps.map(stepDto) };
  }

  // ─── Writes ────────────────────────────────────────────────────────────────

  private async checkMailboxes(workspaceId: string, ids: string[]): Promise<string[]> {
    const unique = [...new Set(ids)];
    if (!unique.length) return unique;
    const n = await this.prisma.db.mailbox.count({ where: { workspaceId, id: { in: unique }, deletedAt: null } });
    if (n !== unique.length) throw badRequest("Choose mailboxes connected to this workspace", { mailboxIds: "Unknown mailbox" });
    return unique;
  }

  private async checkOwner(workspaceId: string, ownerId: string | null | undefined) {
    if (!ownerId) return;
    const m = await this.prisma.db.membership.findFirst({ where: { workspaceId, userId: ownerId }, select: { id: true } });
    if (!m) throw badRequest("The owner must be a member of this workspace", { ownerId: "Not a member" });
  }

  private async checkAudience(ctx: RequestContext, audience: AudienceT | null | undefined) {
    if (audience?.type !== "view") return;
    try {
      await this.extras.getView(ctx, audience.viewId);
    } catch {
      throw badRequest("That saved view does not exist, or you cannot see it", { "audience.viewId": "Unknown view" });
    }
  }

  private async setMailboxes(tx: Tx, workspaceId: string, campaignId: string, mailboxIds: string[]) {
    await tx.campaignMailbox.deleteMany({ where: { workspaceId, campaignId } });
    if (mailboxIds.length) await tx.campaignMailbox.createMany({ data: mailboxIds.map((mailboxId) => ({ workspaceId, campaignId, mailboxId })) });
  }

  async create(ctx: RequestContext, input: CreateT) {
    const w = ws(ctx);
    const workspace = await this.prisma.db.workspace.findUniqueOrThrow({ where: { id: w.id }, select: { settings: true } });
    const defaults = campaignDefaults(workspace.settings);
    const schedule = mergeSchedule({ timezone: w.timezone }, defaults.schedule, input.schedule);
    const settings = mergeSettings(defaults.settings, input.settings);

    let steps: { type: string; config: unknown }[] = input.steps ?? [];
    if (!input.steps && input.fromSequenceId) {
      const source = await this.sequences.find(w.id, input.fromSequenceId);
      steps = (await this.sequences.steps(w.id, source.id)).map((s) => ({ type: s.type, config: s.config }));
    }
    if (steps.length) await this.rules.validate(w.id, w.billingAccountId, steps);
    const mailboxIds = await this.checkMailboxes(w.id, input.mailboxIds ?? []);
    await this.checkOwner(w.id, input.ownerId);
    await this.checkAudience(ctx, input.audience);

    const created = await this.prisma.db.$transaction(async (tx) => {
      const seq = await tx.sequence.create({ data: { workspaceId: w.id, name: input.name, kind: "campaign", createdById: actorId(ctx) } });
      await replaceSteps(tx, w.id, seq.id, steps);
      const c = await tx.campaign.create({
        data: {
          workspaceId: w.id,
          name: input.name,
          description: input.description ?? "",
          sequenceId: seq.id,
          audience: (input.audience ?? {}) as Prisma.InputJsonValue,
          schedule: schedule as Prisma.InputJsonValue,
          settings: settings as Prisma.InputJsonValue,
          ownerId: input.ownerId ?? actorId(ctx),
          startAt: input.startAt ?? null,
          createdById: actorId(ctx),
        },
      });
      await this.setMailboxes(tx, w.id, c.id, mailboxIds);
      return c;
    });
    await this.audit.record(ctx, {
      action: "campaign.created",
      targetType: "campaign",
      targetId: created.id,
      metadata: { name: created.name, steps: steps.length, fromSequenceId: input.steps ? null : (input.fromSequenceId ?? null) },
    });
    return this.get(ctx, created.id);
  }

  async update(ctx: RequestContext, id: string, input: PatchT) {
    const w = ws(ctx);
    const c = await this.find(w.id, id);
    const structural = STRUCTURE_KEYS.filter((k) => input[k] !== undefined);
    if (structural.length && !EDITABLE.includes(c.status)) {
      throw conflict(
        c.status === "running" || c.status === "scheduled"
          ? "Pause the campaign before changing its steps, audience, schedule, settings or mailboxes."
          : `This campaign is ${c.status}; its steps, audience, schedule, settings and mailboxes can no longer change. Duplicate it to run it again.`,
      );
    }
    if (input.steps) await this.rules.validate(w.id, w.billingAccountId, input.steps);
    const mailboxIds = input.mailboxIds ? await this.checkMailboxes(w.id, input.mailboxIds) : null;
    if (input.ownerId !== undefined) await this.checkOwner(w.id, input.ownerId);
    if (input.audience) await this.checkAudience(ctx, input.audience);
    const schedule = input.schedule ? mergeSchedule(readSchedule(c.schedule), input.schedule) : null;
    const settings = input.settings ? mergeSettings(readSettings(c.settings), input.settings) : null;

    await this.prisma.db.$transaction(async (tx) => {
      // Once anyone is enrolled their places are step numbers, so the steps keep their structure (structureChange).
      const enrolled = input.steps ? await tx.enrollment.count({ where: { workspaceId: w.id, campaignId: id } }) : 0;
      const current = enrolled ? await tx.sequenceStep.findMany({ where: { workspaceId: w.id, sequenceId: c.sequenceId }, orderBy: { position: "asc" } }) : [];
      const why = input.steps && enrolled ? structureChange(current, input.steps) : null;
      if (why) {
        const message = `${why}. ${enrolled === 1 ? "A contact is" : `${enrolled} contacts are`} enrolled and each one's place is kept by step number, so steps can't be inserted, removed, reordered or changed to another kind. You can still edit what a step sends and when, or add steps at the end; duplicate the campaign to restructure it.`;
        throw conflict(message, { steps: message });
      }
      await tx.campaign.updateMany({
        where: { id, workspaceId: w.id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.audience !== undefined ? { audience: (input.audience ?? {}) as Prisma.InputJsonValue } : {}),
          ...(schedule ? { schedule: schedule as Prisma.InputJsonValue } : {}),
          ...(settings ? { settings: settings as Prisma.InputJsonValue } : {}),
          ...(input.ownerId !== undefined ? { ownerId: input.ownerId } : {}),
          ...(input.startAt !== undefined ? { startAt: input.startAt } : {}),
          updatedAt: new Date(),
        },
      });
      if (input.name !== undefined) await tx.sequence.updateMany({ where: { id: c.sequenceId, workspaceId: w.id }, data: { name: input.name } });
      if (input.steps && enrolled) await editStepsInPlace(tx, w.id, c.sequenceId, current, input.steps);
      else if (input.steps) await replaceSteps(tx, w.id, c.sequenceId, input.steps);
      if (mailboxIds) await this.setMailboxes(tx, w.id, id, mailboxIds);
    });
    return this.get(ctx, id);
  }

  async remove(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    const c = await this.find(w.id, id);
    if (c.status === "running" || c.status === "scheduled") throw conflict("Pause or stop the campaign before deleting it.");
    await this.prisma.db.$transaction(async (tx) => {
      await tx.enrollment.updateMany({
        where: { workspaceId: w.id, campaignId: id, status: OPEN_ENROLLMENT },
        data: { status: "stopped", stopReason: "The campaign was deleted", nextRunAt: null, lockedUntil: null, stepRun: { increment: 1 } },
      });
      await tx.campaign.updateMany({ where: { id, workspaceId: w.id }, data: { deletedAt: new Date() } });
    });
    await this.audit.record(ctx, { action: "campaign.deleted", targetType: "campaign", targetId: id, metadata: { name: c.name, status: c.status } });
    return { deleted: true };
  }

  async duplicate(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    const c = await this.find(w.id, id);
    const [steps, mailboxes] = await Promise.all([
      this.steps(w.id, c.sequenceId),
      this.prisma.db.campaignMailbox.findMany({ where: { workspaceId: w.id, campaignId: id, mailbox: { deletedAt: null } }, select: { mailboxId: true } }),
    ]);
    const name = `${c.name} (copy)`.slice(0, 120);
    const copy = await this.prisma.db.$transaction(async (tx) => {
      const seq = await tx.sequence.create({ data: { workspaceId: w.id, name, kind: "campaign", createdById: actorId(ctx) } });
      await replaceSteps(tx, w.id, seq.id, steps);
      const n = await tx.campaign.create({
        data: {
          workspaceId: w.id,
          name,
          description: c.description,
          sequenceId: seq.id,
          audience: c.audience as Prisma.InputJsonValue,
          schedule: c.schedule as Prisma.InputJsonValue,
          settings: c.settings as Prisma.InputJsonValue,
          ownerId: c.ownerId,
          createdById: actorId(ctx),
        },
      });
      await this.setMailboxes(tx, w.id, n.id, mailboxes.map((m) => m.mailboxId));
      return n;
    });
    await this.audit.record(ctx, { action: "campaign.created", targetType: "campaign", targetId: copy.id, metadata: { name, duplicatedFrom: id } });
    return this.get(ctx, copy.id);
  }

  // ─── Readiness and launch ──────────────────────────────────────────────────

  /** The ids among `ids` the caller may see (contacts outside their ownership scope count as not found). */
  private async visible(ctx: RequestContext, ids: string[]): Promise<{ ids: string[]; hidden: number }> {
    const scope = ownershipScope(ctx);
    const unique = [...new Set(ids)];
    if (!Object.keys(scope).length || !unique.length) return { ids: unique, hidden: 0 };
    const rows = await this.prisma.db.contact.findMany({ where: { workspaceId: ws(ctx).id, id: { in: unique }, ...scope }, select: { id: true } });
    const seen = new Set(rows.map((r) => r.id));
    const kept = unique.filter((i) => seen.has(i));
    return { ids: kept, hidden: unique.length - kept.length };
  }

  /**
   * Everything that decides whether a draft can launch, without changing
   * anything: the step rules, plan features, mailboxes, channel connections,
   * who in the audience may be contacted, and — for a sample of them —
   * whether their messages would be missing a personalization value.
   */
  private async inspect(ctx: RequestContext, c: Campaign, steps: SequenceStep[]) {
    const w = ws(ctx);
    const problems: Problem[] = [];
    const warnings: string[] = [];

    // Steps
    const report = await this.rules.inspect(w.id, steps);
    if (!steps.length) problems.push({ field: "steps", message: "Add at least one step before launching." });
    else {
      if (report.structure) problems.push({ field: "steps", message: report.structure });
      if (!steps.some((s) => ACTION_STEPS.has(s.type))) problems.push({ field: "steps", message: "The steps never do anything: add an email, message, task or other action." });
      problems.push(...report.problems);
      if (report.unknown.length) {
        problems.push({ field: "steps", message: `Unknown personalization: ${report.unknown.map((v) => `{{${v}}}`).join(", ")}. Use a standard variable or a contact custom field.` });
      }
      if (report.features.length) {
        const ent = await this.entitlements.forAccount(w.billingAccountId);
        for (const f of report.features as FeatureKey[]) {
          if (!ent.features[f]) {
            problems.push({ field: "steps", message: `${FEATURE_LABELS[f]} is not included in the ${ent.effectivePlan.name} plan.`, fix: { label: "See plans", href: "/billing" } });
          }
        }
      }
    }

    // Mailboxes (only email steps need one)
    const hasEmail = steps.some((s) => s.type === "email");
    const selected = await this.prisma.db.campaignMailbox.findMany({
      where: { workspaceId: w.id, campaignId: c.id, mailbox: { deletedAt: null } },
      include: { mailbox: { select: { id: true, email: true, displayName: true, status: true } } },
    });
    const connected = selected.filter((m) => m.mailbox.status === "connected").map((m) => m.mailbox);
    let sender: { displayName: string; email: string } | null = connected[0] ?? null;
    if (hasEmail) {
      if (selected.length && !connected.length) {
        problems.push({ field: "mailboxIds", message: "None of the campaign's mailboxes is connected. Reconnect one or choose another." });
      } else if (!selected.length) {
        const any = await this.prisma.db.mailbox.findFirst({ where: { workspaceId: w.id, deletedAt: null, status: "connected" }, select: { displayName: true, email: true } });
        if (!any) {
          problems.push({ field: "mailboxIds", message: "Connect a mailbox before launching a campaign with email steps.", fix: { label: "Connect a mailbox", href: "/settings/mailboxes" } });
        } else {
          warnings.push("No mailbox is chosen, so emails go from whichever connected mailbox in the workspace has the most room that day.");
          sender = any;
        }
      } else if (connected.length < selected.length) {
        warnings.push(`${selected.length - connected.length} of the campaign's mailboxes ${selected.length - connected.length === 1 ? "is" : "are"} not connected; emails go from the connected ones.`);
      }
    }

    // Chat channels: a step with no connected integration is skipped (not failed) by the engine.
    for (const channel of ["whatsapp", "telegram"] as const) {
      if (!steps.some((s) => s.type === channel)) continue;
      const integration = await this.prisma.db.channelIntegration.findFirst({ where: { workspaceId: w.id, channel, deletedAt: null, status: "connected" }, select: { id: true } });
      if (!integration) warnings.push(`No ${channel === "whatsapp" ? "WhatsApp" : "Telegram"} channel is connected, so those steps will be skipped.`);
    }

    // Audience
    const audience = readAudience(c.audience);
    let candidates: string[] = [];
    let eligible: string[] = [];
    let skipped: Skipped = {};
    let viewName: string | null = null;
    if (!audience) problems.push({ field: "audience", message: "Choose who this campaign is for." });
    else {
      try {
        if (audience.type === "view") viewName = (await this.extras.getView(ctx, audience.viewId)).name;
        candidates = await this.enrollment.candidates(ctx, audience);
      } catch {
        problems.push({ field: "audience", message: "The campaign's saved view no longer exists, or you cannot see it." });
      }
      const seen = await this.visible(ctx, candidates);
      const res = await this.enrollment.eligible(w.id, seen.ids, EnrollmentService.requiresEmail(steps));
      eligible = res.eligible;
      skipped = seen.hidden ? addSkipped(res.skipped, { not_found: seen.hidden }) : res.skipped;
      if (candidates.length && audience && !eligible.length) problems.push({ field: "audience", message: "No one in the audience can be contacted." });
      else if (!candidates.length && !problems.some((p) => p.field === "audience")) problems.push({ field: "audience", message: "The audience has no contacts." });
    }

    // Personalization, sampled: a message missing a value fails that contact's enrollment at that step.
    let personalization: { sampled: number; affected: number; variables: string[] } | null = null;
    const messageSteps = steps.filter((s) => MESSAGE_STEPS.has(s.type));
    if (eligible.length && messageSteps.length && !report.structure) {
      const texts = messageSteps.map((s) => {
        const cfg = configOf(s);
        const t = cfg.templateId ? report.templates.get(cfg.templateId) : undefined;
        const body = cfg.body?.trim() ? cfg.body : (t?.body ?? "");
        const subject = s.type === "email" ? (cfg.subject?.trim() ? cfg.subject : (t?.subject ?? "")) : "";
        return { email: s.type === "email", text: `${subject}\n${body}` };
      });
      const ownerId = c.ownerId ?? c.createdById;
      const owner = ownerId ? await this.prisma.db.user.findUnique({ where: { id: ownerId }, select: { name: true, email: true } }) : null;
      const sample = await this.prisma.db.contact.findMany({ where: { workspaceId: w.id, id: { in: eligible.slice(0, SAMPLE) } }, include: CONTACT_FOR_VARS });
      const missingNames = new Set<string>();
      let affected = 0;
      for (const contact of sample) {
        const emailVars = variablesFor(contact, { senderName: sender?.displayName ?? "", senderEmail: sender?.email ?? "", unsubscribeUrl: "-" });
        const chatVars = variablesFor(contact, { senderName: owner?.name ?? "", senderEmail: owner?.email ?? "" });
        const miss = texts.flatMap((t) => missingVariables(t.text, t.email ? emailVars : chatVars));
        if (miss.length) {
          affected += 1;
          for (const m of miss) missingNames.add(m);
        }
      }
      personalization = { sampled: sample.length, affected, variables: [...missingNames] };
      if (affected) {
        warnings.push(
          `${affected} of ${sample.length} contacts checked have no value for ${[...missingNames].map((v) => `{{${v}}}`).join(", ")}; their enrollment fails at that step. Add a fallback like {{first_name|there}} to avoid it.`,
        );
      }
    }

    return {
      problems: problems.map((p) => withFix(c.id, p)),
      warnings,
      candidates,
      eligible,
      skipped,
      audienceDescription: describeAudience(audience, viewName),
      mailboxes: { selected: selected.length, connected: connected.length },
      personalization,
    };
  }

  async readiness(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    const c = await this.find(w.id, id);
    const r = await this.inspect(ctx, c, await this.steps(w.id, c.sequenceId));
    return {
      ready: r.problems.length === 0,
      problems: r.problems,
      warnings: r.warnings,
      audience: { description: r.audienceDescription, candidates: r.candidates.length, eligible: r.eligible.length, skipped: skipList(r.skipped) },
      mailboxes: r.mailboxes,
      personalization: r.personalization,
    };
  }

  async launch(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    const c = await this.find(w.id, id);
    if (c.status !== "draft") throw conflict(`This campaign is ${c.status}; only a draft can be launched.${c.status === "paused" ? " Resume it instead." : ""}`);
    await this.entitlements.assertFullAccess(w.billingAccountId, "Launching a campaign");
    const steps = await this.steps(w.id, c.sequenceId);
    const r = await this.inspect(ctx, c, steps);
    if (r.problems.length) throw notReady(r.problems, { skipped: skipList(r.skipped), eligible: r.eligible.length });
    // 402s for step kinds the plan lacks, with the upgrade details.
    await this.rules.validate(w.id, w.billingAccountId, steps);
    await this.entitlements.assertCapacity(w.billingAccountId, "activeCampaigns", 1);

    // Enroll while still a draft (the engine ignores drafts), then flip the status, so a tick can
    // never find the campaign running with nobody enrolled and close it.
    const result = await this.enrollment.enroll(w.id, c, r.eligible, { source: "manual", enrolledById: actorId(ctx) });
    const now = new Date();
    const future = c.startAt !== null && c.startAt.getTime() > now.getTime();
    const res = await this.prisma.db.campaign.updateMany({
      where: { id, workspaceId: w.id, status: "draft", deletedAt: null },
      data: future ? { status: "scheduled", pausedAt: null } : { status: "running", startedAt: now, pausedAt: null },
    });
    if (!res.count) throw conflict("The campaign changed while it was being launched. Reload it and try again.");
    const skipped = skipList(addSkipped(r.skipped, result.skipped));
    await this.audit.record(ctx, {
      action: "campaign.launched",
      targetType: "campaign",
      targetId: id,
      metadata: { name: c.name, enrolled: result.enrolled, skipped: Object.fromEntries(skipped.map((s) => [s.reason, s.count])), scheduledFor: future ? c.startAt : null },
    });
    return { campaign: await this.get(ctx, id), enrolled: result.enrolled, skipped, warnings: r.warnings };
  }

  // ─── Status transitions ────────────────────────────────────────────────────

  async pause(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    const c = await this.find(w.id, id);
    const res = await this.prisma.db.campaign.updateMany({
      where: { id, workspaceId: w.id, deletedAt: null, status: { in: ["running", "scheduled"] } },
      data: { status: "paused", pausedAt: new Date() },
    });
    if (!res.count) throw conflict(`This campaign is ${c.status}; only a running or scheduled campaign can be paused.`);
    await this.audit.record(ctx, { action: "campaign.paused", targetType: "campaign", targetId: id, metadata: { name: c.name } });
    return this.get(ctx, id);
  }

  async resume(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    const c = await this.find(w.id, id);
    if (c.status !== "paused") throw conflict(`This campaign is ${c.status}; only a paused campaign can be resumed.`);
    await this.entitlements.assertFullAccess(w.billingAccountId, "Resuming a campaign");
    await this.entitlements.assertCapacity(w.billingAccountId, "activeCampaigns", 1);
    const now = new Date();
    const future = !c.startedAt && c.startAt !== null && c.startAt.getTime() > now.getTime();
    // While still paused (the engine leaves it alone): starts that fell due during the pause are spread
    // over the coming days under the daily limit instead of all going out at once.
    await this.enrollment.replanWaiting(w.id, c, now);
    const res = await this.prisma.db.campaign.updateMany({
      where: { id, workspaceId: w.id, deletedAt: null, status: "paused" },
      data: future ? { status: "scheduled", pausedAt: null } : { status: "running", pausedAt: null, startedAt: c.startedAt ?? now },
    });
    if (!res.count) throw conflict("The campaign changed while it was being resumed. Reload it and try again.");
    await this.audit.record(ctx, { action: "campaign.resumed", targetType: "campaign", targetId: id, metadata: { name: c.name } });
    return this.get(ctx, id);
  }

  async stop(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    const c = await this.find(w.id, id);
    if (c.status === "draft") throw conflict("A draft has not started, so there is nothing to stop. Delete it instead.");
    if (c.status === "completed" || c.status === "canceled") throw conflict(`This campaign is already ${c.status}.`);
    const stopped = await this.prisma.db.$transaction(async (tx) => {
      const res = await tx.campaign.updateMany({
        where: { id, workspaceId: w.id, deletedAt: null, status: { in: ["scheduled", "running", "paused"] } },
        data: { status: "canceled", canceledAt: new Date() },
      });
      if (!res.count) return null;
      const e = await tx.enrollment.updateMany({
        where: { workspaceId: w.id, campaignId: id, status: OPEN_ENROLLMENT },
        data: { status: "stopped", stopReason: "The campaign was stopped", nextRunAt: null, lockedUntil: null, stepRun: { increment: 1 } },
      });
      return e.count;
    });
    if (stopped === null) throw conflict("The campaign changed while it was being stopped. Reload it and try again.");
    await this.audit.record(ctx, { action: "campaign.stopped", targetType: "campaign", targetId: id, metadata: { name: c.name, enrollmentsStopped: stopped } });
    return this.get(ctx, id);
  }

  // ─── Enrollments ───────────────────────────────────────────────────────────

  async enroll(ctx: RequestContext, id: string, contactIds: string[]) {
    const w = ws(ctx);
    const c = await this.find(w.id, id);
    if (!ENROLLABLE.includes(c.status)) {
      throw conflict(
        c.status === "draft"
          ? "This campaign has not been launched. Add the contacts to its audience, or launch it first."
          : `This campaign is ${c.status} and no longer takes new contacts. Duplicate it to run it again.`,
      );
    }
    await this.entitlements.assertFullAccess(w.billingAccountId, "Enrolling contacts");
    const seen = await this.visible(ctx, contactIds);
    const result = await this.enrollment.enroll(w.id, c, seen.ids, { source: ctx.apiKey ? "api" : "manual", enrolledById: actorId(ctx) });
    const skipped = seen.hidden ? addSkipped(result.skipped, { not_found: seen.hidden }) : result.skipped;
    return { enrolled: result.enrolled, skipped: skipList(skipped) };
  }

  private enrollmentDto(
    e: Enrollment & { contact: { id: string; fullName: string; email: string | null; deletedAt: Date | null; company: { name: string } | null } },
    steps: SequenceStep[],
    mailboxes: Map<string, string>,
  ) {
    const step = steps[e.position];
    const open = e.status === "active" || e.status === "paused";
    return {
      id: e.id,
      status: e.status,
      contact: { id: e.contact.id, fullName: e.contact.fullName, email: e.contact.email, company: e.contact.company?.name ?? null, deleted: Boolean(e.contact.deletedAt) },
      position: e.position,
      // Where an open enrollment stands (the step it runs next); a finished one shows where it ended.
      step: step ? { position: e.position, type: step.type } : null,
      nextRunAt: open ? e.nextRunAt : null,
      lastError: e.lastError,
      stopReason: e.stopReason,
      errorCount: e.errorCount,
      repliedAt: e.repliedAt,
      enrolledAt: e.enrolledAt,
      completedAt: e.completedAt,
      source: e.source,
      mailbox: e.mailboxId ? { id: e.mailboxId, email: mailboxes.get(e.mailboxId) ?? null } : null,
      updatedAt: e.updatedAt,
    };
  }

  async enrollments(ctx: RequestContext, id: string, q: z.infer<typeof EnrollmentListQuery>) {
    const w = ws(ctx);
    const c = await this.find(w.id, id);
    const where: Prisma.EnrollmentWhereInput = {
      workspaceId: w.id,
      campaignId: id,
      ...(q.status ? { status: q.status } : {}),
      ...(q.q ? { contact: { OR: [{ fullName: { contains: q.q, mode: "insensitive" } }, { email: { contains: q.q, mode: "insensitive" } }] } } : {}),
    };
    const sortable: Record<string, keyof Prisma.EnrollmentOrderByWithRelationInput> = { enrolledAt: "enrolledAt", nextRunAt: "nextRunAt", updatedAt: "updatedAt", status: "status" };
    const sortKey = (q.sort && sortable[q.sort]) || "enrolledAt";
    const [rows, total, steps] = await Promise.all([
      this.prisma.db.enrollment.findMany({
        where,
        include: { contact: { select: { id: true, fullName: true, email: true, deletedAt: true, company: { select: { name: true } } } } },
        orderBy: [sortKey === "nextRunAt" ? { nextRunAt: { sort: q.dir, nulls: "last" } } : { [sortKey]: q.dir }, { id: "asc" }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      this.prisma.db.enrollment.count({ where }),
      this.steps(w.id, c.sequenceId),
    ]);
    const mailboxIds = [...new Set(rows.map((r) => r.mailboxId).filter((v): v is string => Boolean(v)))];
    const boxes = mailboxIds.length ? await this.prisma.db.mailbox.findMany({ where: { workspaceId: w.id, id: { in: mailboxIds } }, select: { id: true, email: true } }) : [];
    const byId = new Map(boxes.map((b) => [b.id, b.email]));
    return { items: rows.map((r) => this.enrollmentDto(r, steps, byId)), total, page: q.page, pageSize: q.pageSize };
  }

  async stopEnrollment(ctx: RequestContext, id: string, enrollmentId: string) {
    const w = ws(ctx);
    const c = await this.find(w.id, id);
    if (!isUuid(enrollmentId)) throw notFound("That enrollment");
    const e = await this.prisma.db.enrollment.findFirst({ where: { id: enrollmentId, workspaceId: w.id, campaignId: id } });
    if (!e) throw notFound("That enrollment");
    const who = ctx.identity?.name ? `Stopped by ${ctx.identity.name}` : "Stopped manually";
    const res = await this.prisma.db.enrollment.updateMany({
      where: { id: enrollmentId, workspaceId: w.id, campaignId: id, status: OPEN_ENROLLMENT },
      data: { status: "stopped", stopReason: who.slice(0, 500), nextRunAt: null, lockedUntil: null, stepRun: { increment: 1 } },
    });
    if (!res.count) throw conflict(`This enrollment is already ${e.status}.`);
    await this.activity.log({ workspaceId: w.id, contactId: e.contactId, actorId: actorId(ctx), type: "campaign.stopped", summary: `${who} in “${c.name}”`, data: { campaignId: id, enrollmentId } });
    const row = await this.prisma.db.enrollment.findFirstOrThrow({
      where: { id: enrollmentId, workspaceId: w.id },
      include: { contact: { select: { id: true, fullName: true, email: true, deletedAt: true, company: { select: { name: true } } } } },
    });
    const steps = await this.steps(w.id, c.sequenceId);
    const box = row.mailboxId ? await this.prisma.db.mailbox.findFirst({ where: { id: row.mailboxId, workspaceId: w.id }, select: { id: true, email: true } }) : null;
    return this.enrollmentDto(row, steps, new Map(box ? [[box.id, box.email]] : []));
  }

  // ─── Per-step numbers ──────────────────────────────────────────────────────

  /** Per-step counts, all from StepExecution, Message and Enrollment rows. */
  async stepStats(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    const c = await this.find(w.id, id);
    const [steps, execs, waiting, messages] = await Promise.all([
      this.steps(w.id, c.sequenceId),
      this.prisma.db.stepExecution.groupBy({ by: ["position", "status"], where: { workspaceId: w.id, campaignId: id }, _count: { _all: true } }),
      this.prisma.db.enrollment.groupBy({ by: ["position"], where: { workspaceId: w.id, campaignId: id, status: "active" }, _count: { _all: true } }),
      this.prisma.db.$queryRaw<{ position: number; sent: number; opened: number; clicked: number; bounced: number }[]>`
        SELECT se.position,
               count(*) FILTER (WHERE m."sentAt" IS NOT NULL)::int AS sent,
               count(*) FILTER (WHERE m."openedAt" IS NOT NULL)::int AS opened,
               count(*) FILTER (WHERE m."clickedAt" IS NOT NULL)::int AS clicked,
               count(*) FILTER (WHERE m."bouncedAt" IS NOT NULL OR m.status = 'bounced')::int AS bounced
        FROM "StepExecution" se
        JOIN "Message" m ON m.id = se."messageId" AND m."workspaceId" = se."workspaceId"
        WHERE se."workspaceId" = ${w.id}::uuid AND se."campaignId" = ${id}::uuid
        GROUP BY se.position`,
    ]);
    return steps.map((s) => {
      const executions = { succeeded: 0, failed: 0, skipped: 0, uncertain: 0, running: 0 };
      for (const g of execs) if (g.position === s.position) executions[g.status] = g._count._all;
      const m = messages.find((x) => x.position === s.position);
      return {
        position: s.position,
        type: s.type,
        executions,
        waiting: waiting.find((x) => x.position === s.position)?._count._all ?? 0,
        messages: MESSAGE_STEPS.has(s.type) ? { sent: m?.sent ?? 0, opened: m?.opened ?? 0, clicked: m?.clicked ?? 0, bounced: m?.bounced ?? 0 } : null,
      };
    });
  }
}
