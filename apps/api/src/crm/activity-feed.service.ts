import { Injectable } from "@nestjs/common";
import type { Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { holds, ws, type RequestContext } from "../common/context.js";
import { badRequest } from "../common/errors.js";
import { ACTOR_TYPES, type ActorType } from "../common/actor.js";

export type FeedQuery = {
  actorType?: ActorType;
  /** A teammate: what they did themselves and what an AI agent did for them. */
  userId?: string;
  /** A team: what its members did (and AI agents for them). Team viewers only. */
  teamId?: string;
  /** Activity type, or a prefix ending in "." ("deal." → every deal event). */
  type?: string;
  from?: Date;
  to?: Date;
  /** The last item's id from the previous page. */
  cursor?: string;
  limit?: number;
};

const PAGE = 50;

/**
 * The team activity feed: every timeline entry in the workspace, newest
 * first, with who acted — a teammate, an AI agent (and for whom), a
 * workflow, an integration or the system — and what it was about.
 *
 * Who sees what: anyone with `analytics.team` (owners, admins, managers by
 * default) sees the whole team and can filter by person; everyone else sees
 * only their own entries (and their AI agents').
 */
@Injectable()
export class ActivityFeedService {
  constructor(private readonly prisma: PrismaService) {}

  private async scope(ctx: RequestContext, q: FeedQuery): Promise<Prisma.ActivityWhereInput> {
    const w = ws(ctx);
    const me = ctx.identity?.userId ?? null;
    const team = holds(ctx, "analytics.team");
    const person = team ? q.userId : me;
    if (!team && !me) throw badRequest("The team activity feed needs a signed-in teammate or the analytics.team permission");
    const and: Prisma.ActivityWhereInput[] = [];
    if (person) and.push({ OR: [{ actorId: person }, { onBehalfOfId: person }] });
    if (team && q.teamId) {
      const ids = (await this.prisma.db.teamMember.findMany({ where: { workspaceId: w.id, teamId: q.teamId }, select: { userId: true } })).map((m) => m.userId);
      and.push({ OR: [{ actorId: { in: ids } }, { onBehalfOfId: { in: ids } }] });
    }
    if (q.actorType) and.push({ actorType: q.actorType });
    if (q.type) and.push(q.type.endsWith(".") ? { type: { startsWith: q.type } } : { type: q.type });
    // What has happened: an entry dated ahead (a meeting logged at its start time) waits until then.
    const until = q.to && q.to.getTime() < Date.now() ? q.to : new Date();
    and.push({ occurredAt: { ...(q.from ? { gte: q.from } : {}), lt: until } });
    return { workspaceId: w.id, ...(and.length ? { AND: and } : {}) };
  }

  async feed(ctx: RequestContext, q: FeedQuery) {
    const w = ws(ctx);
    const take = Math.min(Math.max(q.limit ?? PAGE, 1), 100);
    const rows = await this.prisma.db.activity.findMany({
      where: await this.scope(ctx, q),
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: take + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, take);
    const ids = <K extends "actorId" | "onBehalfOfId" | "contactId" | "dealId" | "companyId">(k: K) => [...new Set(page.map((r) => r[k]).filter((v): v is string => Boolean(v)))];
    const [users, contacts, deals, companies] = await Promise.all([
      this.prisma.db.user.findMany({ where: { id: { in: [...new Set([...ids("actorId"), ...ids("onBehalfOfId")])] } }, select: { id: true, name: true, email: true } }),
      this.prisma.db.contact.findMany({ where: { workspaceId: w.id, id: { in: ids("contactId") } }, select: { id: true, fullName: true, firstName: true, lastName: true, email: true, lifecycleStage: true } }),
      this.prisma.db.deal.findMany({ where: { workspaceId: w.id, id: { in: ids("dealId") } }, select: { id: true, name: true } }),
      this.prisma.db.company.findMany({ where: { workspaceId: w.id, id: { in: ids("companyId") } }, select: { id: true, name: true } }),
    ]);
    const user = new Map(users.map((u) => [u.id, u]));
    const contact = new Map(contacts.map((c) => [c.id, c]));
    const deal = new Map(deals.map((d) => [d.id, d]));
    const company = new Map(companies.map((c) => [c.id, c]));
    return {
      items: page.map((r) => ({
        id: r.id,
        type: r.type,
        summary: r.summary,
        occurredAt: r.occurredAt,
        actor: {
          type: r.actorType,
          // A person's current name; an AI agent, workflow or integration as it was named when it acted.
          name: (r.actorType === "user" && r.actorId ? user.get(r.actorId)?.name : r.actorName) || r.actorName || (r.actorType === "system" ? "Growthdesk" : ""),
          id: r.actorId,
          ref: r.actorRef,
          onBehalfOf: r.onBehalfOfId ? { id: r.onBehalfOfId, name: user.get(r.onBehalfOfId)?.name ?? "" } : null,
        },
        contact: r.contactId ? (contact.get(r.contactId) ?? null) : null,
        deal: r.dealId ? (deal.get(r.dealId) ?? null) : null,
        company: r.companyId ? (company.get(r.companyId) ?? null) : null,
      })),
      nextCursor: rows.length > take ? page[page.length - 1]!.id : null,
    };
  }

  /** Counts for the feed's header: by kind of actor, and by teammate (for team viewers). */
  async summary(ctx: RequestContext, q: Pick<FeedQuery, "from" | "to" | "teamId">) {
    const where = await this.scope(ctx, q);
    const [byType, byPerson] = await Promise.all([
      this.prisma.db.activity.groupBy({ by: ["actorType"], where, _count: { _all: true } }),
      holds(ctx, "analytics.team")
        ? this.prisma.db.activity.groupBy({ by: ["actorId", "onBehalfOfId", "actorType"], where: { AND: [where, { OR: [{ actorId: { not: null } }, { onBehalfOfId: { not: null } }] }] }, _count: { _all: true } })
        : Promise.resolve([] as { actorId: string | null; onBehalfOfId: string | null; actorType: string; _count: { _all: number } }[]),
    ]);
    const counts = Object.fromEntries(ACTOR_TYPES.map((t) => [t, 0])) as Record<ActorType, number>;
    for (const g of byType) if ((ACTOR_TYPES as readonly string[]).includes(g.actorType)) counts[g.actorType as ActorType] += g._count._all;
    const people = new Map<string, { userId: string; own: number; byAi: number }>();
    for (const g of byPerson) {
      // An AI agent's entry counts for the teammate it acted for.
      const who = g.actorType === "ai_agent" ? (g.onBehalfOfId ?? g.actorId) : g.actorId;
      if (!who || (g.actorType !== "ai_agent" && g.actorType !== "user")) continue;
      const p = people.get(who) ?? { userId: who, own: 0, byAi: 0 };
      if (g.actorType === "ai_agent") p.byAi += g._count._all;
      else p.own += g._count._all;
      people.set(who, p);
    }
    const users = await this.prisma.db.user.findMany({ where: { id: { in: [...people.keys()] } }, select: { id: true, name: true, email: true } });
    const name = new Map(users.map((u) => [u.id, u]));
    return {
      byActorType: counts,
      byPerson: [...people.values()]
        .map((p) => ({ ...p, name: name.get(p.userId)?.name ?? "", email: name.get(p.userId)?.email ?? "" }))
        .sort((a, b) => b.own + b.byAi - (a.own + a.byAi)),
    };
  }
}
