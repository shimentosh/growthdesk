import { Injectable, Logger } from "@nestjs/common";
import { staleNoticeDue, type Staleness } from "@growthdesk/shared";
import { PrismaService } from "../prisma/prisma.service.js";
import { EventsService } from "../core/events.service.js";
import { ActivityService } from "../crm/activity.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { staleness } from "./progress.js";

/*
 * The hourly stale-deal sweep (QUEUES.sales, forecast.processors.ts). A deal
 * is stale when it is open and has gone longer than its stage's rotDays
 * without progress (progress.ts). The first time a stale spell is seen the
 * owner is told, the deal's timeline says so, and a `deal.stale` domain event
 * starts any workflows on that trigger — then staleNotifiedAt is set, so the
 * next sweep stays quiet. Any progress after that notice (moving the deal,
 * logging a call, a note…) ends the spell; going stale again is news again.
 */

type Candidate = { id: string; workspaceId: string; status: string; stageEnteredAt: Date; staleNotifiedAt: Date | null; rotDays: number };

const PAGE = 500;

@Injectable()
export class StaleDealsService {
  private readonly log = new Logger("stale-deals");

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
    private readonly activity: ActivityService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Finds newly stale deals in every workspace and announces each once. Returns how many were announced. */
  async sweep(now: Date = new Date()): Promise<number> {
    let announced = 0;
    let after = "00000000-0000-0000-0000-000000000000";
    const at = now.toISOString();
    for (;;) {
      // Unscoped: a scheduler discovering due work across every workspace. Only open deals that entered a stage
      // with a "stale after" longer ago than that can be stale; a page is keyed by id so a busy table never repeats.
      const page = await this.prisma.unscoped.$queryRaw<Candidate[]>`
        SELECT d.id, d."workspaceId", d.status::text AS status, d."stageEnteredAt", d."staleNotifiedAt", s."rotDays"
        FROM "Deal" d
        JOIN "PipelineStage" s ON s.id = d."stageId" AND s."workspaceId" = d."workspaceId"
        WHERE d.status = 'open' AND d."deletedAt" IS NULL AND s."rotDays" IS NOT NULL AND d.id > ${after}::uuid
          AND d."stageEnteredAt" < (${at}::timestamptz AT TIME ZONE 'UTC') - make_interval(days => s."rotDays")
        ORDER BY d.id ASC
        LIMIT ${PAGE}`;
      if (!page.length) break;
      after = page.at(-1)!.id;
      const byWorkspace = new Map<string, Candidate[]>();
      for (const c of page) byWorkspace.set(c.workspaceId, [...(byWorkspace.get(c.workspaceId) ?? []), c]);
      for (const [workspaceId, deals] of byWorkspace) {
        const stale = await staleness(this.prisma.db, workspaceId, deals.map((d) => ({ ...d, stage: { rotDays: d.rotDays } })), now);
        for (const d of deals) {
          const s = stale.get(d.id);
          if (!s || !staleNoticeDue(d.staleNotifiedAt, s.since)) continue;
          try {
            if (await this.announce(workspaceId, d, s, now)) announced += 1;
          } catch (e) {
            this.log.error(`could not announce stale deal ${d.id}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
      if (page.length < PAGE) break;
    }
    if (announced) await this.events.kick();
    return announced;
  }

  /** Claims the notice (so a parallel sweep cannot repeat it), writes the timeline entry and the event, then tells the owner. */
  private async announce(workspaceId: string, c: Candidate, s: Staleness, now: Date): Promise<boolean> {
    const deal = await this.prisma.db.$transaction(async (tx) => {
      const claimed = await tx.deal.updateMany({ where: { id: c.id, workspaceId, status: "open", deletedAt: null, staleNotifiedAt: c.staleNotifiedAt }, data: { staleNotifiedAt: now } });
      if (!claimed.count) return null;
      const d = await tx.deal.findFirstOrThrow({ where: { id: c.id, workspaceId }, select: { id: true, name: true, ownerId: true, contactId: true, companyId: true, stage: { select: { id: true, name: true } } } });
      const summary = `No progress for ${s.days} days in ${d.stage.name}`;
      await this.activity.log({ workspaceId, dealId: d.id, contactId: d.contactId, companyId: d.companyId, type: "deal.stale", summary: `Deal went stale: no progress for ${s.days} days in ${d.stage.name}`, data: { days: s.days, since: s.since, stageId: d.stage.id } }, tx);
      await this.events.emitIn(tx, {
        workspaceId,
        type: "deal.stale",
        subjectType: "deal",
        subjectId: d.id,
        payload: { dealId: d.id, contactId: d.contactId, ownerId: d.ownerId, stageId: d.stage.id, stage: d.stage.name, days: s.days, since: s.since },
      });
      return { ...d, summary };
    });
    if (!deal) return false;
    if (deal.ownerId) await this.notifications.notify(workspaceId, [deal.ownerId], { type: "deal.stale", title: `Deal going stale: ${deal.name}`, body: deal.summary, link: `/w/${workspaceId}/deals/${deal.id}` });
    return true;
  }
}
