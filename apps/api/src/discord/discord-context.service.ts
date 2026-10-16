import { Inject, Injectable } from "@nestjs/common";
import { discordContextPaths, discordEventLabel, TRIGGER_EVENT_FIELDS, WEBHOOK_EVENTS, WORKFLOW_TRIGGERS } from "@growthdesk/shared";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { PrismaService } from "../prisma/prisma.service.js";

/*
 * What Discord rules can listen to, and what a template can say about one event.
 *
 * Events: there is no single registry in the codebase; the two that exist are
 * the outgoing-webhook list (WEBHOOK_EVENTS) and the workflow triggers
 * (WORKFLOW_TRIGGERS), which between them name every type the services emit.
 * The catalogue is their union, plus any other type this workspace's outbox
 * has actually recorded lately, so a new event type shows up without a code
 * change here. Nothing is made up: each entry is a type the system emits.
 *
 * Context: an event's payload is mostly ids. A template wants names, so the
 * context adds the contact, deal and the event's own subject (meeting, task,
 * conversation, campaign, call), read fresh at send time and scoped to the
 * workspace. Missing pieces are simply absent; templates handle that.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
/** Payload bookkeeping that is not part of what the event says. */
const INTERNAL_KEYS = new Set(["workflowDepth", "workflowRunId"]);
/** How far back the outbox is looked at for event types and example payloads. */
const SEEN_WINDOW_MS = 90 * 86_400_000;

export const REGISTERED_EVENTS: readonly string[] = [...new Set<string>([...WEBHOOK_EVENTS, ...WORKFLOW_TRIGGERS])].sort();

export type DiscordEventCatalogEntry = {
  type: string;
  label: string;
  /** In the webhook or workflow registry (else: seen in this workspace's outbox). */
  registered: boolean;
  recentCount: number;
  lastAt: Date | null;
};

export type EventLike = { id: string; type: string; subjectType: string; subjectId: string; actorId: string | null; payload: unknown; occurredAt: Date };

@Injectable()
export class DiscordContextService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private base() {
    return this.config.PUBLIC_APP_URL.replace(/\/+$/, "");
  }

  /** Event types a rule may use in this workspace, most active first within registered ones. */
  async catalog(workspaceId: string): Promise<DiscordEventCatalogEntry[]> {
    const seen = await this.prisma.db.domainEvent.groupBy({
      by: ["type"],
      where: { workspaceId, occurredAt: { gte: new Date(Date.now() - SEEN_WINDOW_MS) } },
      _count: { _all: true },
      _max: { occurredAt: true },
    });
    const byType = new Map(seen.map((s) => [s.type, s]));
    const types = new Set<string>([...REGISTERED_EVENTS, ...seen.map((s) => s.type)]);
    return [...types]
      .filter((t) => /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/.test(t))
      .map((type) => ({
        type,
        label: discordEventLabel(type),
        registered: REGISTERED_EVENTS.includes(type),
        recentCount: byType.get(type)?._count._all ?? 0,
        lastAt: byType.get(type)?._max.occurredAt ?? null,
      }))
      .sort((a, b) => a.type.localeCompare(b.type));
  }

  async knownTypes(workspaceId: string): Promise<Set<string>> {
    return new Set((await this.catalog(workspaceId)).map((e) => e.type));
  }

  /**
   * The fields a template can use for these event types: every leaf of real
   * recent events' contexts (with an example value), plus the payload keys
   * the workflow builder documents. Without any real event, a sample context.
   */
  async fields(workspaceId: string, types: string[]): Promise<{ path: string; example: string; types: string[] }[]> {
    const out = new Map<string, { path: string; example: string; types: Set<string> }>();
    const add = (type: string, path: string, example: string) => {
      const f = out.get(path) ?? { path, example, types: new Set<string>() };
      if (!f.example && example) f.example = example;
      f.types.add(type);
      out.set(path, f);
    };
    for (const type of types.slice(0, 50)) {
      const recent = await this.prisma.db.domainEvent.findMany({ where: { workspaceId, type }, orderBy: { occurredAt: "desc" }, take: 5 });
      const contexts = recent.length ? await Promise.all(recent.map((e) => this.build(workspaceId, e))) : [await this.sample(workspaceId, type)];
      for (const ctx of contexts) for (const p of discordContextPaths(ctx)) add(type, p.path, p.example);
      for (const f of TRIGGER_EVENT_FIELDS[type as keyof typeof TRIGGER_EVENT_FIELDS] ?? []) add(type, `payload.${f.key}`, "");
    }
    return [...out.values()].map((f) => ({ path: f.path, example: f.example, types: [...f.types].sort() })).sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * A context for previews when the workspace has no event of this type yet:
   * the event's own fields, the workspace, and the most recently updated
   * contact and open deal (real records, so the preview shows real names).
   */
  async sample(workspaceId: string, type: string): Promise<Record<string, unknown>> {
    const [contact, deal] = await Promise.all([
      this.prisma.db.contact.findFirst({ where: { workspaceId, deletedAt: null }, orderBy: { updatedAt: "desc" }, select: { id: true } }),
      this.prisma.db.deal.findFirst({ where: { workspaceId, deletedAt: null }, orderBy: { updatedAt: "desc" }, select: { id: true, contactId: true } }),
    ]);
    const fake: EventLike = {
      id: "00000000-0000-0000-0000-000000000000",
      type,
      subjectType: type.startsWith("deal.") && deal ? "deal" : contact ? "contact" : "",
      subjectId: type.startsWith("deal.") && deal ? deal.id : (contact?.id ?? ""),
      actorId: null,
      payload: { contactId: (type.startsWith("deal.") ? deal?.contactId : contact?.id) ?? null, ...(deal ? { dealId: deal.id } : {}) },
      occurredAt: new Date(),
    };
    const ctx = await this.build(workspaceId, fake);
    (ctx.event as Record<string, unknown>).sample = true;
    return ctx;
  }

  /** The render context for one event. */
  async build(workspaceId: string, e: EventLike): Promise<Record<string, unknown>> {
    const raw = (e.payload && typeof e.payload === "object" && !Array.isArray(e.payload) ? e.payload : {}) as Record<string, unknown>;
    const payload = Object.fromEntries(Object.entries(raw).filter(([k]) => !INTERNAL_KEYS.has(k)));
    const ws = await this.prisma.db.workspace.findFirst({ where: { id: workspaceId }, select: { name: true, currency: true, timezone: true } });
    const app = `${this.base()}/w/${workspaceId}`;

    const ctx: Record<string, unknown> = {
      event: {
        id: e.id,
        type: e.type,
        label: discordEventLabel(e.type),
        occurredAt: e.occurredAt.toISOString(),
        subject: { type: e.subjectType, id: e.subjectId },
        link: app,
      },
      workspace: { name: ws?.name ?? "", timezone: ws?.timezone ?? "UTC", currency: ws?.currency ?? "USD", link: app },
      payload,
    };
    const event = ctx.event as Record<string, unknown>;

    if (isId(e.actorId)) {
      const actor = await this.prisma.db.user.findUnique({ where: { id: e.actorId }, select: { name: true } });
      if (actor) event.actor = { name: actor.name };
    }

    const subjectOf = (kind: string, key: string) => (e.subjectType === kind && isId(e.subjectId) ? e.subjectId : isId(payload[key]) ? (payload[key] as string) : null);
    const money = (n: number, currency: string) => {
      try {
        return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(n);
      } catch {
        return `${n} ${currency}`;
      }
    };

    // The event's own subject, when it is not a contact or a deal.
    if (e.subjectType === "meeting" && isId(e.subjectId)) {
      const m = await this.prisma.db.meeting.findFirst({ where: { id: e.subjectId, workspaceId }, select: { title: true, startsAt: true, endsAt: true, location: true, conferenceUrl: true, attendeeName: true, attendeeEmail: true, status: true, contactId: true, dealId: true } });
      if (m) {
        ctx.meeting = { ...m, startsAt: m.startsAt.toISOString(), endsAt: m.endsAt?.toISOString() ?? null };
        payload.contactId ??= m.contactId;
        payload.dealId ??= m.dealId;
        event.link = `${app}/meetings`;
      }
    } else if (e.subjectType === "task" && isId(e.subjectId)) {
      const t = await this.prisma.db.task.findFirst({ where: { id: e.subjectId, workspaceId }, select: { title: true, type: true, dueAt: true, status: true, priority: true, contactId: true, dealId: true, assignee: { select: { name: true } } } });
      if (t) {
        ctx.task = { title: t.title, type: t.type, status: t.status, priority: t.priority, dueAt: t.dueAt?.toISOString() ?? null, assignee: t.assignee ? { name: t.assignee.name } : null };
        payload.contactId ??= t.contactId;
        payload.dealId ??= t.dealId;
        event.link = `${app}/tasks`;
      }
    } else if (e.subjectType === "conversation" && isId(e.subjectId)) {
      const c = await this.prisma.db.conversation.findFirst({ where: { id: e.subjectId, workspaceId }, select: { channel: true, subject: true, displayName: true, handle: true, aiCategory: true, aiSentiment: true, aiSummary: true, contactId: true, assignee: { select: { name: true } } } });
      if (c) {
        ctx.conversation = { channel: c.channel, subject: c.subject, from: c.displayName || c.handle, category: c.aiCategory, sentiment: c.aiSentiment, summary: c.aiSummary, assignee: c.assignee ? { name: c.assignee.name } : null, link: `${app}/inbox?c=${e.subjectId}` };
        payload.contactId ??= c.contactId;
        event.link = `${app}/inbox?c=${e.subjectId}`;
      }
    } else if (e.subjectType === "call" && isId(e.subjectId)) {
      const c = await this.prisma.db.call.findFirst({ where: { id: e.subjectId, workspaceId }, select: { direction: true, status: true, outcome: true, durationSec: true, summary: true, contactId: true, dealId: true, user: { select: { name: true } } } });
      if (c) {
        ctx.call = { direction: c.direction, status: c.status, outcome: c.outcome, durationSec: c.durationSec, summary: c.summary, by: c.user ? { name: c.user.name } : null };
        payload.contactId ??= c.contactId;
        payload.dealId ??= c.dealId;
        event.link = `${app}/calls`;
      }
    }

    const campaignId = subjectOf("campaign", "campaignId");
    if (campaignId) {
      const c = await this.prisma.db.campaign.findFirst({ where: { id: campaignId, workspaceId }, select: { name: true, status: true, enrolledCount: true, sentCount: true, replyCount: true, positiveReplyCount: true, bounceCount: true } });
      if (c) {
        ctx.campaign = { ...c, link: `${app}/campaigns/${campaignId}` };
        if (e.subjectType === "campaign") event.link = `${app}/campaigns/${campaignId}`;
      }
    }

    const dealId = subjectOf("deal", "dealId");
    if (dealId) {
      const d = await this.prisma.db.deal.findFirst({
        where: { id: dealId, workspaceId },
        select: { name: true, value: true, currency: true, status: true, expectedCloseDate: true, contactId: true, stage: { select: { name: true } }, pipeline: { select: { name: true } }, owner: { select: { name: true, email: true } }, company: { select: { name: true } } },
      });
      if (d) {
        const value = Number(d.value);
        ctx.deal = {
          id: dealId,
          title: d.name,
          value,
          currency: d.currency,
          valueFormatted: money(value, d.currency),
          status: d.status,
          stage: d.stage.name,
          pipeline: d.pipeline.name,
          expectedCloseDate: d.expectedCloseDate?.toISOString().slice(0, 10) ?? null,
          owner: d.owner,
          company: d.company,
          link: `${app}/deals/${dealId}`,
        };
        payload.contactId ??= d.contactId;
        if (e.subjectType === "deal") event.link = `${app}/deals/${dealId}`;
      }
    }

    const contactId = subjectOf("contact", "contactId");
    if (contactId) {
      const c = await this.prisma.db.contact.findFirst({
        where: { id: contactId, workspaceId },
        select: {
          firstName: true,
          lastName: true,
          fullName: true,
          email: true,
          phone: true,
          jobTitle: true,
          website: true,
          city: true,
          country: true,
          leadSource: true,
          status: true,
          qualification: true,
          priority: true,
          lifecycleStage: true,
          score: true,
          customFields: true,
          deletedAt: true,
          owner: { select: { name: true, email: true } },
          company: { select: { name: true, domain: true, industry: true } },
          tags: { select: { tag: { select: { name: true } } } },
        },
      });
      if (c) {
        ctx.contact = {
          id: contactId,
          fullName: c.fullName,
          firstName: c.firstName,
          lastName: c.lastName,
          email: c.email,
          phone: c.phone,
          jobTitle: c.jobTitle,
          website: c.website,
          city: c.city,
          country: c.country,
          leadSource: c.leadSource,
          status: c.status,
          qualification: c.qualification,
          priority: c.priority,
          lifecycleStage: c.lifecycleStage,
          score: c.score,
          tags: c.tags.map((t) => t.tag.name),
          owner: c.owner,
          company: c.company,
          custom: c.customFields && typeof c.customFields === "object" ? c.customFields : {},
          deleted: Boolean(c.deletedAt),
          link: `${app}/contacts/${contactId}`,
        };
        if (e.subjectType === "contact") event.link = `${app}/contacts/${contactId}`;
      }
    }
    return ctx;
  }
}
