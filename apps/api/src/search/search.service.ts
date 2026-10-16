import { Injectable } from "@nestjs/common";
import type { Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { holds, ownershipScope, ws, type RequestContext } from "../common/context.js";

/*
 * Global search (the ⌘K palette, and the MCP `global_search` tool).
 *
 * One query string, matched case-insensitively against each kind of record
 * the person may read, all kinds in parallel. Every group applies the same
 * visibility rule as its list endpoint: the same permission (a group the role
 * cannot read is left out of the answer, not returned empty), the same
 * ownership scope (contacts, companies and deals by owner; conversations and
 * tasks by assignee) and the same "not deleted / not archived" filters.
 *
 * Relevance: an exact match first, then a prefix, then a word that starts
 * with the query, then anything containing it; ties go to the most recently
 * updated. Each group runs a prefix query and a contains query so a prefix
 * match is never crowded out by newer "contains" rows.
 */

export const SEARCH_GROUPS = ["contacts", "companies", "deals", "conversations", "campaigns", "lists", "templates", "workflows", "tasks"] as const;
export type SearchGroup = (typeof SEARCH_GROUPS)[number];

export type SearchHit = {
  id: string;
  /** What a person reads first: the name, title or subject. */
  title: string;
  /** A second line: email, company, contact, channel… */
  subtitle: string | null;
  /** A status-ish value (lifecycle stage, deal stage, campaign status…), shown as a chip. */
  badge: string | null;
  /** Narrows the kind inside a group: "outreach" | "marketing" (campaigns), "template" | "design" (templates), a channel (conversations). */
  kind?: string;
  /** Deals: the amount. */
  value?: number;
  currency?: string;
  updatedAt: Date;
};

export type SearchGroupResult = { items: SearchHit[]; more: boolean };
export type SearchResult = { q: string; groups: Partial<Record<SearchGroup, SearchGroupResult>> };

export const SEARCH_MAX_LIMIT = 10;
export const SEARCH_DEFAULT_LIMIT = 5;
export const SEARCH_MAX_QUERY = 100;

/** Any one of these permissions lets a role see the group (as its list endpoint's @Permission does). */
export const SEARCH_PERMISSIONS: Record<SearchGroup, readonly string[]> = {
  contacts: ["contacts.read"],
  companies: ["contacts.read"],
  deals: ["deals.read"],
  conversations: ["inbox.read"],
  campaigns: ["campaigns.read", "marketing.read"],
  lists: ["marketing.read", "contacts.read"],
  templates: ["templates.read", "marketing.read"],
  workflows: ["automation.read"],
  tasks: ["tasks.read"],
};

const ci = (value: string) => ({ contains: value, mode: "insensitive" as const });
const pre = (value: string) => ({ startsWith: value, mode: "insensitive" as const });

/** 0 exact, 1 prefix, 2 a word starts with it, 3 contains (or matched another field). */
export function relevance(q: string, texts: (string | null | undefined)[]): number {
  const needle = q.toLowerCase();
  let best = 3;
  for (const raw of texts) {
    if (!raw) continue;
    const t = raw.toLowerCase();
    if (t === needle) return 0;
    if (t.startsWith(needle)) best = Math.min(best, 1);
    else if (t.split(/[\s@._\-/,()]+/).some((w) => w.startsWith(needle))) best = Math.min(best, 2);
  }
  return best;
}

type Row = { id: string; updatedAt: Date };

@Injectable()
export class SearchService {
  constructor(private readonly prisma: PrismaService) {}

  /** The groups this context may search. */
  groupsFor(ctx: RequestContext): SearchGroup[] {
    return SEARCH_GROUPS.filter((g) => SEARCH_PERMISSIONS[g].some((p) => holds(ctx, p)));
  }

  async search(ctx: RequestContext, rawQuery: string, rawLimit = SEARCH_DEFAULT_LIMIT): Promise<SearchResult> {
    const q = rawQuery.trim().slice(0, SEARCH_MAX_QUERY);
    const limit = Math.min(SEARCH_MAX_LIMIT, Math.max(1, Math.floor(rawLimit) || SEARCH_DEFAULT_LIMIT));
    const groups: SearchResult["groups"] = {};
    if (!q) return { q, groups };
    const allowed = this.groupsFor(ctx);
    const runners: Record<SearchGroup, () => Promise<SearchGroupResult>> = {
      contacts: () => this.contacts(ctx, q, limit),
      companies: () => this.companies(ctx, q, limit),
      deals: () => this.deals(ctx, q, limit),
      conversations: () => this.conversations(ctx, q, limit),
      campaigns: () => this.campaigns(ctx, q, limit),
      lists: () => this.lists(ctx, q, limit),
      templates: () => this.templates(ctx, q, limit),
      workflows: () => this.workflows(ctx, q, limit),
      tasks: () => this.tasks(ctx, q, limit),
    };
    const results = await Promise.all(allowed.map((g) => runners[g]()));
    allowed.forEach((g, i) => (groups[g] = results[i]!));
    return { q, groups };
  }

  /**
   * Runs the prefix and contains queries (each fetching a little more than
   * the limit), merges them, ranks, and cuts to `limit`.
   */
  private async ranked<T extends Row>(
    q: string,
    limit: number,
    queries: ((take: number) => Promise<T[]>)[],
    texts: (row: T) => (string | null | undefined)[],
    hit: (row: T) => SearchHit,
  ): Promise<SearchGroupResult> {
    const take = limit + 1;
    const batches = await Promise.all(queries.map((run) => run(take)));
    const byId = new Map<string, T>();
    for (const batch of batches) for (const row of batch) if (!byId.has(row.id)) byId.set(row.id, row);
    const rows = [...byId.values()]
      .map((row) => ({ row, score: relevance(q, texts(row)) }))
      .sort((a, b) => a.score - b.score || b.row.updatedAt.getTime() - a.row.updatedAt.getTime());
    return { items: rows.slice(0, limit).map((r) => hit(r.row)), more: rows.length > limit };
  }

  // ─── Groups ────────────────────────────────────────────────────────────────

  private contacts(ctx: RequestContext, q: string, limit: number) {
    const w = ws(ctx);
    const base = (match: Prisma.ContactWhereInput): Prisma.ContactWhereInput => ({
      workspaceId: w.id,
      deletedAt: null,
      archivedAt: null,
      AND: [ownershipScope(ctx) as Prisma.ContactWhereInput, match],
    });
    const select = { id: true, fullName: true, email: true, lifecycleStage: true, updatedAt: true, company: { select: { name: true } } } as const;
    const find = (where: Prisma.ContactWhereInput) => (take: number) =>
      this.prisma.db.contact.findMany({ where: base(where), select, orderBy: [{ updatedAt: "desc" }, { id: "asc" }], take });
    const email = q.toLowerCase();
    return this.ranked(
      q,
      limit,
      [
        find({ OR: [{ fullName: pre(q) }, { email: { startsWith: email } }] }),
        find({ OR: [{ fullName: ci(q) }, { email: { contains: email } }, { company: { name: ci(q) } }] }),
      ],
      (c) => [c.fullName, c.email],
      (c) => ({
        id: c.id,
        title: c.fullName || c.email || "Unnamed",
        subtitle: [c.email, c.company?.name].filter(Boolean).join(" · ") || null,
        badge: c.lifecycleStage,
        updatedAt: c.updatedAt,
      }),
    );
  }

  private companies(ctx: RequestContext, q: string, limit: number) {
    const w = ws(ctx);
    const select = { id: true, name: true, domain: true, updatedAt: true } as const;
    const find = (match: Prisma.CompanyWhereInput) => (take: number) =>
      this.prisma.db.company.findMany({
        where: { workspaceId: w.id, deletedAt: null, AND: [ownershipScope(ctx) as Prisma.CompanyWhereInput, match] },
        select,
        orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
        take,
      });
    return this.ranked(
      q,
      limit,
      [find({ OR: [{ name: pre(q) }, { domain: { startsWith: q.toLowerCase() } }] }), find({ OR: [{ name: ci(q) }, { domain: { contains: q.toLowerCase() } }] })],
      (c) => [c.name, c.domain],
      (c) => ({ id: c.id, title: c.name, subtitle: c.domain, badge: null, updatedAt: c.updatedAt }),
    );
  }

  private deals(ctx: RequestContext, q: string, limit: number) {
    const w = ws(ctx);
    const select = {
      id: true,
      name: true,
      value: true,
      currency: true,
      status: true,
      updatedAt: true,
      stage: { select: { name: true } },
      contact: { select: { fullName: true } },
      company: { select: { name: true } },
    } as const;
    const find = (match: Prisma.DealWhereInput) => (take: number) =>
      this.prisma.db.deal.findMany({
        where: { workspaceId: w.id, deletedAt: null, AND: [ownershipScope(ctx) as Prisma.DealWhereInput, match] },
        select,
        orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
        take,
      });
    return this.ranked(
      q,
      limit,
      [find({ name: pre(q) }), find({ OR: [{ name: ci(q) }, { company: { name: ci(q) } }, { contact: { fullName: ci(q) } }] })],
      (d) => [d.name],
      (d) => ({
        id: d.id,
        title: d.name,
        subtitle: [d.company?.name, d.contact?.fullName].filter(Boolean).join(" · ") || null,
        // Open deals show their stage; closed ones say won or lost.
        badge: d.status === "open" ? d.stage.name : d.status,
        value: Number(d.value),
        currency: d.currency,
        updatedAt: d.updatedAt,
      }),
    );
  }

  private conversations(ctx: RequestContext, q: string, limit: number) {
    const w = ws(ctx);
    // InboxService.scope: without records.view_all, assigned to me or unassigned.
    const scope = ownershipScope(ctx, "assigneeId") as Prisma.ConversationWhereInput;
    const select = {
      id: true,
      subject: true,
      displayName: true,
      handle: true,
      channel: true,
      status: true,
      updatedAt: true,
      contact: { select: { fullName: true, email: true } },
    } as const;
    const find = (match: Prisma.ConversationWhereInput) => (take: number) =>
      this.prisma.db.conversation.findMany({ where: { workspaceId: w.id, AND: [scope, match] }, select, orderBy: [{ updatedAt: "desc" }, { id: "asc" }], take });
    return this.ranked(
      q,
      limit,
      [
        find({ OR: [{ subject: pre(q) }, { displayName: pre(q) }, { contact: { fullName: pre(q) } }] }),
        find({
          OR: [
            { subject: ci(q) },
            { displayName: ci(q) },
            { handle: ci(q) },
            { contact: { fullName: ci(q) } },
            { contact: { email: { contains: q.toLowerCase() } } },
          ],
        }),
      ],
      (c) => [c.subject, c.displayName, c.contact?.fullName, c.handle],
      (c) => {
        const who = c.contact?.fullName || c.displayName || c.handle || c.contact?.email || null;
        return { id: c.id, title: c.subject || who || "Conversation", subtitle: c.subject ? who : c.handle || null, badge: c.status, kind: c.channel, updatedAt: c.updatedAt };
      },
    );
  }

  private async campaigns(ctx: RequestContext, q: string, limit: number) {
    const w = ws(ctx);
    const queries: ((take: number) => Promise<(Row & { name: string; status: string; kind: "outreach" | "marketing"; detail: string })[]>)[] = [];
    if (holds(ctx, "campaigns.read")) {
      const find = (match: Prisma.CampaignWhereInput) => async (take: number) =>
        (
          await this.prisma.db.campaign.findMany({
            where: { workspaceId: w.id, deletedAt: null, ...match },
            select: { id: true, name: true, status: true, updatedAt: true },
            orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
            take,
          })
        ).map((c) => ({ ...c, kind: "outreach" as const, detail: "Outreach" }));
      queries.push(find({ name: pre(q) }), find({ name: ci(q) }));
    }
    if (holds(ctx, "marketing.read")) {
      const find = (match: Prisma.MarketingCampaignWhereInput) => async (take: number) =>
        (
          await this.prisma.db.marketingCampaign.findMany({
            where: { workspaceId: w.id, deletedAt: null, ...match },
            select: { id: true, name: true, status: true, subject: true, updatedAt: true },
            orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
            take,
          })
        ).map((c) => ({ id: c.id, name: c.name, status: c.status, updatedAt: c.updatedAt, kind: "marketing" as const, detail: c.subject ? `Marketing · ${c.subject}` : "Marketing" }));
      queries.push(find({ name: pre(q) }), find({ OR: [{ name: ci(q) }, { subject: ci(q) }] }));
    }
    return this.ranked(
      q,
      limit,
      queries,
      (c) => [c.name],
      (c) => ({ id: c.id, title: c.name, subtitle: c.detail, badge: c.status, kind: c.kind, updatedAt: c.updatedAt }),
    );
  }

  private lists(ctx: RequestContext, q: string, limit: number) {
    const w = ws(ctx);
    const find = (match: Prisma.MarketingListWhereInput) => (take: number) =>
      this.prisma.db.marketingList.findMany({
        where: { workspaceId: w.id, archivedAt: null, ...match },
        select: { id: true, name: true, description: true, updatedAt: true },
        orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
        take,
      });
    return this.ranked(
      q,
      limit,
      [find({ name: pre(q) }), find({ name: ci(q) })],
      (l) => [l.name],
      (l) => ({ id: l.id, title: l.name, subtitle: l.description || null, badge: null, updatedAt: l.updatedAt }),
    );
  }

  /** Message templates (templates.read) and email designs (marketing.read), one group. */
  private templates(ctx: RequestContext, q: string, limit: number) {
    const w = ws(ctx);
    type T = Row & { name: string; kind: "template" | "design"; detail: string | null; channel: string | null };
    const queries: ((take: number) => Promise<T[]>)[] = [];
    if (holds(ctx, "templates.read")) {
      const find = (match: Prisma.TemplateWhereInput) => async (take: number) =>
        (
          await this.prisma.db.template.findMany({
            where: { workspaceId: w.id, archivedAt: null, ...match },
            select: { id: true, name: true, channel: true, subject: true, category: true, updatedAt: true },
            orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
            take,
          })
        ).map((t): T => ({ id: t.id, name: t.name, updatedAt: t.updatedAt, kind: "template", channel: t.channel, detail: t.subject || t.category || null }));
      queries.push(find({ name: pre(q) }), find({ OR: [{ name: ci(q) }, { subject: ci(q) }, { category: ci(q) }] }));
    }
    if (holds(ctx, "marketing.read")) {
      const find = (match: Prisma.EmailDesignWhereInput) => async (take: number) =>
        (
          await this.prisma.db.emailDesign.findMany({
            where: { workspaceId: w.id, archivedAt: null, ...match },
            select: { id: true, name: true, updatedAt: true },
            orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
            take,
          })
        ).map((d): T => ({ ...d, kind: "design", channel: null, detail: "Email design" }));
      queries.push(find({ name: pre(q) }), find({ name: ci(q) }));
    }
    return this.ranked(
      q,
      limit,
      queries,
      (t) => [t.name],
      (t) => ({ id: t.id, title: t.name, subtitle: t.detail, badge: t.channel, kind: t.kind, updatedAt: t.updatedAt }),
    );
  }

  private workflows(ctx: RequestContext, q: string, limit: number) {
    const w = ws(ctx);
    const find = (match: Prisma.WorkflowWhereInput) => (take: number) =>
      this.prisma.db.workflow.findMany({
        where: { workspaceId: w.id, deletedAt: null, ...match },
        select: { id: true, name: true, description: true, enabled: true, updatedAt: true },
        orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
        take,
      });
    return this.ranked(
      q,
      limit,
      [find({ name: pre(q) }), find({ OR: [{ name: ci(q) }, { description: ci(q) }] })],
      (f) => [f.name],
      (f) => ({ id: f.id, title: f.name, subtitle: f.description || null, badge: f.enabled ? "active" : "paused", updatedAt: f.updatedAt }),
    );
  }

  private tasks(ctx: RequestContext, q: string, limit: number) {
    const w = ws(ctx);
    // TasksService.scope: without records.view_all, mine or unassigned.
    const scope = ownershipScope(ctx, "assigneeId") as Prisma.TaskWhereInput;
    const find = (match: Prisma.TaskWhereInput) => (take: number) =>
      this.prisma.db.task.findMany({
        where: { workspaceId: w.id, AND: [scope, match] },
        select: { id: true, title: true, status: true, dueAt: true, updatedAt: true, contact: { select: { fullName: true } }, deal: { select: { name: true } } },
        // Open work before finished work, then the usual recency.
        orderBy: [{ status: "asc" }, { updatedAt: "desc" }, { id: "asc" }],
        take,
      });
    return this.ranked(
      q,
      limit,
      [find({ title: pre(q) }), find({ OR: [{ title: ci(q) }, { contact: { fullName: ci(q) } }, { deal: { name: ci(q) } }] })],
      (t) => [t.title],
      (t) => ({ id: t.id, title: t.title, subtitle: t.contact?.fullName ?? t.deal?.name ?? null, badge: t.status, updatedAt: t.updatedAt }),
    );
  }
}
