import { Injectable } from "@nestjs/common";
import type { z } from "zod";
import {
  DEFAULT_DISCORD_TEMPLATE,
  DiscordConditionInput,
  evaluateDiscordConditions,
  describeDiscordCondition,
  renderDiscordMessage,
  validateDiscordTemplate,
  type DiscordRuleInput,
  type DiscordRuleTestInput,
  type DiscordSettingsInput,
  type DiscordTemplateInput,
} from "@growthdesk/shared";
import { PrismaService } from "../prisma/prisma.service.js";
import type { DiscordRule, DiscordTemplate } from "../generated/prisma/client.js";
import { AuditService } from "../core/audit.service.js";
import { actorId, ws, type RequestContext } from "../common/context.js";
import { badRequest, conflict, notFound } from "../common/errors.js";
import { DiscordContextService } from "./discord-context.service.js";
import { DiscordDeliveryService, deliveryDto, templateBodyOf } from "./discord-delivery.service.js";

const MAX_RULES = 100;
const MAX_TEMPLATES = 100;

const ruleDto = (r: DiscordRule & { template?: { name: string } | null }) => ({
  id: r.id,
  name: r.name,
  events: r.events,
  destinationIds: r.destinationIds,
  templateId: r.templateId,
  templateName: r.template?.name ?? null,
  conditions: DiscordConditionInput.array().catch([]).parse(r.conditions),
  enabled: r.enabled,
  lastMatchedAt: r.lastMatchedAt,
  lastTestedAt: r.lastTestedAt,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

const templateDto = (t: DiscordTemplate & { _count?: { rules: number } }) => ({
  id: t.id,
  name: t.name,
  description: t.description,
  body: templateBodyOf(t.body),
  ruleCount: t._count?.rules ?? 0,
  createdAt: t.createdAt,
  updatedAt: t.updatedAt,
});

/*
 * The routing configuration, all of it rows in the database: rules (event
 * types → channels, with conditions and a template), templates, and what to
 * do with events no rule takes. Changing any of it needs no deployment; the
 * dispatcher reads enabled rules for every batch of events.
 *
 * Every id a request names (destination, template, event type) is checked
 * against this workspace before it is stored, so a rule can only ever post to
 * channels of servers this workspace connected.
 */
@Injectable()
export class DiscordRoutingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly context: DiscordContextService,
    private readonly delivery: DiscordDeliveryService,
  ) {}

  // ─── Events and fields ────────────────────────────────────────────────────

  events(ctx: RequestContext) {
    return this.context.catalog(ws(ctx).id);
  }

  fields(ctx: RequestContext, types: string[]) {
    return this.context.fields(ws(ctx).id, types);
  }

  /** The context a preview renders against: a real recent event of the type, else a sample built from real records. */
  async sampleContext(ctx: RequestContext, type: string, eventId?: string) {
    const w = ws(ctx).id;
    const event = eventId
      ? await this.prisma.db.domainEvent.findFirst({ where: { id: eventId, workspaceId: w, type } })
      : await this.prisma.db.domainEvent.findFirst({ where: { workspaceId: w, type }, orderBy: { occurredAt: "desc" } });
    if (eventId && !event) throw notFound("That event");
    return { source: event ? ("event" as const) : ("sample" as const), eventId: event?.id ?? null, context: event ? await this.context.build(w, event) : await this.context.sample(w, type) };
  }

  /** Recent events of a type, to pick one to test against. */
  async recentEvents(ctx: RequestContext, type: string) {
    const rows = await this.prisma.db.domainEvent.findMany({ where: { workspaceId: ws(ctx).id, type }, orderBy: { occurredAt: "desc" }, take: 20, select: { id: true, type: true, subjectType: true, subjectId: true, occurredAt: true } });
    return rows;
  }

  // ─── Rules ────────────────────────────────────────────────────────────────

  async rules(ctx: RequestContext) {
    const rows = await this.prisma.db.discordRule.findMany({ where: { workspaceId: ws(ctx).id }, include: { template: { select: { name: true } } }, orderBy: { createdAt: "asc" } });
    return rows.map(ruleDto);
  }

  private async checkRule(workspaceId: string, input: z.infer<typeof DiscordRuleInput>) {
    const known = await this.context.knownTypes(workspaceId);
    const unknown = input.events.filter((e) => !known.has(e));
    if (unknown.length) throw badRequest(`Unknown event: ${unknown.join(", ")}`, { events: `Unknown event: ${unknown.join(", ")}` });
    const ids = [...new Set(input.destinationIds)];
    const found = await this.prisma.db.discordDestination.findMany({ where: { workspaceId, id: { in: ids } }, select: { id: true } });
    if (found.length !== ids.length) throw badRequest("A chosen channel is not one of this workspace's destinations", { destinationIds: "Choose channels from this workspace's destinations" });
    if (input.templateId && !(await this.prisma.db.discordTemplate.findFirst({ where: { id: input.templateId, workspaceId }, select: { id: true } }))) {
      throw badRequest("That template does not exist", { templateId: "Choose one of this workspace's templates" });
    }
    return { ...input, events: [...new Set(input.events)], destinationIds: ids };
  }

  async createRule(ctx: RequestContext, raw: z.infer<typeof DiscordRuleInput>) {
    const w = ws(ctx).id;
    if ((await this.prisma.db.discordRule.count({ where: { workspaceId: w } })) >= MAX_RULES) throw conflict(`A workspace can have up to ${MAX_RULES} Discord rules.`);
    const input = await this.checkRule(w, raw);
    const row = await this.prisma.db.discordRule.create({
      data: { workspaceId: w, name: input.name, events: input.events, destinationIds: input.destinationIds, templateId: input.templateId, conditions: input.conditions as never, enabled: input.enabled, createdById: actorId(ctx) },
      include: { template: { select: { name: true } } },
    });
    await this.audit.record(ctx, { action: "discord.rule_created", targetType: "discord_rule", targetId: row.id, metadata: { name: row.name, events: row.events, destinations: row.destinationIds.length, enabled: row.enabled } });
    return ruleDto(row);
  }

  async updateRule(ctx: RequestContext, id: string, raw: z.infer<typeof DiscordRuleInput>) {
    const w = ws(ctx).id;
    const existing = await this.prisma.db.discordRule.findFirst({ where: { id, workspaceId: w } });
    if (!existing) throw notFound("That rule");
    const input = await this.checkRule(w, raw);
    const row = await this.prisma.db.discordRule.update({
      where: { id, workspaceId: w },
      data: { name: input.name, events: input.events, destinationIds: input.destinationIds, templateId: input.templateId, conditions: input.conditions as never, enabled: input.enabled },
      include: { template: { select: { name: true } } },
    });
    await this.audit.record(ctx, { action: "discord.rule_updated", targetType: "discord_rule", targetId: id, metadata: { name: row.name, events: row.events, destinations: row.destinationIds.length, enabled: row.enabled } });
    return ruleDto(row);
  }

  async setRuleEnabled(ctx: RequestContext, id: string, enabled: boolean) {
    const w = ws(ctx).id;
    const existing = await this.prisma.db.discordRule.findFirst({ where: { id, workspaceId: w } });
    if (!existing) throw notFound("That rule");
    const row = await this.prisma.db.discordRule.update({ where: { id, workspaceId: w }, data: { enabled }, include: { template: { select: { name: true } } } });
    await this.audit.record(ctx, { action: enabled ? "discord.rule_enabled" : "discord.rule_disabled", targetType: "discord_rule", targetId: id, metadata: { name: row.name } });
    return ruleDto(row);
  }

  async deleteRule(ctx: RequestContext, id: string) {
    const w = ws(ctx).id;
    const existing = await this.prisma.db.discordRule.findFirst({ where: { id, workspaceId: w } });
    if (!existing) throw notFound("That rule");
    // Its deliveries stay in the log (ruleId becomes null); pending ones are canceled rather than posted.
    await this.prisma.db.discordDelivery.updateMany({ where: { workspaceId: w, ruleId: id, status: "pending" }, data: { status: "canceled", error: "The rule was deleted before this was posted.", errorCode: "rule_off", nextAttemptAt: null } });
    await this.prisma.db.discordRule.delete({ where: { id, workspaceId: w } });
    await this.audit.record(ctx, { action: "discord.rule_deleted", targetType: "discord_rule", targetId: id, metadata: { name: existing.name } });
  }

  /**
   * A trial run: evaluates the conditions and renders the template against a
   * real event (the one named, else the latest of that type) or a sample,
   * and — when channels are given — posts the result there, marked as a
   * test. Works for saved rules and for the unsaved form alike.
   */
  async test(ctx: RequestContext, input: z.infer<typeof DiscordRuleTestInput>, ruleId?: string) {
    const w = ws(ctx).id;
    if (ruleId && !(await this.prisma.db.discordRule.findFirst({ where: { id: ruleId, workspaceId: w }, select: { id: true } }))) throw notFound("That rule");
    const sample = await this.sampleContext(ctx, input.eventType, input.eventId);
    const conditions = evaluateDiscordConditions(input.conditions, sample.context);
    let body = DEFAULT_DISCORD_TEMPLATE;
    if (input.template) body = input.template;
    else if (input.templateId) {
      const t = await this.prisma.db.discordTemplate.findFirst({ where: { id: input.templateId, workspaceId: w } });
      if (!t) throw notFound("That template");
      body = templateBodyOf(t.body);
    }
    const rendered = renderDiscordMessage(body, sample.context);
    const issues = validateDiscordTemplate(body, (await this.context.fields(w, [input.eventType])).map((f) => f.path));

    const deliveries = [];
    if (input.destinationIds.length) {
      if (rendered.skip) throw badRequest(`Nothing to post: ${rendered.skip}`);
      const ids = [...new Set(input.destinationIds)];
      const dests = await this.prisma.db.discordDestination.findMany({ where: { workspaceId: w, id: { in: ids } } });
      if (dests.length !== ids.length) throw badRequest("A chosen channel is not one of this workspace's destinations", { destinationIds: "Choose channels from this workspace's destinations" });
      const message = { ...rendered.message, content: `**[Test]** ${rendered.message.content}`.trim() };
      for (const dest of dests) {
        const row = await this.prisma.db.discordDelivery.create({
          data: { workspaceId: w, destinationId: dest.id, eventId: sample.eventId, eventType: input.eventType, test: true, status: "pending", message: message as never, channelName: dest.name },
        });
        // A test answers now: one attempt, in this request. Should Discord ask to wait, the queue takes over.
        const outcome = await this.delivery.attempt(w, row.id);
        if (outcome.retryInMs) await this.delivery.enqueue(w, row.id, outcome.retryInMs);
        const fresh = await this.prisma.db.discordDelivery.findFirstOrThrow({ where: { id: row.id, workspaceId: w }, include: { destination: { select: { name: true, connection: { select: { guildName: true } } } } } });
        deliveries.push(deliveryDto(fresh));
      }
      if (ruleId) await this.prisma.db.discordRule.update({ where: { id: ruleId, workspaceId: w }, data: { lastTestedAt: new Date() } });
    }
    return {
      source: sample.source,
      eventId: sample.eventId,
      context: sample.context,
      conditions: { met: conditions.met, failed: conditions.failed ? describeDiscordCondition(conditions.failed) : null },
      message: rendered.message,
      missing: rendered.missing,
      skip: rendered.skip,
      truncated: rendered.truncated,
      warnings: issues.warnings,
      errors: issues.errors,
      deliveries,
    };
  }

  // ─── Templates ────────────────────────────────────────────────────────────

  async templates(ctx: RequestContext) {
    const rows = await this.prisma.db.discordTemplate.findMany({ where: { workspaceId: ws(ctx).id }, include: { _count: { select: { rules: true } } }, orderBy: { name: "asc" } });
    return { default: DEFAULT_DISCORD_TEMPLATE, items: rows.map(templateDto) };
  }

  private checkTemplate(input: z.infer<typeof DiscordTemplateInput>) {
    const { errors } = validateDiscordTemplate(input);
    const first = Object.entries(errors)[0];
    if (first) throw badRequest(first[1], errors);
  }

  async createTemplate(ctx: RequestContext, input: z.infer<typeof DiscordTemplateInput>) {
    const w = ws(ctx).id;
    if ((await this.prisma.db.discordTemplate.count({ where: { workspaceId: w } })) >= MAX_TEMPLATES) throw conflict(`A workspace can have up to ${MAX_TEMPLATES} Discord templates.`);
    this.checkTemplate(input);
    const { name, description, ...body } = input;
    const row = await this.prisma.db.discordTemplate.create({ data: { workspaceId: w, name, description, body: body as never, createdById: actorId(ctx) } });
    await this.audit.record(ctx, { action: "discord.template_created", targetType: "discord_template", targetId: row.id, metadata: { name } });
    return templateDto(row);
  }

  async updateTemplate(ctx: RequestContext, id: string, input: z.infer<typeof DiscordTemplateInput>) {
    const w = ws(ctx).id;
    if (!(await this.prisma.db.discordTemplate.findFirst({ where: { id, workspaceId: w }, select: { id: true } }))) throw notFound("That template");
    this.checkTemplate(input);
    const { name, description, ...body } = input;
    const row = await this.prisma.db.discordTemplate.update({ where: { id, workspaceId: w }, data: { name, description, body: body as never }, include: { _count: { select: { rules: true } } } });
    await this.audit.record(ctx, { action: "discord.template_updated", targetType: "discord_template", targetId: id, metadata: { name } });
    return templateDto(row);
  }

  async deleteTemplate(ctx: RequestContext, id: string) {
    const w = ws(ctx).id;
    const t = await this.prisma.db.discordTemplate.findFirst({ where: { id, workspaceId: w } });
    if (!t) throw notFound("That template");
    const rules = await this.prisma.db.discordRule.findMany({ where: { workspaceId: w, templateId: id }, select: { name: true } });
    if (rules.length) throw conflict(`Rules use this template: ${rules.map((r) => `“${r.name}”`).join(", ")}. Give them another template first.`);
    await this.prisma.db.discordTemplate.delete({ where: { id, workspaceId: w } });
    await this.audit.record(ctx, { action: "discord.template_deleted", targetType: "discord_template", targetId: id, metadata: { name: t.name } });
  }

  // ─── Settings, unrouted events ────────────────────────────────────────────

  async updateSettings(ctx: RequestContext, input: z.infer<typeof DiscordSettingsInput>) {
    const w = ws(ctx).id;
    const fallback = input.unrouted === "fallback" ? input.fallbackDestinationId : null;
    if (fallback && !(await this.prisma.db.discordDestination.findFirst({ where: { id: fallback, workspaceId: w }, select: { id: true } }))) {
      throw badRequest("Choose one of this workspace's destinations", { fallbackDestinationId: "Choose one of this workspace's destinations" });
    }
    const row = await this.prisma.db.discordSettings.upsert({
      where: { workspaceId: w },
      create: { workspaceId: w, unrouted: input.unrouted, fallbackDestinationId: fallback },
      update: { unrouted: input.unrouted, fallbackDestinationId: fallback },
    });
    await this.audit.record(ctx, { action: "discord.settings_updated", targetType: "discord_settings", targetId: row.id, metadata: { unrouted: row.unrouted } });
    return { unrouted: row.unrouted, fallbackDestinationId: row.fallbackDestinationId };
  }

  async unrouted(ctx: RequestContext) {
    return this.prisma.db.discordUnroutedEvent.findMany({ where: { workspaceId: ws(ctx).id }, orderBy: { lastAt: "desc" }, select: { eventType: true, count: true, lastEventId: true, lastAt: true } });
  }

  async clearUnrouted(ctx: RequestContext) {
    await this.prisma.db.discordUnroutedEvent.deleteMany({ where: { workspaceId: ws(ctx).id } });
  }
}
