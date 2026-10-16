import { Injectable } from "@nestjs/common";
import { AiAgentInput, agentTokenTrouble, normalizePhone, type AiAgentInputT, type AiAgentListQuery } from "@growthdesk/shared";
import type { z } from "zod";
import type { CallAgent, Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { AuditService } from "../core/audit.service.js";
import { EntitlementsService } from "../billing/entitlements.service.js";
import { badRequest, conflict, notFound } from "../common/errors.js";
import { actorId, ws, type RequestContext } from "../common/context.js";
import { agentObjections, agentQuestions, agentTexts, providerTexts } from "./ai-calling-rules.js";
import { AiCallsService } from "./ai-calls.service.js";

/*
 * AI agents: the script, voice and rules an AI call speaks with. Every save
 * is pushed to Cartesia straight away (AiCallsService.syncAgent); when that
 * fails (not connected, a voice Cartesia does not know) the agent is still
 * saved and its card says why, and it is pushed again before its next call.
 *
 * An agent is archived rather than deleted, so its calls keep their history;
 * one still used by a live campaign step cannot be archived.
 */

type ListQ = z.infer<typeof AiAgentListQuery>;
const LIVE_CAMPAIGN = ["draft", "scheduled", "running", "paused"] as const;

@Injectable()
export class AiAgentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementsService,
    private readonly calls: AiCallsService,
  ) {}

  dto(a: CallAgent) {
    return {
      id: a.id,
      name: a.name,
      templateKey: a.templateKey,
      goal: a.goal,
      language: a.language,
      voiceId: a.voiceId,
      voiceName: a.voiceName,
      personaName: a.personaName,
      businessName: a.businessName,
      greeting: a.greeting,
      disclosure: a.disclosure,
      about: a.about,
      goalDetails: a.goalDetails,
      questions: agentQuestions(a),
      objections: agentObjections(a),
      voicemailMessage: a.voicemailMessage,
      extraInstructions: a.extraInstructions,
      transferNumber: a.transferNumber,
      maxCallMinutes: a.maxCallMinutes,
      sync: {
        saved: Boolean(a.providerAgentId && a.syncedAt && !a.syncError),
        syncedAt: a.syncedAt,
        error: a.syncError,
      },
      archivedAt: a.archivedAt,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
    };
  }

  /** Calls per agent: total, conversations, meetings agreed, and the last one. */
  private async stats(workspaceId: string, ids: string[]) {
    if (!ids.length)
      return new Map<
        string,
        {
          calls: number;
          connected: number;
          meetings: number;
          lastCallAt: Date | null;
        }
      >();
    const rows = await this.prisma.db.call.groupBy({
      by: ["agentId", "outcome"],
      where: { workspaceId, agentId: { in: ids } },
      _count: { _all: true },
      _max: { createdAt: true },
    });
    const out = new Map<
      string,
      {
        calls: number;
        connected: number;
        meetings: number;
        lastCallAt: Date | null;
      }
    >();
    for (const r of rows) {
      if (!r.agentId) continue;
      const s = out.get(r.agentId) ?? {
        calls: 0,
        connected: 0,
        meetings: 0,
        lastCallAt: null,
      };
      s.calls += r._count._all;
      if (["connected", "meeting_booked", "callback_requested", "not_interested", "do_not_call"].includes(r.outcome)) s.connected += r._count._all;
      if (r.outcome === "meeting_booked") s.meetings += r._count._all;
      if (r._max.createdAt && (!s.lastCallAt || r._max.createdAt > s.lastCallAt)) s.lastCallAt = r._max.createdAt;
      out.set(r.agentId, s);
    }
    return out;
  }

  async list(ctx: RequestContext, q: ListQ) {
    const w = ws(ctx);
    const where: Prisma.CallAgentWhereInput = { workspaceId: w.id };
    if (q.archived === "exclude") where.archivedAt = null;
    if (q.archived === "only") where.archivedAt = { not: null };
    const rows = await this.prisma.db.callAgent.findMany({
      where,
      orderBy: [{ archivedAt: { sort: "asc", nulls: "first" } }, { updatedAt: "desc" }],
    });
    const stats = await this.stats(
      w.id,
      rows.map((r) => r.id),
    );
    return rows.map((r) => ({
      ...this.dto(r),
      stats: stats.get(r.id) ?? {
        calls: 0,
        connected: 0,
        meetings: 0,
        lastCallAt: null,
      },
    }));
  }

  private async find(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    const row = await this.prisma.db.callAgent.findFirst({
      where: { id, workspaceId: w.id },
    });
    if (!row) throw notFound("That AI agent");
    return row;
  }

  /** Campaigns and library sequences whose steps call with this agent. */
  private async usage(workspaceId: string, agentId: string) {
    const steps = await this.prisma.db.sequenceStep.findMany({
      where: {
        workspaceId,
        type: "ai_call",
        config: { path: ["agentId"], equals: agentId },
      },
      select: { sequenceId: true },
    });
    const sequenceIds = [...new Set(steps.map((s) => s.sequenceId))];
    if (!sequenceIds.length) return { campaigns: [], sequences: [] };
    const [campaigns, sequences] = await Promise.all([
      this.prisma.db.campaign.findMany({
        where: {
          workspaceId,
          sequenceId: { in: sequenceIds },
          deletedAt: null,
        },
        select: { id: true, name: true, status: true },
      }),
      this.prisma.db.sequence.findMany({
        where: { workspaceId, id: { in: sequenceIds }, kind: "library" },
        select: { id: true, name: true },
      }),
    ]);
    return { campaigns, sequences };
  }

  async get(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    const row = await this.find(ctx, id);
    const [stats, usage] = await Promise.all([this.stats(w.id, [row.id]), this.usage(w.id, row.id)]);
    return {
      ...this.dto(row),
      stats: stats.get(row.id) ?? {
        calls: 0,
        connected: 0,
        meetings: 0,
        lastCallAt: null,
      },
      /** The exact prompt and opening line the voice agent runs on. */
      preview: providerTexts(row),
      usage,
    };
  }

  /** Field-level checks beyond the schema: variables in every text, and the transfer number. */
  private async check(workspaceId: string, input: AiAgentInputT) {
    const customKeys = (
      await this.prisma.db.customFieldDefinition.findMany({
        where: { workspaceId, entity: "contact" },
        select: { key: true },
      })
    ).map((d) => d.key);
    const fields: Record<string, string> = {};
    const say = (key: string, text: string) => {
      const trouble = agentTokenTrouble(text, customKeys);
      if (trouble) fields[key] ??= trouble;
    };
    for (const key of ["greeting", "disclosure", "about", "goalDetails", "voicemailMessage", "extraInstructions"] as const) say(key, input[key]);
    input.questions.forEach((q, i) => say(`questions.${i}`, q));
    input.objections.forEach((o, i) => {
      say(`objections.${i}.objection`, o.objection);
      say(`objections.${i}.response`, o.response);
    });
    if (agentTexts(input).join("\n").length > 30_000) fields.about ??= "The script is too long for a phone agent; keep it under 30,000 characters.";
    const first = Object.entries(fields)[0];
    if (first) throw badRequest(first[1], fields);
  }

  private data(input: AiAgentInputT) {
    return {
      name: input.name,
      templateKey: input.templateKey ?? "",
      goal: input.goal,
      language: input.language,
      voiceId: input.voiceId,
      voiceName: input.voiceName ?? "",
      personaName: input.personaName,
      businessName: input.businessName,
      greeting: input.greeting,
      disclosure: input.disclosure,
      about: input.about,
      goalDetails: input.goalDetails,
      questions: input.questions as Prisma.InputJsonValue,
      objections: input.objections as Prisma.InputJsonValue,
      voicemailMessage: input.voicemailMessage,
      extraInstructions: input.extraInstructions,
      transferNumber: normalizePhone(input.transferNumber) ?? "",
      maxCallMinutes: input.maxCallMinutes,
    };
  }

  async create(ctx: RequestContext, input: AiAgentInputT) {
    const w = ws(ctx);
    await this.entitlements.assertFeature(w.billingAccountId, "calling");
    await this.check(w.id, input);
    const row = await this.prisma.db.callAgent.create({
      data: {
        workspaceId: w.id,
        ...this.data(input),
        createdById: actorId(ctx),
      },
    });
    const synced = await this.calls.syncAgent(w.id, row);
    await this.audit.record(ctx, {
      action: "call_agent.created",
      targetType: "call_agent",
      targetId: row.id,
      metadata: { name: row.name, templateKey: row.templateKey },
    });
    return this.get(ctx, synced.id);
  }

  async update(ctx: RequestContext, id: string, patch: Partial<AiAgentInputT>) {
    const w = ws(ctx);
    const row = await this.find(ctx, id);
    if (row.archivedAt) throw conflict("This agent is archived. Restore it to edit it.");
    const current = {
      ...this.dto(row),
      templateKey: row.templateKey,
      transferNumber: row.transferNumber,
    };
    const merged = AiAgentInput.safeParse({ ...current, ...patch });
    if (!merged.success) {
      const fields = Object.fromEntries(merged.error.issues.map((i) => [i.path.join("."), i.message]));
      throw badRequest(merged.error.issues[0]?.message ?? "Invalid agent", fields);
    }
    await this.check(w.id, merged.data);
    const saved = await this.prisma.db.callAgent.update({
      where: { id, workspaceId: w.id },
      data: this.data(merged.data),
    });
    await this.calls.syncAgent(w.id, saved);
    await this.audit.record(ctx, {
      action: "call_agent.updated",
      targetType: "call_agent",
      targetId: id,
      metadata: { fields: Object.keys(patch) },
    });
    return this.get(ctx, id);
  }

  /** Pushes the agent to Cartesia again (after connecting, or fixing what made a save fail). */
  async sync(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    const row = await this.find(ctx, id);
    await this.calls.syncAgent(w.id, row);
    return this.get(ctx, id);
  }

  async duplicate(ctx: RequestContext, id: string) {
    const row = await this.find(ctx, id);
    const input = AiAgentInput.parse({
      ...this.dto(row),
      name: `${row.name} (copy)`.slice(0, 80),
      templateKey: row.templateKey,
      transferNumber: row.transferNumber,
    });
    return this.create(ctx, input);
  }

  async archive(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    const row = await this.find(ctx, id);
    if (row.archivedAt) return this.get(ctx, id);
    const usage = await this.usage(w.id, id);
    const live = usage.campaigns.filter((c) => (LIVE_CAMPAIGN as readonly string[]).includes(c.status));
    if (live.length) {
      throw conflict(`This agent is used by ${live.length === 1 ? `the campaign “${live[0]!.name}”` : `${live.length} campaigns`}. Change their AI call steps to another agent first.`, undefined, {
        campaigns: live,
      });
    }
    await this.prisma.db.callAgent.update({
      where: { id, workspaceId: w.id },
      data: { archivedAt: new Date() },
    });
    await this.calls.removeAgent(w.id, row);
    await this.prisma.db.callAgent.update({
      where: { id, workspaceId: w.id },
      data: { providerAgentId: null, syncedAt: null },
    });
    await this.audit.record(ctx, {
      action: "call_agent.archived",
      targetType: "call_agent",
      targetId: id,
      metadata: { name: row.name },
    });
    return this.get(ctx, id);
  }

  async restore(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    const row = await this.find(ctx, id);
    if (!row.archivedAt) return this.get(ctx, id);
    const restored = await this.prisma.db.callAgent.update({
      where: { id, workspaceId: w.id },
      data: { archivedAt: null },
    });
    await this.calls.syncAgent(w.id, restored);
    await this.audit.record(ctx, {
      action: "call_agent.restored",
      targetType: "call_agent",
      targetId: id,
      metadata: { name: row.name },
    });
    return this.get(ctx, id);
  }
}
