import { Injectable } from "@nestjs/common";
import { ContactFilter, type DayLoad, emailDomain, localDay, normalizeEmail, normalizePhone, planStarts, zonedParts, zonedTime } from "@growthdesk/shared";
import type { Campaign, Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { ContactsService } from "../crm/contacts.service.js";
import { CrmExtrasService } from "../crm/crm-extras.service.js";
import { parseWith } from "../common/decorators.js";
import { ws, type RequestContext } from "../common/context.js";
import { type AudienceT, configOf, firstActionStep, readSchedule, readSettings } from "./campaign-config.js";

export const SKIP_REASONS = ["not_found", "deleted", "archived", "do_not_contact", "unsubscribed", "bounced", "suppressed", "no_email", "already_enrolled"] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];
export type Skipped = Partial<Record<SkipReason, number>>;

export const SKIP_LABELS: Record<SkipReason, string> = {
  not_found: "not in this workspace",
  deleted: "deleted",
  archived: "archived",
  do_not_contact: "marked do-not-contact",
  unsubscribed: "unsubscribed",
  bounced: "bounced",
  suppressed: "on the suppression list",
  no_email: "no email address",
  already_enrolled: "already enrolled",
};

const BATCH = 1000;

const chunks = <T>(list: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

/*
 * Who a campaign is for, who of them may be contacted, and putting them on
 * the clock. Shared by readiness, launch and manual enrollment so all three
 * apply exactly the same exclusions.
 */
@Injectable()
export class EnrollmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly contacts: ContactsService,
    private readonly extras: CrmExtrasService,
  ) {}

  /** Contact ids the audience names (before eligibility). A saved view or filter is resolved with the caller's visibility. */
  async candidates(ctx: RequestContext, audience: AudienceT | null): Promise<string[]> {
    if (!audience) return [];
    if (audience.type === "contacts") return [...new Set(audience.contactIds)];
    if (audience.type === "lists") {
      // Lead lists hold people at every stage; outreach only goes to leads. Someone who unsubscribed from a list is left out.
      const rows = await this.prisma.db.listMembership.findMany({
        where: { workspaceId: ws(ctx).id, listId: { in: audience.listIds }, status: { not: "unsubscribed" }, list: { archivedAt: null }, contact: { lifecycleStage: "lead" } },
        select: { contactId: true },
        orderBy: { createdAt: "asc" },
        take: 100_000,
      });
      return [...new Set(rows.map((r) => r.contactId))];
    }
    if (audience.type === "view") {
      const view = await this.extras.getView(ctx, audience.viewId);
      return this.contacts.idsFor(ctx, parseWith(ContactFilter, view.filters ?? {}));
    }
    return this.contacts.idsFor(ctx, audience.filter);
  }

  /** Whether the first acting step needs an email address. */
  static requiresEmail(steps: { type: string; config: unknown }[]): boolean {
    return firstActionStep(steps)?.type === "email";
  }

  /** Splits ids into those that may be contacted and counts of why the rest may not. Suppression is checked in one query per batch. */
  async eligible(workspaceId: string, ids: string[], requireEmail: boolean): Promise<{ eligible: string[]; skipped: Skipped }> {
    const skipped: Skipped = {};
    const skip = (r: SkipReason) => (skipped[r] = (skipped[r] ?? 0) + 1);
    const eligible: string[] = [];
    for (const batch of chunks([...new Set(ids)], 5000)) {
      const rows = await this.prisma.db.contact.findMany({
        where: { workspaceId, id: { in: batch } },
        select: { id: true, email: true, phone: true, deletedAt: true, archivedAt: true, doNotContact: true, unsubscribedAt: true, bouncedAt: true },
      });
      const byId = new Map(rows.map((r) => [r.id, r]));
      const open: typeof rows = [];
      for (const id of batch) {
        const c = byId.get(id);
        if (!c) skip("not_found");
        else if (c.deletedAt) skip("deleted");
        else if (c.archivedAt) skip("archived");
        else if (c.doNotContact) skip("do_not_contact");
        else if (c.unsubscribedAt) skip("unsubscribed");
        else if (c.bouncedAt) skip("bounced");
        else if (requireEmail && !c.email) skip("no_email");
        else open.push(c);
      }
      const emails = [...new Set(open.map((c) => normalizeEmail(c.email)).filter((v): v is string => Boolean(v)))];
      const domains = [...new Set(emails.map(emailDomain))];
      const phones = [...new Set(open.map((c) => normalizePhone(c.phone)).filter((v): v is string => Boolean(v)))];
      const or: Prisma.SuppressionWhereInput[] = [];
      if (emails.length) or.push({ kind: "email", value: { in: emails } }, { kind: "domain", value: { in: domains } });
      if (phones.length) or.push({ kind: "phone", value: { in: phones } });
      const hits = or.length ? await this.prisma.db.suppression.findMany({ where: { workspaceId, OR: or }, select: { kind: true, value: true } }) : [];
      const blocked = new Set(hits.map((h) => `${h.kind}:${h.value}`));
      for (const c of open) {
        const email = normalizeEmail(c.email);
        const phone = normalizePhone(c.phone);
        const isBlocked =
          (email && (blocked.has(`email:${email}`) || blocked.has(`domain:${emailDomain(email)}`))) || (phone && blocked.has(`phone:${phone}`));
        if (isBlocked) skip("suppressed");
        else eligible.push(c.id);
      }
    }
    return { eligible, skipped };
  }

  /**
   * New starts already booked or made, per local day in the campaign's zone:
   * enrollments still waiting for their first step (by when it is due), plus
   * the enrollments whose first step ran earlier today. `waiting: false`
   * leaves out the first group, for re-planning exactly those.
   */
  async dayLoads(workspaceId: string, campaign: Pick<Campaign, "id" | "schedule">, now: Date = new Date(), opts: { waiting?: boolean } = {}): Promise<Map<string, DayLoad>> {
    const tz = readSchedule(campaign.schedule).timezone;
    const p = zonedParts(now, tz);
    const todayStart = zonedTime(p.year, p.month, p.day, 0, 0, tz);
    const [waiting, [started]] = await Promise.all([
      opts.waiting === false
        ? Promise.resolve([])
        : this.prisma.db.$queryRaw<{ day: string; n: number; last: Date }[]>`
        SELECT to_char("nextRunAt" AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS day, count(*)::int AS n, max("nextRunAt") AS last
        FROM "Enrollment"
        WHERE "workspaceId" = ${workspaceId}::uuid AND "campaignId" = ${campaign.id}::uuid
          AND status = 'active' AND "stepRun" = 0 AND "nextRunAt" IS NOT NULL
        GROUP BY 1`,
      this.prisma.db.$queryRaw<{ n: number; last: Date | null }[]>`
        SELECT count(DISTINCT se."enrollmentId")::int AS n, max(se."startedAt") AS last
        FROM "StepExecution" se
        WHERE se."workspaceId" = ${workspaceId}::uuid AND se."campaignId" = ${campaign.id}::uuid AND se."startedAt" >= ${todayStart}
          AND NOT EXISTS (
            SELECT 1 FROM "StepExecution" p
            WHERE p."workspaceId" = se."workspaceId" AND p."enrollmentId" = se."enrollmentId" AND p."startedAt" < ${todayStart}
          )`,
    ]);
    const loads = new Map<string, DayLoad>(waiting.map((w) => [w.day, { count: w.n, last: w.last.getTime() }]));
    if (started?.n) {
      const today = localDay(now, tz);
      const load = loads.get(today) ?? { count: 0, last: Number.NEGATIVE_INFINITY };
      loads.set(today, { count: load.count + started.n, last: Math.max(load.last, started.last?.getTime() ?? load.last) });
    }
    return loads;
  }

  /**
   * Enrolls eligible contacts. Starts are planned so at most
   * `dailyNewLimit` contacts begin per local day (in the campaign's zone),
   * `gapSeconds` apart, each inside the send window (planStarts). The days
   * already holding starts — waiting enrollments and today's first steps —
   * count against the limit, so a later batch fills in behind an earlier
   * one instead of landing on the same days, and closed days (a weekend)
   * take nobody instead of passing their share to the next open day.
   */
  async enroll(
    workspaceId: string,
    campaign: Campaign,
    contactIds: string[],
    opts: { source: "manual" | "automation" | "api"; enrolledById: string | null },
  ): Promise<{ enrolled: number; enrolledIds: string[]; skipped: Skipped }> {
    const steps = await this.prisma.db.sequenceStep.findMany({ where: { workspaceId, sequenceId: campaign.sequenceId }, orderBy: { position: "asc" } });
    const { eligible, skipped } = await this.eligible(workspaceId, contactIds, EnrollmentService.requiresEmail(steps));

    const already = new Set<string>();
    for (const batch of chunks(eligible, 5000)) {
      const rows = await this.prisma.db.enrollment.findMany({ where: { workspaceId, campaignId: campaign.id, contactId: { in: batch } }, select: { contactId: true } });
      for (const r of rows) already.add(r.contactId);
    }
    if (already.size) skipped.already_enrolled = (skipped.already_enrolled ?? 0) + already.size;
    const fresh = eligible.filter((id) => !already.has(id));

    const schedule = readSchedule(campaign.schedule);
    const settings = readSettings(campaign.settings);
    const now = new Date();
    const firstDelayMs = Math.max(0, Number(configOf(steps[0] ?? { config: {} }).delayMinutes ?? 0)) * 60_000;
    const floor = new Date(Math.max(now.getTime(), campaign.startAt?.getTime() ?? 0) + firstDelayMs);
    const starts = fresh.length
      ? planStarts(
          schedule,
          fresh.map(() => floor),
          { limit: settings.dailyNewLimit, gapMs: settings.gapSeconds * 1000, taken: await this.dayLoads(workspaceId, campaign, now) },
        )
      : [];

    let enrolled = 0;
    const enrolledIds: string[] = [];
    for (const [b, batch] of chunks(fresh, BATCH).entries()) {
      const res = await this.prisma.db.enrollment.createMany({
        data: batch.map((contactId, k) => ({
          workspaceId,
          campaignId: campaign.id,
          contactId,
          status: "active" as const,
          position: 0,
          stepRun: 0,
          nextRunAt: starts[b * BATCH + k]!,
          source: opts.source,
          enrolledById: opts.enrolledById,
        })),
        skipDuplicates: true,
      });
      enrolled += res.count;
      enrolledIds.push(...batch);
      // The timeline entry for each contact, written in bulk (one row per contact, as ActivityService.log would).
      await this.prisma.db.activity.createMany({
        data: batch.map((contactId) => ({
          workspaceId,
          contactId,
          actorId: opts.enrolledById,
          type: "campaign.enrolled",
          summary: `Enrolled in the campaign “${campaign.name}”`.slice(0, 500),
          data: { campaignId: campaign.id },
        })),
      });
    }
    const total = await this.prisma.db.enrollment.count({ where: { workspaceId, campaignId: campaign.id } });
    await this.prisma.db.campaign.updateMany({ where: { id: campaign.id, workspaceId }, data: { enrolledCount: total } });
    return { enrolled, enrolledIds, skipped };
  }

  /**
   * Re-plans the enrollments still waiting for their first step, keeping
   * their order and never moving one earlier. Run while the campaign is
   * paused, before it resumes: starts whose day passed during the pause
   * would otherwise all come due at once, and a changed limit, gap or
   * window applies to the queue from here on. Returns how many moved.
   */
  async replanWaiting(workspaceId: string, campaign: Pick<Campaign, "id" | "schedule" | "settings">, now: Date = new Date()): Promise<number> {
    const rows = await this.prisma.db.enrollment.findMany({
      where: { workspaceId, campaignId: campaign.id, status: "active", stepRun: 0, nextRunAt: { not: null } },
      select: { id: true, nextRunAt: true },
      orderBy: [{ nextRunAt: "asc" }, { id: "asc" }],
    });
    if (!rows.length) return 0;
    const settings = readSettings(campaign.settings);
    const starts = planStarts(
      readSchedule(campaign.schedule),
      rows.map((r) => new Date(Math.max(r.nextRunAt!.getTime(), now.getTime()))),
      { limit: settings.dailyNewLimit, gapMs: settings.gapSeconds * 1000, taken: await this.dayLoads(workspaceId, campaign, now, { waiting: false }) },
    );
    const moved = rows.flatMap((r, i) => (starts[i]!.getTime() !== r.nextRunAt!.getTime() ? [{ id: r.id, at: starts[i]! }] : []));
    let n = 0;
    for (const batch of chunks(moved, BATCH)) {
      // The stepRun/status guard leaves alone any row that started or stopped since it was read.
      n += await this.prisma.db.$executeRaw`
        UPDATE "Enrollment" e SET "nextRunAt" = v.at, "updatedAt" = now()
        FROM unnest(${batch.map((m) => m.id)}::uuid[], ${batch.map((m) => m.at)}::timestamptz[]) AS v(id, at)
        WHERE e.id = v.id AND e."workspaceId" = ${workspaceId}::uuid AND e."campaignId" = ${campaign.id}::uuid
          AND e.status = 'active' AND e."stepRun" = 0`;
    }
    return n;
  }
}
