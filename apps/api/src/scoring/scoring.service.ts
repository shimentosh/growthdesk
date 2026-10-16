import { Injectable, Logger } from "@nestjs/common";
import {
  computeScore,
  DEFAULT_LEAD_SCORING,
  LeadScoringSettings,
  RECOMMENDED_SCORING_RULES,
  scoreBand,
  scoringRuleProblem,
  signalKey,
  type LeadScoringSettingsT,
  type ScoreBreakdownItem,
  type ScoringFacts,
  type ScoringRuleFieldsT,
  type ScoringRuleInputT,
  type ScoringRuleLike,
} from "@growthdesk/shared";
import { Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { ActivityService } from "../crm/activity.service.js";
import { AuditService } from "../core/audit.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { QUEUES, Queues } from "../queues/queues.js";
import { SharedRedis } from "../queues/redis.js";
import { runAs } from "../common/actor.js";
import { ownershipScope, ws, type RequestContext } from "../common/context.js";
import { badRequest, conflict, notFound, tooMany } from "../common/errors.js";

const DAY = 86_400_000;
/** A contact's recompute waits this long, so a burst of events (an open, a click, a reply) is one job. */
export const SCORE_DEBOUNCE_MS = 10_000;
/** "Recalculate all" once per workspace per this many seconds. */
export const RECALC_COOLDOWN_S = 600;
/** The sweep re-reads this much before its cursor: rows committed late (long transactions, clock skew) are still seen. */
const SWEEP_OVERLAP_MS = 2 * 60_000;
const BATCH = 200;
const MAX_RULES = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The lowest uuid v7 minted at or after `at`: ids are time-ordered, so `id >= uuidFloor(t)` is "created since t" on the primary key. */
export function uuidFloor(at: Date): string {
  const h = Math.max(0, at.getTime()).toString(16).padStart(12, "0");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-0000-0000-000000000000`;
}

const contactSelect = {
  id: true,
  ownerId: true,
  fullName: true,
  firstName: true,
  lastName: true,
  email: true,
  phone: true,
  jobTitle: true,
  leadSource: true,
  country: true,
  city: true,
  website: true,
  linkedinUrl: true,
  lifecycleStage: true,
  status: true,
  qualification: true,
  priority: true,
  customFields: true,
  unsubscribedAt: true,
  bouncedAt: true,
  score: true,
  scoreFit: true,
  scoreEngagement: true,
  scoreBreakdown: true,
  scoreUpdatedAt: true,
  company: { select: { name: true } },
  tags: { select: { tag: { select: { name: true } } } },
} satisfies Prisma.ContactSelect;
type ScoredContact = Prisma.ContactGetPayload<{ select: typeof contactSelect }>;

/** Removed when done, so the same jobId can debounce the next burst; retried a little, then the sweep or the nightly pass catches up. */
const contactJobOptions = (contactId: string) => ({ jobId: `score-${contactId}`, delay: SCORE_DEBOUNCE_MS, attempts: 3, backoff: { type: "exponential" as const, delay: 15_000 }, removeOnComplete: true, removeOnFail: true });

type RuleRow = ScoringRuleFieldsT & { id: string; position: number; createdAt: Date };
type Loaded = { cfg: LeadScoringSettingsT; rules: ScoringRuleLike[] };
export type HotLead = { contactId: string; ownerId: string | null; name: string; score: number };

function factsOf(c: ScoredContact): ScoringFacts {
  return {
    jobTitle: c.jobTitle,
    company: c.company?.name ?? "",
    email: c.email ?? "",
    phone: c.phone ?? "",
    leadSource: c.leadSource,
    country: c.country,
    city: c.city,
    website: c.website,
    linkedinUrl: c.linkedinUrl,
    lifecycleStage: c.lifecycleStage,
    status: c.status,
    qualification: c.qualification,
    priority: c.priority,
    tags: c.tags.map((t) => t.tag.name),
    custom: c.customFields && typeof c.customFields === "object" && !Array.isArray(c.customFields) ? (c.customFields as Record<string, unknown>) : {},
  };
}

const nameOf = (c: Pick<ScoredContact, "fullName" | "firstName" | "lastName" | "email">) => c.fullName || [c.firstName, c.lastName].filter(Boolean).join(" ") || c.email || "A contact";

/**
 * Lead scoring (packages/shared/src/scoring.ts for the rules and math).
 * Settings in Workspace.settings.leadScoring; rules are ScoringRule rows.
 *
 * Scores are computed from what the database says now — rows counted in
 * each rule's window — never from an event log, so recomputing is always
 * safe and gives the same answer. Fresh by three paths (the `scoring`
 * queue, scoring.processors.ts):
 *
 *   sweep     every minute: contacts with new Activity, DomainEvent,
 *             MessageEvent or Message rows (and changed calls, meetings,
 *             quotes) since the last sweep get a debounced recompute job
 *   nightly   contacts with engagement points are recomputed, so old
 *             events fall out of their windows (decay)
 *   all       on enabling, on a rule change, and "Recalculate all"
 *
 * While scoring is off nothing here writes Contact.score. Crossing the hot
 * threshold for the first time logs "Became a hot lead" on the timeline and
 * tells the owner; nothing is emitted to workflows.
 */
@Injectable()
export class ScoringService {
  private readonly log = new Logger("scoring");

  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly queues: Queues,
    private readonly redis: SharedRedis,
  ) {}

  read(settings: unknown): LeadScoringSettingsT {
    const raw = (settings as { leadScoring?: unknown } | null)?.leadScoring;
    const parsed = raw ? LeadScoringSettings.safeParse(raw) : null;
    return parsed?.success ? parsed.data : DEFAULT_LEAD_SCORING;
  }

  private dto(r: RuleRow) {
    return { id: r.id, name: r.name, category: r.category, field: r.field, op: r.op, value: r.value, event: r.event, points: r.points, maxPoints: r.maxPoints, decayDays: r.decayDays, active: r.active, position: r.position };
  }

  private rules(workspaceId: string) {
    return this.prisma.db.scoringRule.findMany({ where: { workspaceId }, orderBy: [{ position: "asc" }, { createdAt: "asc" }] }) as Promise<RuleRow[]>;
  }

  private async settingsOf(workspaceId: string) {
    const row = await this.prisma.db.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { settings: true } });
    return { raw: row.settings, cfg: this.read(row.settings) };
  }

  // ─── Settings and rules ────────────────────────────────────────────────────

  /** Settings, rules, and how many contacts are hot / warm / scored. */
  async overview(ctx: RequestContext) {
    const w = ws(ctx);
    const [{ cfg }, rules] = await Promise.all([this.settingsOf(w.id), this.rules(w.id)]);
    const base = { workspaceId: w.id, deletedAt: null, archivedAt: null };
    const [hot, warm, scored] = cfg.enabled
      ? await Promise.all([
          this.prisma.db.contact.count({ where: { ...base, score: { gte: cfg.hot } } }),
          this.prisma.db.contact.count({ where: { ...base, score: { gte: cfg.warm, lt: cfg.hot } } }),
          this.prisma.db.contact.count({ where: { ...base, scoreUpdatedAt: { not: null } } }),
        ])
      : [0, 0, 0];
    return { settings: cfg, rules: rules.map((r) => this.dto(r)), stats: { hot, warm, scored } };
  }

  async saveSettings(ctx: RequestContext, input: LeadScoringSettingsT) {
    const w = ws(ctx);
    const { raw, cfg: before } = await this.settingsOf(w.id);
    await this.prisma.db.workspace.update({ where: { id: w.id }, data: { settings: { ...((raw as object) ?? {}), leadScoring: input } as never } });
    await this.audit.record(ctx, { action: "workspace.lead_scoring_changed", targetType: "workspace", targetId: w.id, metadata: { enabled: input.enabled, hot: input.hot, warm: input.warm } });
    // Turned on: score everyone now. (Turned off: scores stay as they are, and are people's to edit again.)
    if (input.enabled && !before.enabled) await this.queueWorkspace(w.id, "all");
    return input;
  }

  async createRule(ctx: RequestContext, input: ScoringRuleInputT) {
    const w = ws(ctx);
    const existing = await this.prisma.db.scoringRule.aggregate({ where: { workspaceId: w.id }, _max: { position: true }, _count: { _all: true } });
    if (existing._count._all >= MAX_RULES) throw conflict(`A workspace can have up to ${MAX_RULES} scoring rules`);
    const row = await this.prisma.db.scoringRule.create({ data: { workspaceId: w.id, ...input, position: (existing._max.position ?? -1) + 1 } });
    await this.audit.record(ctx, { action: "scoring.rule_created", targetType: "scoring_rule", targetId: row.id, metadata: { name: row.name, points: row.points } });
    await this.rulesChanged(w.id);
    return this.dto(row as RuleRow);
  }

  async updateRule(ctx: RequestContext, id: string, patch: Partial<ScoringRuleFieldsT>) {
    const w = ws(ctx);
    if (!UUID.test(id)) throw notFound("That rule");
    const current = await this.prisma.db.scoringRule.findFirst({ where: { id, workspaceId: w.id } });
    if (!current) throw notFound("That rule");
    const merged = { ...(current as RuleRow), ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as RuleRow;
    const problem = scoringRuleProblem(merged);
    if (problem) throw badRequest(problem[1], { [problem[0]]: problem[1] });
    const { name, category, field, op, value, event, points, maxPoints, decayDays, active } = merged;
    const row = await this.prisma.db.scoringRule.update({ where: { id, workspaceId: w.id }, data: { name, category, field, op, value, event, points, maxPoints, decayDays, active } });
    await this.audit.record(ctx, { action: "scoring.rule_updated", targetType: "scoring_rule", targetId: id, metadata: { name, points, active } });
    await this.rulesChanged(w.id);
    return this.dto(row as RuleRow);
  }

  async removeRule(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    if (!UUID.test(id)) throw notFound("That rule");
    const res = await this.prisma.db.scoringRule.deleteMany({ where: { id, workspaceId: w.id } });
    if (!res.count) throw notFound("That rule");
    await this.audit.record(ctx, { action: "scoring.rule_deleted", targetType: "scoring_rule", targetId: id });
    await this.rulesChanged(w.id);
    return { deleted: true };
  }

  /** The rules in this order; any not listed keep their order after these. */
  async reorder(ctx: RequestContext, ids: string[]) {
    const w = ws(ctx);
    const rules = await this.rules(w.id);
    const known = new Set(rules.map((r) => r.id));
    if (ids.some((id) => !known.has(id))) throw badRequest("A rule in that order is not in this workspace", { ids: "Unknown rule" });
    const order = [...new Set(ids), ...rules.map((r) => r.id).filter((id) => !ids.includes(id))];
    await this.prisma.db.$transaction(order.map((id, position) => this.prisma.db.scoringRule.update({ where: { id, workspaceId: w.id }, data: { position } })));
    return (await this.rules(w.id)).map((r) => this.dto(r));
  }

  /** "Use recommended rules": add the recommended set (those missing by name), or replace every rule with it. */
  async useRecommended(ctx: RequestContext, replace: boolean) {
    const w = ws(ctx);
    await this.prisma.db.$transaction(async (tx) => {
      if (replace) await tx.scoringRule.deleteMany({ where: { workspaceId: w.id } });
      const have = replace ? [] : await tx.scoringRule.findMany({ where: { workspaceId: w.id }, select: { name: true, position: true } });
      const names = new Set(have.map((r) => r.name.trim().toLowerCase()));
      let position = have.reduce((m, r) => Math.max(m, r.position), -1);
      const missing = RECOMMENDED_SCORING_RULES.filter((r) => !names.has(r.name.toLowerCase()));
      if (have.length + missing.length > MAX_RULES) throw conflict(`A workspace can have up to ${MAX_RULES} scoring rules`);
      if (missing.length) await tx.scoringRule.createMany({ data: missing.map((r) => ({ workspaceId: w.id, ...r, position: ++position })) });
    });
    await this.audit.record(ctx, { action: "scoring.recommended_rules", targetType: "workspace", targetId: w.id, metadata: { replace } });
    await this.rulesChanged(w.id);
    return (await this.rules(w.id)).map((r) => this.dto(r));
  }

  private async rulesChanged(workspaceId: string) {
    const { cfg } = await this.settingsOf(workspaceId);
    if (cfg.enabled) await this.queueWorkspace(workspaceId, "all");
  }

  /** Recompute every contact in the workspace (the worker does it, in batches). At most once per RECALC_COOLDOWN_S. */
  async recalculate(ctx: RequestContext) {
    const w = ws(ctx);
    const { cfg } = await this.settingsOf(w.id);
    if (!cfg.enabled) throw badRequest("Turn lead scoring on first");
    const key = this.redis.key(`scoring:recalc:${w.id}`);
    const ok = await this.redis.client.set(key, String(Date.now()), "EX", RECALC_COOLDOWN_S, "NX");
    if (!ok) {
      const ttl = Math.max(1, await this.redis.client.ttl(key));
      throw tooMany(`Scores were recalculated a few minutes ago — try again in ${ttl > 90 ? `${Math.ceil(ttl / 60)} minutes` : `${ttl} seconds`}`);
    }
    await this.queueWorkspace(w.id, "all");
    const contacts = await this.prisma.db.contact.count({ where: { workspaceId: w.id, deletedAt: null } });
    await this.audit.record(ctx, { action: "scoring.recalculated", targetType: "workspace", targetId: w.id, metadata: { contacts } });
    return { queued: true, contacts };
  }

  /** One contact's score, its parts and why (the contact page's panel). */
  async contactScore(ctx: RequestContext, contactId: string) {
    const w = ws(ctx);
    if (!UUID.test(contactId)) throw notFound("That contact");
    const [c, { cfg }] = await Promise.all([
      this.prisma.db.contact.findFirst({
        where: { id: contactId, workspaceId: w.id, deletedAt: null, ...(ownershipScope(ctx) as Prisma.ContactWhereInput) },
        select: { id: true, score: true, scoreFit: true, scoreEngagement: true, scoreBreakdown: true, scoreUpdatedAt: true },
      }),
      this.settingsOf(w.id),
    ]);
    if (!c) throw notFound("That contact");
    return {
      enabled: cfg.enabled,
      hot: cfg.hot,
      warm: cfg.warm,
      score: c.score,
      band: scoreBand(c.score, cfg),
      fit: c.scoreFit,
      engagement: c.scoreEngagement,
      breakdown: (Array.isArray(c.scoreBreakdown) ? c.scoreBreakdown : []) as ScoreBreakdownItem[],
      updatedAt: c.scoreUpdatedAt,
    };
  }

  // ─── Queueing ──────────────────────────────────────────────────────────────

  /** A debounced recompute of one contact: while one is waiting, another add is a no-op. */
  async queueContact(workspaceId: string, contactId: string) {
    await this.queues.add(QUEUES.scoring, "contact", { workspaceId, contactId }, contactJobOptions(contactId));
  }

  /** `all`: every contact; `decay`: only those whose engagement points may have aged out. Adds within 5 s collapse into one job. */
  async queueWorkspace(workspaceId: string, mode: "all" | "decay") {
    const bucket = Math.floor(Date.now() / 5_000);
    await this.queues.add(QUEUES.scoring, "workspace", { workspaceId, mode }, { jobId: `score-ws-${workspaceId}-${mode}-${bucket}`, delay: 3_000, attempts: 3, removeOnComplete: true, removeOnFail: { age: 7 * DAY / 1000 } });
  }

  // ─── Worker side ───────────────────────────────────────────────────────────

  /** The settings and active rules, or null when the workspace does not score (off, suspended, gone). */
  private async load(workspaceId: string): Promise<Loaded | null> {
    const w = await this.prisma.db.workspace.findUnique({ where: { id: workspaceId }, select: { settings: true, status: true, deletedAt: true } });
    if (!w || w.deletedAt || w.status === "suspended") return null;
    const cfg = this.read(w.settings);
    if (!cfg.enabled) return null;
    const rules = (await this.rules(workspaceId)).filter((r) => r.active);
    return { cfg, rules };
  }

  /**
   * Recomputes these contacts and writes the ones whose score changed
   * (Contact.updatedAt is left alone: a score is not an edit). Hot-lead
   * crossings are logged here and announced into `hot`, or to the owners
   * at once when no collector is passed.
   */
  async recomputeContacts(workspaceId: string, contactIds: string[], pre?: Loaded | null, hot?: HotLead[]): Promise<{ updated: number; skipped?: boolean }> {
    const ids = [...new Set(contactIds)].filter((id) => UUID.test(id));
    if (!ids.length) return { updated: 0 };
    const loaded = pre === undefined ? await this.load(workspaceId) : pre;
    if (!loaded) return { updated: 0, skipped: true };
    const { cfg, rules } = loaded;
    const contacts = await this.prisma.db.contact.findMany({ where: { workspaceId, id: { in: ids }, deletedAt: null }, select: contactSelect });
    if (!contacts.length) return { updated: 0 };
    const counts = await this.signals(workspaceId, contacts, rules);
    const now = new Date();
    let updated = 0;
    const crossed: HotLead[] = [];
    for (const c of contacts) {
      const r = computeScore(rules, factsOf(c), counts.get(c.id) ?? {});
      const same = c.scoreUpdatedAt && r.total === c.score && r.fit === c.scoreFit && r.engagement === c.scoreEngagement && JSON.stringify(r.breakdown) === JSON.stringify(c.scoreBreakdown);
      if (same) continue;
      // Raw, so @updatedAt is not bumped (lists sorted by "last updated" should not reshuffle nightly).
      await this.prisma.db.$executeRaw`
        UPDATE "Contact" SET score = ${r.total}, "scoreFit" = ${r.fit}, "scoreEngagement" = ${r.engagement}, "scoreBreakdown" = ${JSON.stringify(r.breakdown)}::jsonb, "scoreUpdatedAt" = ${now}
        WHERE id = ${c.id}::uuid AND "workspaceId" = ${workspaceId}::uuid`;
      updated++;
      if (r.total >= cfg.hot && (c.score === null || c.score < cfg.hot)) crossed.push({ contactId: c.id, ownerId: c.ownerId, name: nameOf(c), score: r.total });
    }
    if (crossed.length) {
      const fresh = await this.firstTimeHot(workspaceId, crossed);
      if (hot) hot.push(...fresh);
      else await this.notifyHot(workspaceId, fresh);
    }
    return { updated };
  }

  /**
   * Of these crossings, the contacts never hot before: each gets a timeline
   * entry. Checked and written under a per-contact lock, so two overlapping
   * recomputes (a contact job and a workspace pass) cannot both count it.
   */
  private async firstTimeHot(workspaceId: string, crossed: HotLead[]): Promise<HotLead[]> {
    const before = await this.prisma.db.activity.findMany({ where: { workspaceId, contactId: { in: crossed.map((h) => h.contactId) }, type: "contact.score_hot" }, select: { contactId: true } });
    const seen = new Set(before.map((a) => a.contactId));
    const fresh: HotLead[] = [];
    await runAs({ type: "system", name: "Lead scoring", ref: "scoring" }, async () => {
      for (const h of crossed.filter((x) => !seen.has(x.contactId))) {
        const logged = await this.prisma.db.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`score-hot:${h.contactId}`}))`;
          if (await tx.activity.findFirst({ where: { workspaceId, contactId: h.contactId, type: "contact.score_hot" }, select: { id: true } })) return false;
          await this.activity.log({ workspaceId, contactId: h.contactId, type: "contact.score_hot", summary: `Became a hot lead (score ${h.score})`, data: { score: h.score } }, tx);
          return true;
        });
        if (logged) fresh.push(h);
      }
    });
    return fresh;
  }

  /** One notification per owner: the lead by name, or how many. Unowned leads tell nobody. */
  async notifyHot(workspaceId: string, leads: HotLead[]) {
    const byOwner = new Map<string, HotLead[]>();
    for (const h of leads) if (h.ownerId) byOwner.set(h.ownerId, [...(byOwner.get(h.ownerId) ?? []), h]);
    for (const [owner, list] of byOwner) {
      const one = list.length === 1;
      await this.notifications.notify(workspaceId, [owner], {
        type: "contact.score_hot",
        title: one ? `Hot lead: ${list[0]!.name}` : `${list.length} of your leads turned hot`,
        body: one ? `Lead score ${list[0]!.score}` : list.slice(0, 3).map((h) => h.name).join(", ") + (list.length > 3 ? "…" : ""),
        link: one ? `/w/${workspaceId}/contacts/${list[0]!.contactId}` : `/w/${workspaceId}/leads?owner=me`,
      });
    }
  }

  /** Every contact (`all`), or those with engagement points or never scored (`decay`), in batches; hot leads announced once at the end. */
  async recomputeWorkspace(workspaceId: string, mode: "all" | "decay") {
    const loaded = await this.load(workspaceId);
    if (!loaded) return { updated: 0, skipped: true };
    const hot: HotLead[] = [];
    const where: Prisma.ContactWhereInput = { workspaceId, deletedAt: null, ...(mode === "decay" ? { OR: [{ scoreEngagement: { not: 0 } }, { scoreUpdatedAt: null }] } : {}) };
    let cursor: string | undefined;
    let updated = 0;
    let seen = 0;
    for (;;) {
      const page = await this.prisma.db.contact.findMany({ where: cursor ? { AND: [where, { id: { gt: cursor } }] } : where, select: { id: true }, orderBy: { id: "asc" }, take: BATCH });
      if (!page.length) break;
      seen += page.length;
      updated += (await this.recomputeContacts(workspaceId, page.map((c) => c.id), loaded, hot)).updated;
      cursor = page.at(-1)!.id;
      if (page.length < BATCH) break;
    }
    await this.notifyHot(workspaceId, hot);
    if (updated) this.log.log(`workspace ${workspaceId}: ${mode} pass rescored ${updated} of ${seen} contact(s)`);
    return { updated, seen };
  }

  /** The nightly pass: a decay job per scoring workspace. */
  async nightly() {
    // Unscoped by necessity: finds every workspace that scores; each job carries its own workspaceId.
    const rows = await this.prisma.unscoped.workspace.findMany({ where: { deletedAt: null, status: "active", settings: { path: ["leadScoring", "enabled"], equals: true } }, select: { id: true } });
    for (const w of rows) await this.queueWorkspace(w.id, "decay");
    return { workspaces: rows.length };
  }

  /**
   * Finds contacts something happened to since the last sweep and queues a
   * recompute for each. The cursor lives in Redis; losing it only means
   * the next sweep looks back ten minutes.
   */
  async sweep(now = new Date()) {
    const key = this.redis.key("scoring:sweep-cursor");
    const last = Number(await this.redis.client.get(key)) || now.getTime() - 10 * 60_000;
    const since = new Date(Math.min(last, now.getTime()) - SWEEP_OVERLAP_MS);
    // Unscoped by necessity: one pass across every workspace that scores; each job carries its workspaceId.
    const enabled = (await this.prisma.unscoped.workspace.findMany({ where: { deletedAt: null, status: "active", settings: { path: ["leadScoring", "enabled"], equals: true } }, select: { id: true } })).map((w) => w.id);
    let queued = 0;
    if (enabled.length) {
      const floor = uuidFloor(since);
      const inWs = (col: string) => Prisma.sql`${Prisma.raw(col)} IN (${Prisma.join(enabled.map((id) => Prisma.sql`${id}::uuid`))})`;
      const rows = await this.prisma.unscoped.$queryRaw<{ workspaceId: string; contactId: string | null }[]>`
        SELECT DISTINCT "workspaceId"::text AS "workspaceId", "contactId" FROM (
          SELECT a."workspaceId", a."contactId"::text AS "contactId" FROM "Activity" a
            WHERE a.id >= ${floor}::uuid AND ${inWs('a."workspaceId"')} AND a."contactId" IS NOT NULL
          UNION ALL
          SELECT e."workspaceId", CASE WHEN e."subjectType" = 'contact' THEN e."subjectId" ELSE e.payload->>'contactId' END FROM "DomainEvent" e
            WHERE e.id >= ${floor}::uuid AND ${inWs('e."workspaceId"')}
          UNION ALL
          SELECT m."workspaceId", c."contactId"::text FROM "MessageEvent" me JOIN "Message" m ON m.id = me."messageId" JOIN "Conversation" c ON c.id = m."conversationId"
            WHERE me.id >= ${floor}::uuid AND ${inWs('me."workspaceId"')} AND c."contactId" IS NOT NULL
          UNION ALL
          SELECT m."workspaceId", c."contactId"::text FROM "Message" m JOIN "Conversation" c ON c.id = m."conversationId"
            WHERE m.id >= ${floor}::uuid AND ${inWs('m."workspaceId"')} AND c."contactId" IS NOT NULL
          UNION ALL
          SELECT q."workspaceId", q."contactId"::text FROM "Quote" q WHERE q."updatedAt" >= ${since} AND ${inWs('q."workspaceId"')} AND q."contactId" IS NOT NULL
          UNION ALL
          SELECT k."workspaceId", k."contactId"::text FROM "Call" k WHERE k."updatedAt" >= ${since} AND ${inWs('k."workspaceId"')} AND k."contactId" IS NOT NULL
          UNION ALL
          SELECT g."workspaceId", g."contactId"::text FROM "Meeting" g WHERE g."updatedAt" >= ${since} AND ${inWs('g."workspaceId"')} AND g."contactId" IS NOT NULL
        ) x
        LIMIT 100000`;
      const jobs = rows.filter((r) => r.contactId && UUID.test(r.contactId)).map((r) => ({ name: "contact", data: { workspaceId: r.workspaceId, contactId: r.contactId! }, opts: contactJobOptions(r.contactId!) }));
      for (let i = 0; i < jobs.length; i += 500) await this.queues.queue(QUEUES.scoring).addBulk(jobs.slice(i, i + 500));
      queued = jobs.length;
    }
    await this.redis.client.set(key, String(now.getTime()));
    return { workspaces: enabled.length, queued };
  }

  // ─── Engagement counts ─────────────────────────────────────────────────────

  /** Per contact, the count behind each engagement rule's signalKey(). */
  private async signals(workspaceId: string, contacts: ScoredContact[], rules: ScoringRuleLike[]) {
    const out = new Map<string, Record<string, number>>(contacts.map((c) => [c.id, {}]));
    const ids = contacts.map((c) => c.id);
    const done = new Set<string>();
    for (const r of rules) {
      if (r.category !== "engagement") continue;
      const key = signalKey(r);
      if (done.has(key)) continue;
      done.add(key);
      const since = r.decayDays ? new Date(Date.now() - r.decayDays * DAY) : null;
      const counts = await this.count(workspaceId, ids, contacts, r.event, since);
      for (const [id, n] of counts) {
        const row = out.get(id);
        if (row) row[key] = n;
      }
    }
    return out;
  }

  private async count(workspaceId: string, ids: string[], contacts: ScoredContact[], event: string, since: Date | null): Promise<Map<string, number>> {
    const from = since ?? new Date(0);
    const grouped = (rows: { contactId: string | null; _count: { _all: number } }[]) => new Map(rows.filter((r) => r.contactId).map((r) => [r.contactId!, r._count._all]));
    const flag = (at: (c: ScoredContact) => Date | null) => new Map(contacts.filter((c) => at(c) && at(c)! >= from).map((c) => [c.id, 1]));
    switch (event) {
      case "email.opened":
        return this.messages(workspaceId, ids, Prisma.sql`m.direction = 'outbound' AND m."openedAt" >= ${from}`);
      case "email.clicked":
        return this.messages(workspaceId, ids, Prisma.sql`m.direction = 'outbound' AND m."clickedAt" >= ${from}`);
      case "email.replied":
        return this.messages(workspaceId, ids, Prisma.sql`m.direction = 'inbound' AND NOT m."isAutoReply" AND m."createdAt" >= ${from}`);
      case "meeting.booked":
        return grouped(await this.prisma.db.meeting.groupBy({ by: ["contactId"], where: { workspaceId, contactId: { in: ids }, createdAt: { gte: from }, canceledAt: null, status: { not: "canceled" } }, _count: { _all: true } }));
      case "quote.viewed":
        return grouped(await this.prisma.db.quote.groupBy({ by: ["contactId"], where: { workspaceId, contactId: { in: ids }, deletedAt: null, firstViewedAt: { gte: from } }, _count: { _all: true } }));
      case "quote.accepted":
        return grouped(await this.prisma.db.quote.groupBy({ by: ["contactId"], where: { workspaceId, contactId: { in: ids }, deletedAt: null, acceptedAt: { gte: from } }, _count: { _all: true } }));
      case "marketing.opened":
        return grouped(await this.prisma.db.marketingSend.groupBy({ by: ["contactId"], where: { workspaceId, contactId: { in: ids }, openedAt: { gte: from } }, _count: { _all: true } }));
      case "marketing.clicked":
        return grouped(await this.prisma.db.marketingSend.groupBy({ by: ["contactId"], where: { workspaceId, contactId: { in: ids }, clickedAt: { gte: from } }, _count: { _all: true } }));
      case "lead.returning": {
        const rows = await this.prisma.db.domainEvent.groupBy({
          by: ["subjectId"],
          where: { workspaceId, type: "lead.imported", subjectType: "contact", subjectId: { in: ids }, occurredAt: { gte: from }, payload: { path: ["returning"], equals: true } },
          _count: { _all: true },
        });
        return new Map(rows.map((r) => [r.subjectId, r._count._all]));
      }
      case "contact.unsubscribed":
        return flag((c) => c.unsubscribedAt);
      case "contact.bounced":
        return flag((c) => c.bouncedAt);
      default: {
        if (!event.startsWith("call.outcome:")) return new Map();
        const outcome = event.slice("call.outcome:".length);
        return grouped(await this.prisma.db.call.groupBy({ by: ["contactId"], where: { workspaceId, contactId: { in: ids }, outcome, createdAt: { gte: from } }, _count: { _all: true } }));
      }
    }
  }

  /** Messages in these contacts' conversations matching `cond`, counted per contact. */
  private async messages(workspaceId: string, ids: string[], cond: Prisma.Sql) {
    const rows = await this.prisma.db.$queryRaw<{ contactId: string; n: number }[]>`
      SELECT c."contactId"::text AS "contactId", count(*)::int AS n
      FROM "Message" m JOIN "Conversation" c ON c.id = m."conversationId"
      WHERE m."workspaceId" = ${workspaceId}::uuid AND c."workspaceId" = ${workspaceId}::uuid
        AND c."contactId" IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))}) AND ${cond}
      GROUP BY 1`;
    return new Map(rows.map((r) => [r.contactId, Number(r.n)]));
  }
}
