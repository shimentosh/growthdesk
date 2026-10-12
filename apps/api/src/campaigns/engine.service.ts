import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import {
  type FlowStep,
  type Logic,
  TASK_TYPES,
  branchPosition,
  evaluate,
  isOpenNow,
  localDay,
  missingVariables,
  nextOpening,
  nextPosition,
  planStarts,
  renderTemplate,
  threadOf,
  variablesFor,
  waitBefore,
} from "@growthdesk/shared";
import type { Campaign, Enrollment, ExecutionStatus, Mailbox, Message, Prisma, SequenceStep, StepExecution, StepType, TaskType } from "../generated/prisma/client.js";
import { PrismaService, type Tx } from "../prisma/prisma.service.js";
import { Queues, QUEUES } from "../queues/queues.js";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { OutboundEmailService } from "../messaging/outbound-email.service.js";
import { trackingBase, unsubscribeUrl } from "../messaging/tracking.js";
import { SuppressionService } from "../crm/suppression.service.js";
import { ActivityService } from "../crm/activity.service.js";
import { EventsService } from "../core/events.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { CHAT_SENDER, type ChatSender } from "../channels/chat-sender.js";
import { EntitlementsService } from "../billing/entitlements.service.js";
import { PlatformSettingsService } from "../core/platform-settings.service.js";
import { replyTrackingProblem, replyTrackingStalled } from "../mailboxes/mailbox-upkeep.js";
import {
  ACTION_STEPS,
  MESSAGE_STEPS,
  type ScheduleT,
  type SettingsT,
  configOf,
  flowOf,
  readSchedule,
  readSettings,
  stripTokens,
  updateFieldTrouble,
} from "./campaign-config.js";
import { StepRulesService } from "./step-rules.service.js";
import { EnrollmentService } from "./enrollment.service.js";

/*
 * The durable sequence engine.
 *
 * The Enrollment row is the state machine; BullMQ only carries "look at this
 * enrollment now". Ported from LinkDesk's OutreachService (startCampaign,
 * tickCampaign, sendStep, park, the write-ahead send guard, refreshStats),
 * with the defects its audit found designed out:
 *
 *   - a job names the enrollment's `stepRun`; a job whose stepRun is not the
 *     row's is a no-op, so a duplicate or late job can never send the NEXT
 *     step (LinkDesk sent it);
 *   - every job re-reads the campaign and does nothing unless it is running,
 *     so jobs queued before a Pause never send (LinkDesk sent them);
 *   - work is claimed with a `lockedUntil` lease taken in SQL with the
 *     database clock, which expires on its own — nothing can be stuck
 *     "sending" forever, and app/DB clock skew cannot hide due work;
 *   - each action step writes a StepExecution row (unique per enrollment +
 *     stepRun) BEFORE it acts, holding the Message id it will send under, so
 *     a crashed or repeated run resolves what happened instead of resending;
 *   - a recipient's rejection never touches the mailbox's status — that
 *     judgement stays in OutboundEmailService (mailboxAtFault);
 *   - per-mailbox pacing is a slot reserved in one UPDATE (Mailbox.nextSendAt),
 *     so concurrent step jobs cannot all see "last send long ago" and burst;
 *   - a send whose outcome is unknown (email or chat) is recorded uncertain
 *     and never retried;
 *   - a step job that keeps throwing is counted (errorCount): it backs off,
 *     and after MAX_ERRORS the enrollment fails and the campaign owner is told,
 *     instead of the step being re-claimed forever with no trace;
 *   - a first step is checked against the campaign's dailyNewLimit when it
 *     runs, so a start the engine pushed back (mailbox full, pacing, kill
 *     switch) cannot land on a day that already had its quota of new starts;
 *   - with stop-on-reply on, a message step waits while the mailbox the thread
 *     went out from has not had its replies read recently, instead of sending
 *     a follow-up to someone whose reply nobody has seen yet.
 */

const LEASE_MINUTES = 5;
/** A "running" execution younger than this may still be in flight on another worker. */
const STALE_RUNNING_MS = 10 * 60_000;
const HOUR_MS = 3_600_000;
const MAX_ERRORS = 3;
const CLAIM_BATCH = 500;
/** Failed step jobs are kept this long for inspection (BullMQ removeOnFail). */
const KEEP_FAILED_JOBS = { age: 7 * 24 * 3600, count: 5000 };
/** At most one "steps are failing" notification per campaign in this window. */
const ENGINE_ALERT_WINDOW_MS = HOUR_MS;
/** How long a message step waits before looking again at a mailbox whose replies have not been read. */
const REPLY_SYNC_RECHECK_MS = 15 * 60_000;

const CONTACT_INCLUDE = {
  company: { select: { name: true, domain: true } },
  owner: { select: { id: true, name: true, email: true } },
  tags: { include: { tag: { select: { name: true } } } },
} satisfies Prisma.ContactInclude;
type ContactRow = Prisma.ContactGetPayload<{ include: typeof CONTACT_INCLUDE }>;

type Run = {
  workspaceId: string;
  e: Enrollment;
  campaign: Campaign;
  steps: SequenceStep[];
  flow: FlowStep[];
  contact: ContactRow | null;
  schedule: ScheduleT;
  settings: SettingsT;
  now: Date;
};

/** A step left half-done by an earlier run of the same stepRun, to be finished rather than started. */
type Retry = { position: number; exec: StepExecution; messageRowId: string | null };

export type StepOutcome = {
  outcome: "noop" | "busy" | "rescheduled" | "advanced" | "completed" | "stopped" | "failed";
  reason?: string;
  nextRunAt?: Date | null;
};

export type Claimed = { id: string; workspaceId: string; stepRun: number; errorCount: number };

class LostRace extends Error {
  constructor() {
    super("The enrollment changed while the step ran");
  }
}

const isUniqueViolation = (e: unknown) => (e as { code?: string } | null)?.code === "P2002";
const SENT_STATUSES = new Set(["sent", "delivered", "read"]);
const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

@Injectable()
export class EngineService {
  private readonly log = new Logger("engine");

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: Queues,
    private readonly outbound: OutboundEmailService,
    private readonly suppression: SuppressionService,
    private readonly activity: ActivityService,
    private readonly events: EventsService,
    private readonly notifications: NotificationsService,
    private readonly rules: StepRulesService,
    private readonly entitlements: EntitlementsService,
    private readonly platform: PlatformSettingsService,
    private readonly enrollment: EnrollmentService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Optional() @Inject(CHAT_SENDER) private readonly chat?: ChatSender,
  ) {}

  // ─── Tick: discover due work across tenants ───────────────────────────────

  async tick(): Promise<{ started: number; claimed: Claimed[]; completed: number; refreshed: number }> {
    // Scheduler discovery across every tenant; the row's own workspaceId scopes what follows.
    const started = await this.prisma.unscoped.$queryRaw<{ id: string; workspaceId: string }[]>`
      UPDATE "Campaign" SET status = 'running', "startedAt" = COALESCE("startedAt", now()), "updatedAt" = now()
      WHERE status = 'scheduled' AND "deletedAt" IS NULL AND "startAt" IS NOT NULL AND "startAt" <= now()
      RETURNING id, "workspaceId"`;
    const claimed = await this.claimDue();
    await this.enqueue(claimed);
    const completed = await this.completeFinished();
    const refreshed = await this.refreshActive();
    return { started: started.length, claimed, completed, refreshed };
  }

  /**
   * Takes a lease on due enrollments in one statement, judged by the
   * database clock. SKIP LOCKED lets concurrent ticks share the work; an
   * expired lease (a lost job, a dead worker) makes the row claimable again.
   */
  async claimDue(): Promise<Claimed[]> {
    // Cross-tenant due-work discovery (the scheduler's job): unscoped by design. Each claimed row
    // carries its workspaceId into the job, and the job re-scopes every query with it.
    return this.prisma.unscoped.$queryRaw<Claimed[]>`
      UPDATE "Enrollment" SET "lockedUntil" = now() + make_interval(mins => ${LEASE_MINUTES}::int)
      WHERE id IN (
        SELECT e.id FROM "Enrollment" e
        JOIN "Campaign" c ON c.id = e."campaignId"
        WHERE e.status = 'active' AND c.status = 'running' AND c."deletedAt" IS NULL
          AND e."nextRunAt" <= now()
          AND (e."lockedUntil" IS NULL OR e."lockedUntil" < now())
        ORDER BY e."nextRunAt"
        LIMIT ${CLAIM_BATCH}
        FOR UPDATE OF e SKIP LOCKED
      )
      RETURNING id, "workspaceId", "stepRun", "errorCount"`;
  }

  private async enqueue(claimed: Claimed[]) {
    if (!claimed.length) return;
    // BullMQ ignores an add whose jobId exists, so a re-claim while the job is still queued never doubles it.
    // Completed step jobs are removed, so the same (enrollment, stepRun) can be queued again after a reschedule.
    // Failed ones are kept for inspection; the id carries errorCount, which recordJobFailure bumps, so the
    // retry after a failure gets a fresh id instead of colliding with the kept job.
    await this.queues.queue(QUEUES.engine).addBulk(
      claimed.map((c) => ({
        name: "step",
        data: { workspaceId: c.workspaceId, enrollmentId: c.id, stepRun: c.stepRun },
        opts: {
          jobId: `${c.id}-${c.stepRun}-${c.errorCount}`,
          attempts: 3,
          backoff: { type: "exponential", delay: 15_000 },
          removeOnComplete: true,
          removeOnFail: KEEP_FAILED_JOBS,
        },
      })),
    );
  }

  /**
   * A step job that exhausted its attempts (an infrastructure error thrown out
   * of runStep). Counted on the enrollment: it waits and tries again, and
   * after MAX_ERRORS it fails, so a broken step is never re-claimed forever.
   * Conditional on the stepRun and errorCount read, so a duplicate report
   * counts once.
   */
  async recordJobFailure(workspaceId: string, enrollmentId: string, stepRun: number, error: string): Promise<"retry" | "failed" | "noop"> {
    const db = this.prisma.db;
    const e = await db.enrollment.findFirst({ where: { id: enrollmentId, workspaceId } });
    if (!e || e.stepRun !== stepRun || e.status !== "active") return "noop";
    const errorCount = e.errorCount + 1;
    const lastError = `The step could not run: ${error}`.slice(0, 1000);
    const final = errorCount >= MAX_ERRORS;
    const res = await db.enrollment.updateMany({
      where: { id: e.id, workspaceId, stepRun, status: "active", errorCount: e.errorCount },
      data: final
        ? { status: "failed", errorCount, lastError, stopReason: lastError.slice(0, 500), nextRunAt: null, lockedUntil: null, stepRun: { increment: 1 } }
        : // Back off: 15 min, then 30 min, before the next claim.
          { errorCount, lastError, nextRunAt: new Date(Date.now() + 15 * 60_000 * errorCount), lockedUntil: null },
    });
    if (!res.count) return "noop";
    this.log.error(`enrollment ${e.id} step ${e.position} failed (${errorCount}/${MAX_ERRORS}): ${error}`);
    const campaign = await db.campaign.findFirst({ where: { id: e.campaignId, workspaceId }, select: { id: true, name: true, ownerId: true, createdById: true } });
    if (!final || !campaign) return final ? "failed" : "retry";
    try {
      await this.activity.log({ workspaceId, contactId: e.contactId, type: "campaign.failed", summary: `Campaign “${campaign.name}” could not continue: ${lastError}`, data: { campaignId: campaign.id, enrollmentId: e.id } });
    } catch (err) {
      this.log.warn(`could not write the timeline: ${err instanceof Error ? err.message : String(err)}`);
    }
    const owner = campaign.ownerId ?? campaign.createdById;
    const link = `/w/${workspaceId}/campaigns/${campaign.id}`;
    const recent = owner
      ? await db.notification.findFirst({ where: { workspaceId, userId: owner, type: "campaign.step_failed", link, createdAt: { gt: new Date(Date.now() - ENGINE_ALERT_WINDOW_MS) } }, select: { id: true } })
      : null;
    if (owner && !recent) {
      await this.notifications.notify(workspaceId, [owner], {
        type: "campaign.step_failed",
        title: `Campaign steps are failing: ${campaign.name}`,
        body: `A step failed ${MAX_ERRORS} times in a row and the contact was taken out of the campaign. Last error: ${error.slice(0, 300)}`,
        link,
      });
    }
    return "failed";
  }

  private async completeFinished(): Promise<number> {
    // Cross-tenant discovery of running campaigns with nobody left to move; each is then closed with scoped queries.
    const rows = await this.prisma.unscoped.$queryRaw<{ id: string; workspaceId: string }[]>`
      SELECT c.id, c."workspaceId" FROM "Campaign" c
      WHERE c.status = 'running' AND c."deletedAt" IS NULL
        AND NOT EXISTS (SELECT 1 FROM "Enrollment" e WHERE e."campaignId" = c.id AND e.status IN ('active', 'paused'))
      LIMIT 200`;
    let n = 0;
    for (const r of rows) if (await this.completeCampaign(r.workspaceId, r.id)) n += 1;
    return n;
  }

  /** Marks a running campaign completed when no enrollment is left active, emitting campaign.completed in the same transaction. */
  async completeCampaign(workspaceId: string, campaignId: string): Promise<boolean> {
    await this.refreshStats(workspaceId, campaignId);
    const done = await this.prisma.db.$transaction(async (tx) => {
      const open = await tx.enrollment.count({ where: { workspaceId, campaignId, status: { in: ["active", "paused"] } } });
      if (open) return null;
      const res = await tx.campaign.updateMany({ where: { id: campaignId, workspaceId, status: "running", deletedAt: null }, data: { status: "completed", completedAt: new Date() } });
      if (!res.count) return null;
      const c = await tx.campaign.findFirstOrThrow({ where: { id: campaignId, workspaceId } });
      await this.events.emitIn(tx, {
        workspaceId,
        type: "campaign.completed",
        subjectType: "campaign",
        subjectId: campaignId,
        payload: {
          campaignId,
          name: c.name,
          enrolledCount: c.enrolledCount,
          sentCount: c.sentCount,
          replyCount: c.replyCount,
          bounceCount: c.bounceCount,
          failedCount: c.failedCount,
        },
      });
      return c;
    });
    if (!done) return false;
    await this.events.kick();
    const owner = done.ownerId ?? done.createdById;
    if (owner) {
      await this.notifications.notify(workspaceId, [owner], {
        type: "campaign.completed",
        title: `Campaign finished: ${done.name}`,
        body: `${done.enrolledCount} enrolled · ${done.sentCount} sent · ${done.replyCount} replied`,
        link: `/w/${workspaceId}/campaigns/${campaignId}`,
      });
    }
    return true;
  }

  private async refreshActive(): Promise<number> {
    // Cross-tenant discovery of campaigns whose counters may have moved; each refresh is workspace-scoped.
    const rows = await this.prisma.unscoped.$queryRaw<{ id: string; workspaceId: string }[]>`
      SELECT id, "workspaceId" FROM "Campaign"
      WHERE "deletedAt" IS NULL
        AND (status IN ('running', 'paused', 'scheduled') OR "completedAt" > now() - interval '1 hour' OR "canceledAt" > now() - interval '1 hour')
        AND ("statsUpdatedAt" IS NULL OR "statsUpdatedAt" < now() - interval '1 minute')
      ORDER BY "statsUpdatedAt" ASC NULLS FIRST
      LIMIT 50`;
    for (const r of rows) await this.refreshStats(r.workspaceId, r.id);
    return rows.length;
  }

  /** Recounts a campaign's counters from the rows behind them (LinkDesk refreshStats): the columns are a cache. */
  async refreshStats(workspaceId: string, campaignId: string): Promise<void> {
    const [row] = await this.prisma.db.$queryRaw<
      { enrolled: number; replied: number; failed: number; unsubscribed: number; sent: number; opened: number; clicked: number; bounced: number }[]
    >`
      SELECT
        (SELECT count(*)::int FROM "Enrollment" WHERE "workspaceId" = ${workspaceId}::uuid AND "campaignId" = ${campaignId}::uuid) AS enrolled,
        (SELECT count(*)::int FROM "Enrollment" WHERE "workspaceId" = ${workspaceId}::uuid AND "campaignId" = ${campaignId}::uuid AND "repliedAt" IS NOT NULL) AS replied,
        (SELECT count(*)::int FROM "Enrollment" WHERE "workspaceId" = ${workspaceId}::uuid AND "campaignId" = ${campaignId}::uuid AND status = 'failed') AS failed,
        (SELECT count(*)::int FROM "Enrollment" e JOIN "Contact" ct ON ct.id = e."contactId"
           WHERE e."workspaceId" = ${workspaceId}::uuid AND e."campaignId" = ${campaignId}::uuid AND ct."unsubscribedAt" >= e."enrolledAt") AS unsubscribed,
        m.sent, m.opened, m.clicked, m.bounced
      FROM (
        SELECT count(*) FILTER (WHERE "sentAt" IS NOT NULL)::int AS sent,
               count(*) FILTER (WHERE "openedAt" IS NOT NULL)::int AS opened,
               count(*) FILTER (WHERE "clickedAt" IS NOT NULL)::int AS clicked,
               count(*) FILTER (WHERE "bouncedAt" IS NOT NULL OR status = 'bounced')::int AS bounced
        FROM "Message"
        WHERE "workspaceId" = ${workspaceId}::uuid AND "campaignId" = ${campaignId}::uuid AND direction = 'outbound'
      ) m`;
    if (!row) return;
    await this.prisma.db.campaign.updateMany({
      where: { id: campaignId, workspaceId },
      data: {
        enrolledCount: row.enrolled,
        sentCount: row.sent,
        replyCount: row.replied,
        bounceCount: row.bounced,
        openCount: row.opened,
        clickCount: row.clicked,
        unsubscribeCount: row.unsubscribed,
        failedCount: row.failed,
        statsUpdatedAt: new Date(),
      },
    });
  }

  // ─── One step for one enrollment ──────────────────────────────────────────

  /**
   * Moves one enrollment on by one action (or parks it on a wait). Never
   * throws for an expected outcome; throws only for infrastructure errors,
   * so BullMQ retries those.
   */
  async runStep(workspaceId: string, enrollmentId: string, stepRun: number): Promise<StepOutcome> {
    const db = this.prisma.db;
    const e = await db.enrollment.findFirst({ where: { id: enrollmentId, workspaceId } });
    if (!e) return { outcome: "noop", reason: "The enrollment no longer exists" };
    if (e.stepRun !== stepRun) return { outcome: "noop", reason: "Stale job: the enrollment has moved on" };
    if (e.status !== "active") return { outcome: "noop", reason: `The enrollment is ${e.status}` };
    const campaign = await db.campaign.findFirst({ where: { id: e.campaignId, workspaceId } });
    if (!campaign || campaign.deletedAt || campaign.status !== "running") {
      // Paused (or gone): keep the place, give the lease back so a resume picks it up at once.
      await this.release(e);
      return { outcome: "noop", reason: "The campaign is not running" };
    }
    const run = await this.load(e, campaign);

    let retry: Retry | null = null;
    const prior = await db.stepExecution.findFirst({ where: { workspaceId, enrollmentId: e.id, stepRun: e.stepRun } });
    if (prior) {
      const settled = await this.settlePrior(run, prior);
      if ("outcome" in settled) return settled;
      retry = settled;
    }

    const stop = await this.stopReason(run);
    if (stop) return this.stop(run, stop);

    if (!isOpenNow(run.schedule, run.now)) {
      return this.reschedule(run, retry?.position ?? e.position, nextOpening(run.schedule, run.now), null);
    }
    // Not started yet (stepRun 0, nothing half-done): the first step counts against today's new starts.
    if (!retry && e.stepRun === 0) {
      const later = await this.dailyStartHold(run);
      if (later) return this.reschedule(run, e.position, later, null);
    }
    if (retry) return this.execute(run, retry.position, retry);
    return this.walk(run);
  }

  private async load(e: Enrollment, campaign: Campaign): Promise<Run> {
    const [steps, contact] = await Promise.all([
      this.prisma.db.sequenceStep.findMany({ where: { workspaceId: e.workspaceId, sequenceId: campaign.sequenceId }, orderBy: { position: "asc" } }),
      this.prisma.db.contact.findFirst({ where: { id: e.contactId, workspaceId: e.workspaceId }, include: CONTACT_INCLUDE }),
    ]);
    return {
      workspaceId: e.workspaceId,
      e,
      campaign,
      steps,
      flow: flowOf(steps),
      contact,
      schedule: readSchedule(campaign.schedule),
      settings: readSettings(campaign.settings),
      now: new Date(),
    };
  }

  /**
   * When today (in the campaign's zone) already has `dailyNewLimit` first
   * steps, the next start planStarts allows (as enroll would have placed it),
   * else null. Enrollment plans starts within the limit, but every engine
   * reschedule of a not-yet-started enrollment (mailbox full, plan limit,
   * kill switch, pacing) moves it without looking at the quota, so the check
   * is made here, when the first step is about to run. Concurrent first steps
   * of one campaign can each read the count before the others write theirs;
   * per-mailbox pacing keeps that overshoot to a handful.
   */
  private async dailyStartHold(run: Run): Promise<Date | null> {
    const { workspaceId, campaign, schedule, settings, now, e } = run;
    const tz = schedule.timezone;
    const today = localDay(now, tz);
    const started = await this.enrollment.dayLoads(workspaceId, campaign, now, { waiting: false });
    if ((started.get(today)?.count ?? 0) < settings.dailyNewLimit) return null;
    const taken = await this.enrollment.dayLoads(workspaceId, campaign, now);
    // This enrollment is one of the waiting starts it counts; it is the one being placed.
    const own = taken.get(localDay(e.nextRunAt ?? now, tz));
    if (own) own.count = Math.max(0, own.count - 1);
    const [at] = planStarts(schedule, [now], { limit: settings.dailyNewLimit, gapMs: settings.gapSeconds * 1000, taken });
    return at ?? null;
  }

  /**
   * Why a message step should wait for replies to be read, or null. Only with
   * stop-on-reply on and once a thread exists (the enrollment's sticky
   * mailbox): a reply goes to the mailbox that sent the first email, and a
   * reply nobody has read cannot stop the sequence. replyTrackingStalled
   * decides: IMAP on but no successful pass in the last SYNC_STALE_MS, which
   * is also what a failing sync turns into. IMAP off never holds — that was a
   * choice made at launch, which readiness warns about, and waiting would not
   * end.
   */
  private async replyHold(run: Run): Promise<string | null> {
    if (run.settings.stopOnReply === false || !run.e.mailboxId) return null;
    const box = await this.prisma.db.mailbox.findFirst({
      where: { id: run.e.mailboxId, workspaceId: run.workspaceId, deletedAt: null },
      select: { email: true, imapEnabled: true, imapHost: true, lastSyncedAt: true, syncError: true },
    });
    if (!box || !replyTrackingStalled(box, run.now)) return null;
    return replyTrackingProblem(box, run.now);
  }

  /** Resolves an execution an earlier run of this same stepRun left behind. */
  private async settlePrior(run: Run, prior: StepExecution): Promise<StepOutcome | Retry> {
    if (prior.status === "succeeded" || prior.status === "skipped" || prior.status === "uncertain") {
      // The step happened; only the advance was lost.
      return this.prisma.db.$transaction((tx) => this.advanceIn(tx, run, prior.position, {}, false)).then((r) => this.afterAdvance(run, r));
    }
    if (prior.status === "failed") return { position: prior.position, exec: prior, messageRowId: null };
    // "running"
    if (run.now.getTime() - prior.startedAt.getTime() < STALE_RUNNING_MS) {
      return { outcome: "busy", reason: "This step is already being run" };
    }
    if (!MESSAGE_STEPS.has(prior.stepType)) {
      // Internal steps commit their effect and their execution row together, so a running row means nothing happened.
      return { position: prior.position, exec: prior, messageRowId: null };
    }
    const messageRowId = typeof asObj(prior.result).messageRowId === "string" ? (asObj(prior.result).messageRowId as string) : null;
    const msg = messageRowId ? await this.prisma.db.message.findFirst({ where: { id: messageRowId, workspaceId: run.workspaceId } }) : null;
    if (!msg) {
      // The sender writes its Message row before it talks to the provider, so no row means nothing left.
      // Send again under the same id, which the sender itself also refuses to send twice.
      return { position: prior.position, exec: prior, messageRowId };
    }
    if (SENT_STATUSES.has(msg.status)) {
      return this.finish(run, prior.position, prior.id, "succeeded", { messageId: msg.id }, this.threadFields(run.e, msg));
    }
    if (msg.status === "failed") return { position: prior.position, exec: prior, messageRowId: null };
    // "sending" / "uncertain": it may have been delivered — never send it again.
    return this.finish(run, prior.position, prior.id, "uncertain", {
      messageId: msg.id,
      error: "The worker stopped mid-send; the message may have been delivered, so it was not sent again.",
    });
  }

  private async stopReason(run: Run): Promise<string | null> {
    const { contact, settings, e, workspaceId } = run;
    if (!contact || contact.deletedAt) return "The contact was deleted";
    if (contact.archivedAt) return "The contact was archived";
    if (contact.doNotContact) return "The contact is marked do-not-contact";
    if (contact.unsubscribedAt) return "The contact unsubscribed";
    if (contact.bouncedAt) return "The contact's email address bounced";
    const suppressed = await this.suppression.check(workspaceId, { email: contact.email, phone: contact.phone });
    if (suppressed) return suppressed;
    if (settings.stopOnReply !== false && (await this.hasReplied(run))) return "The contact replied";
    if (settings.stopOnMeeting) {
      const meeting = await this.prisma.db.meeting.findFirst({
        where: { workspaceId, contactId: contact.id, createdAt: { gt: e.enrolledAt }, status: { not: "canceled" } },
        select: { id: true },
      });
      if (meeting) return "A meeting was booked with the contact";
    }
    if (settings.stopOnDealWon) {
      const won = await this.prisma.db.deal.findFirst({
        where: {
          workspaceId,
          contactId: contact.id,
          status: "won",
          deletedAt: null,
          OR: [{ closedAt: { gte: e.enrolledAt } }, { closedAt: null, updatedAt: { gte: e.enrolledAt } }],
        },
        select: { id: true },
      });
      if (won) return "A deal with the contact was won";
    }
    return null;
  }

  /** Replied: the enrollment's stamp, or an inbound message on its thread since it enrolled (stamped on first sight). */
  private async hasReplied(run: Run): Promise<boolean> {
    const { e, workspaceId, settings } = run;
    if (e.repliedAt) return true;
    const inbound = await this.prisma.db.message.findFirst({
      where: {
        workspaceId,
        direction: "inbound",
        createdAt: { gte: e.enrolledAt },
        ...(settings.stopOnAutoReply ? {} : { isAutoReply: false }),
        OR: [{ enrollmentId: e.id }, ...(e.conversationId ? [{ conversationId: e.conversationId }] : [])],
      },
      select: { receivedAt: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });
    if (!inbound) return false;
    const at = inbound.receivedAt ?? inbound.createdAt;
    await this.prisma.db.enrollment.updateMany({ where: { id: e.id, workspaceId, repliedAt: null }, data: { repliedAt: at } });
    e.repliedAt = at;
    return true;
  }

  /**
   * Walks the routing steps (wait, branch, end) from the enrollment's
   * position to the next action — or parks on a step that has a wait of its
   * own. Every move goes forward, so the loop is bounded by the flow length.
   */
  private async walk(run: Run): Promise<StepOutcome> {
    let pos = run.e.position;
    for (let guard = 0; guard <= run.steps.length; guard++) {
      const step = run.steps[pos];
      if (!step) return this.complete(run, pos, "Finished the sequence");
      if (ACTION_STEPS.has(step.type)) return this.execute(run, pos, null);
      if (step.type === "end") return this.complete(run, pos, "Reached an end step");
      const to = step.type === "branch" ? branchPosition(run.flow, pos, evaluate(configOf(step).logic as Logic | undefined, await this.facts(run))) : nextPosition(run.flow, pos);
      if (to === null) return this.complete(run, pos, "Finished the sequence");
      const wait = waitBefore(run.flow, pos, to);
      if (wait > 0) return this.park(run, to, wait);
      pos = to;
    }
    return this.complete(run, pos, "Finished the sequence");
  }

  /** What a branch may ask about (shared/flow RULE_FIELDS): engagement on this enrollment's own messages, and the contact. */
  private async facts(run: Run): Promise<Record<string, string>> {
    const c = run.contact!;
    const sent = await this.prisma.db.message.findMany({
      where: { workspaceId: run.workspaceId, enrollmentId: run.e.id, direction: "outbound" },
      select: { openedAt: true, clickedAt: true },
    });
    const yes = (b: boolean) => (b ? "yes" : "no");
    const facts: Record<string, string> = {
      replied: yes(await this.hasReplied(run)),
      opened: yes(sent.some((m) => m.openedAt)),
      clicked: yes(sent.some((m) => m.clickedAt)),
      has_phone: yes(Boolean(c.phone)),
      has_email: yes(Boolean(c.email)),
      status: c.status,
      qualification: c.qualification,
      priority: c.priority,
      job_title: c.jobTitle,
      company: c.company?.name ?? "",
      country: c.country,
      tag: c.tags.map((t) => t.tag.name).join("\n"),
    };
    for (const [k, v] of Object.entries(asObj(c.customFields))) {
      if (v !== null && v !== undefined) facts[`custom.${k.toLowerCase()}`] = String(v);
    }
    return facts;
  }

  private async execute(run: Run, pos: number, retry: Retry | null): Promise<StepOutcome> {
    const step = run.steps[pos];
    if (!step) return this.complete(run, pos, "Finished the sequence");
    if (MESSAGE_STEPS.has(step.type)) {
      const hold = await this.replyHold(run);
      if (hold) {
        return this.reschedule(run, pos, nextOpening(run.schedule, new Date(run.now.getTime() + REPLY_SYNC_RECHECK_MS)), `Waiting for replies to be read before sending: ${hold}`);
      }
    }
    switch (step.type) {
      case "email":
        return this.emailStep(run, pos, retry);
      case "whatsapp":
      case "telegram":
        return this.chatStep(run, pos, retry);
      case "call_task":
      case "create_task":
        return this.taskStep(run, pos, retry);
      case "update_field":
        return this.updateFieldStep(run, pos, retry);
      case "assign_owner":
        return this.assignOwnerStep(run, pos, retry);
      case "notify":
        return this.notifyStep(run, pos, retry);
      default:
        return this.walk({ ...run, e: { ...run.e, position: pos } });
    }
  }

  // ─── Message steps ────────────────────────────────────────────────────────

  private async template(run: Run, templateId: unknown) {
    if (typeof templateId !== "string" || !templateId) return null;
    return this.prisma.db.template.findFirst({ where: { id: templateId, workspaceId: run.workspaceId } });
  }

  private async emailStep(run: Run, pos: number, retry: Retry | null): Promise<StepOutcome> {
    const { e, contact, settings, schedule, campaign, workspaceId } = run;
    const step = run.steps[pos]!;
    const cfg = configOf(step);
    if (!contact!.email) return this.record(run, pos, "skipped", { reason: "no_email" }, "The contact has no email address", retry);

    const template = await this.template(run, cfg.templateId);
    const subjectSrc = cfg.subject?.trim() ? cfg.subject : (template?.subject ?? "");
    const bodySrc = cfg.body?.trim() ? cfg.body : (template?.body ?? "");
    if (!bodySrc.trim()) return this.fail(run, pos, "The email step has no content (its template may have been deleted)", retry);

    // Sender: sticky once the thread is open, otherwise the campaign mailbox with the most room today.
    let mailbox: Mailbox | null = null;
    if (e.mailboxId) {
      const sticky = await this.prisma.db.mailbox.findFirst({ where: { id: e.mailboxId, workspaceId } });
      if (sticky && !sticky.deletedAt) {
        if (sticky.status !== "connected") {
          return this.reschedule(run, pos, nextOpening(schedule, new Date(run.now.getTime() + HOUR_MS)), `${sticky.email} is not connected; follow-ups wait for the mailbox that started the thread.`);
        }
        mailbox = sticky;
      }
      // A deleted sticky mailbox will never come back: fall through and pick another.
    }
    if (!mailbox) {
      const allowed = (await this.prisma.db.campaignMailbox.findMany({ where: { workspaceId, campaignId: campaign.id }, select: { mailboxId: true } })).map((m) => m.mailboxId);
      mailbox = await this.outbound.pickMailbox(workspaceId, allowed);
      if (!mailbox) {
        return this.reschedule(run, pos, nextOpening(schedule, new Date(run.now.getTime() + HOUR_MS)), "No connected campaign mailbox has capacity left right now.");
      }
    }

    const messageRowId = retry?.messageRowId ?? randomUUID();
    const vars = variablesFor(contact!, {
      senderName: mailbox.displayName,
      senderEmail: mailbox.email,
      unsubscribeUrl: unsubscribeUrl(trackingBase(this.config.PUBLIC_APP_URL), messageRowId),
    });
    const missing = missingVariables(`${subjectSrc}\n${bodySrc}`, vars);
    if (missing.length) return this.fail(run, pos, `Missing personalization: ${missing.join(", ")}`, retry);

    const opener = e.threadMessageId ? { subject: e.threadSubject ?? "", messageId: e.threadMessageId } : await this.opener(run);
    const thread = threadOf(renderTemplate(subjectSrc, vars), opener);
    const body = renderTemplate(bodySrc, vars);

    // Per-mailbox pacing: never two sends from one mailbox closer than its minimum delay.
    if (mailbox.minDelaySeconds > 0) {
      const readyAt = await this.reservePacingSlot(mailbox);
      if (readyAt) {
        const jitter = Math.floor(Math.random() * mailbox.minDelaySeconds * 1000);
        return this.reschedule(run, pos, nextOpening(schedule, new Date(readyAt.getTime() + jitter)), null);
      }
    }

    const exec = await this.writeAhead(run, pos, "email", retry, { messageRowId, mailboxId: mailbox.id, subject: thread.subject });
    if (!exec) return { outcome: "busy", reason: "Another worker is running this step" };

    const result = await this.outbound.send({
      workspaceId,
      mailboxId: mailbox.id,
      to: contact!.email,
      toName: contact!.fullName || undefined,
      subject: thread.subject,
      body,
      contactId: contact!.id,
      conversationId: thread.inReplyTo ? e.conversationId : null,
      campaignId: campaign.id,
      enrollmentId: e.id,
      templateId: template?.id ?? null,
      inReplyTo: thread.inReplyTo ?? null,
      references: thread.inReplyTo ?? null,
      tracking: { opens: settings.trackOpens, clicks: settings.trackClicks },
      unsubscribe: settings.unsubscribeLink,
      kind: "campaign",
      messageRowId,
    });

    switch (result.status) {
      case "sent":
        return this.finish(run, pos, exec.id, "succeeded", { messageId: result.messageRowId, result: { providerMessageId: result.providerMessageId } }, {
          ...(e.mailboxId === mailbox.id ? {} : { mailboxId: mailbox.id }),
          ...(e.threadMessageId ? {} : { threadMessageId: result.providerMessageId, threadSubject: thread.subject }),
          ...(e.conversationId ? {} : { conversationId: result.conversationId }),
        });
      case "deferred":
        // Nothing went out: forget the attempt (a later one mints a fresh id) and wait without advancing.
        await this.prisma.db.stepExecution.deleteMany({ where: { id: exec.id, workspaceId } });
        return this.reschedule(run, pos, nextOpening(schedule, new Date(Math.max(result.retryAt?.getTime() ?? run.now.getTime() + HOUR_MS, Date.now()))), result.reason);
      case "blocked":
        return this.blocked(run, exec.id, result.reason);
      case "uncertain":
        return this.finish(run, pos, exec.id, "uncertain", { messageId: result.messageRowId, error: result.reason });
      case "failed": {
        // The address does not exist (5.1.x): the sender recorded the bounce; stop as an asynchronous bounce would.
        if (result.failure?.badAddress) return this.bounced(run, exec.id, result.reason);
        // A 5xx for this recipient will not succeed later; a mailbox problem might.
        const permanent = result.failure ? result.failure.outcome === "rejected" && !result.failure.mailboxAtFault : false;
        return this.sendFailed(run, pos, exec.id, result.reason, permanent);
      }
    }
  }

  /**
   * Takes the mailbox's next send slot in one statement: succeeds only when
   * the slot is free (nextSendAt passed), and moves it minDelaySeconds on.
   * Returns null when this run may send now, else when the slot frees.
   */
  private async reservePacingSlot(mailbox: Mailbox): Promise<Date | null> {
    const taken = await this.prisma.db.$queryRaw<{ id: string }[]>`
      UPDATE "Mailbox" SET "nextSendAt" = now() + make_interval(secs => "minDelaySeconds")
      WHERE id = ${mailbox.id}::uuid AND "workspaceId" = ${mailbox.workspaceId}::uuid
        AND ("nextSendAt" IS NULL OR "nextSendAt" <= now())
      RETURNING id`;
    if (taken.length) return null;
    const row = await this.prisma.db.mailbox.findFirst({ where: { id: mailbox.id, workspaceId: mailbox.workspaceId }, select: { nextSendAt: true } });
    return row?.nextSendAt ?? new Date(Date.now() + mailbox.minDelaySeconds * 1000);
  }

  /** The first email this enrollment actually sent: what follow-ups reply to. */
  private async opener(run: Run): Promise<{ subject: string; messageId: string | null } | null> {
    const m = await this.prisma.db.message.findFirst({
      where: { workspaceId: run.workspaceId, enrollmentId: run.e.id, direction: "outbound", channel: "email", sentAt: { not: null } },
      orderBy: { sentAt: "asc" },
      select: { subject: true, providerMessageId: true },
    });
    return m ? { subject: m.subject, messageId: m.providerMessageId } : null;
  }

  private threadFields(e: Enrollment, msg: Message): Prisma.EnrollmentUpdateManyMutationInput & { mailboxId?: string; conversationId?: string } {
    if (msg.channel !== "email") return {};
    return {
      ...(e.mailboxId || !msg.mailboxId ? {} : { mailboxId: msg.mailboxId }),
      ...(e.threadMessageId || !msg.providerMessageId ? {} : { threadMessageId: msg.providerMessageId, threadSubject: msg.subject }),
      ...(e.conversationId ? {} : { conversationId: msg.conversationId }),
    };
  }

  private async sender(run: Run): Promise<{ senderName: string; senderEmail: string }> {
    const id = run.campaign.ownerId ?? run.campaign.createdById;
    const user = id ? await this.prisma.db.user.findUnique({ where: { id }, select: { name: true, email: true } }) : null;
    return { senderName: user?.name ?? "", senderEmail: user?.email ?? "" };
  }

  private async chatStep(run: Run, pos: number, retry: Retry | null): Promise<StepOutcome> {
    const { e, contact, campaign, workspaceId } = run;
    const step = run.steps[pos]!;
    const channel = step.type as "whatsapp" | "telegram";
    const label = channel === "whatsapp" ? "WhatsApp" : "Telegram";
    const cfg = configOf(step);
    if (!this.chat) return this.record(run, pos, "skipped", { reason: "unavailable" }, `${label} sending is not available on this installation`, retry);

    const template = await this.template(run, cfg.templateId);
    const bodySrc = cfg.body?.trim() ? cfg.body : (template?.body ?? "");
    if (!bodySrc.trim() && !template?.waTemplate) return this.fail(run, pos, `The ${label} step has no content`, retry);
    const vars = variablesFor(contact!, await this.sender(run));
    const missing = missingVariables(bodySrc, vars);
    if (missing.length) return this.fail(run, pos, `Missing personalization: ${missing.join(", ")}`, retry);

    // Same gates as campaign email (OutboundEmailService): the platform kill switch, an account restricted
    // for non-payment, and the plan's channel feature. All are temporary, so the step waits rather than fails.
    const settings = await this.platform.get();
    if (!settings.outreachEnabled) return this.reschedule(run, pos, nextOpening(run.schedule, new Date(run.now.getTime() + 15 * 60_000)), "Outreach is paused on this installation.");
    const workspace = await this.prisma.db.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { billingAccountId: true } });
    const ent = await this.entitlements.forAccount(workspace.billingAccountId);
    if (ent.access !== "full") return this.reschedule(run, pos, nextOpening(run.schedule, new Date(run.now.getTime() + HOUR_MS)), ent.reason);
    if (!ent.features[channel]) {
      return this.reschedule(run, pos, nextOpening(run.schedule, new Date(run.now.getTime() + 24 * HOUR_MS)), `${label} is not included in the ${ent.effectivePlan.name} plan. Upgrade to continue this step.`);
    }

    const messageRowId = retry?.messageRowId ?? randomUUID();
    const exec = await this.writeAhead(run, pos, channel, retry, { messageRowId });
    if (!exec) return { outcome: "busy", reason: "Another worker is running this step" };

    const result = await this.chat.send({
      workspaceId,
      channel,
      contactId: contact!.id,
      integrationId: typeof cfg.integrationId === "string" ? cfg.integrationId : null,
      body: renderTemplate(bodySrc, vars),
      template: template?.waTemplate ? { name: template.waTemplate, language: template.waLanguage || "en" } : null,
      campaignId: campaign.id,
      enrollmentId: e.id,
      messageRowId,
    });
    switch (result.status) {
      case "sent":
        return this.finish(run, pos, exec.id, "succeeded", { messageId: result.messageRowId });
      case "unavailable":
        return this.finish(run, pos, exec.id, "skipped", { error: result.reason, result: { reason: "unavailable" } });
      case "blocked":
        return this.blocked(run, exec.id, result.reason);
      case "uncertain":
        // It may have been delivered: never sent again (a retry under a fresh id would duplicate it).
        return this.finish(run, pos, exec.id, "uncertain", { messageId: result.messageRowId, error: result.reason });
      case "failed":
        return this.sendFailed(run, pos, exec.id, result.reason, false);
    }
  }

  /** The write-ahead execution row, created (or re-armed for a retry) before the step acts. Null when another run holds it. */
  private async writeAhead(run: Run, pos: number, type: StepType, retry: Retry | null, result: Record<string, unknown>): Promise<StepExecution | null> {
    const db = this.prisma.db;
    const attempts = (Number(asObj(retry?.exec.result).attempts) || 0) + 1;
    const data = { status: "running" as const, position: pos, stepType: type, startedAt: new Date(), finishedAt: null, error: "", result: { ...result, attempts } as Prisma.InputJsonValue };
    if (retry) {
      // Conditional on what was read, so two retriers cannot both take it.
      const res = await db.stepExecution.updateMany({ where: { id: retry.exec.id, workspaceId: run.workspaceId, status: retry.exec.status, startedAt: retry.exec.startedAt }, data });
      return res.count ? { ...retry.exec, ...data, result: data.result as Prisma.JsonValue } : null;
    }
    try {
      return await db.stepExecution.create({ data: { ...data, workspaceId: run.workspaceId, enrollmentId: run.e.id, campaignId: run.campaign.id, stepRun: run.e.stepRun } });
    } catch (err) {
      if (isUniqueViolation(err)) return null;
      throw err;
    }
  }

  private async sendFailed(run: Run, pos: number, execId: string, reason: string, permanent: boolean): Promise<StepOutcome> {
    const errorCount = run.e.errorCount + 1;
    const final = permanent || errorCount >= MAX_ERRORS;
    const nextRunAt = final ? null : nextOpening(run.schedule, new Date(run.now.getTime() + HOUR_MS));
    const lastError = reason.slice(0, 1000);
    const updated = await this.prisma.db.$transaction(async (tx) => {
      await tx.stepExecution.updateMany({ where: { id: execId, workspaceId: run.workspaceId }, data: { status: "failed", error: lastError, finishedAt: new Date() } });
      const res = await tx.enrollment.updateMany({
        where: { id: run.e.id, workspaceId: run.workspaceId, stepRun: run.e.stepRun, status: "active" },
        data: final
          ? { status: "failed", errorCount, lastError, stopReason: lastError, nextRunAt: null, lockedUntil: null, stepRun: { increment: 1 } }
          : { errorCount, lastError, position: pos, nextRunAt, lockedUntil: null },
      });
      return res.count > 0;
    });
    if (!updated) return { outcome: "noop", reason: "The enrollment changed while the step ran" };
    if (final) {
      await this.timeline(run, "campaign.failed", `Campaign “${run.campaign.name}” could not continue: ${lastError}`);
      return { outcome: "failed", reason: lastError, nextRunAt: null };
    }
    return { outcome: "rescheduled", reason: lastError, nextRunAt };
  }

  private async blocked(run: Run, execId: string, reason: string): Promise<StepOutcome> {
    const stopped = await this.prisma.db.$transaction(async (tx) => {
      await tx.stepExecution.updateMany({ where: { id: execId, workspaceId: run.workspaceId }, data: { status: "skipped", error: reason.slice(0, 1000), finishedAt: new Date() } });
      return this.stopIn(tx, run, reason, "stopped");
    });
    if (!stopped) return { outcome: "noop", reason: "The enrollment changed while the step ran" };
    await this.timeline(run, "campaign.stopped", `Stopped in “${run.campaign.name}”: ${reason}`);
    return { outcome: "stopped", reason, nextRunAt: null };
  }

  /** The recipient's address bounced at send time: the step failed and the enrollment stops, as for a bounce report. */
  private async bounced(run: Run, execId: string, reason: string): Promise<StepOutcome> {
    const stopped = await this.prisma.db.$transaction(async (tx) => {
      await tx.stepExecution.updateMany({ where: { id: execId, workspaceId: run.workspaceId }, data: { status: "failed", error: `Bounced: ${reason}`.slice(0, 1000), finishedAt: new Date() } });
      return this.stopIn(tx, run, "Bounced", "stopped");
    });
    if (!stopped) return { outcome: "noop", reason: "The enrollment changed while the step ran" };
    await this.timeline(run, "campaign.stopped", `Stopped in “${run.campaign.name}”: the email address bounced`);
    return { outcome: "stopped", reason: `Bounced: ${reason}`, nextRunAt: null };
  }

  // ─── Internal steps ───────────────────────────────────────────────────────

  /**
   * Runs an internal step's effect, its execution row and the advance in one
   * transaction: either all of it happened or none of it did, and the unique
   * (enrollment, stepRun) row makes a concurrent duplicate roll back.
   */
  private async internal(
    run: Run,
    pos: number,
    retry: Retry | null,
    work: (tx: Tx) => Promise<{ status: "succeeded" | "skipped"; result?: Record<string, unknown>; error?: string; after?: () => Promise<void> }>,
  ): Promise<StepOutcome> {
    const step = run.steps[pos]!;
    try {
      const out = await this.prisma.db.$transaction(async (tx) => {
        const done = await work(tx);
        const data = {
          status: done.status as ExecutionStatus,
          position: pos,
          stepType: step.type,
          result: (done.result ?? {}) as Prisma.InputJsonValue,
          error: (done.error ?? "").slice(0, 1000),
          finishedAt: new Date(),
        };
        if (retry) {
          const res = await tx.stepExecution.updateMany({ where: { id: retry.exec.id, workspaceId: run.workspaceId, status: retry.exec.status, startedAt: retry.exec.startedAt }, data });
          if (!res.count) throw new LostRace();
        } else {
          await tx.stepExecution.create({ data: { ...data, workspaceId: run.workspaceId, enrollmentId: run.e.id, campaignId: run.campaign.id, stepRun: run.e.stepRun } });
        }
        const adv = await this.advanceIn(tx, run, pos, {}, true);
        return { done, adv };
      });
      await out.done.after?.();
      return this.afterAdvance(run, out.adv);
    } catch (err) {
      if (err instanceof LostRace || isUniqueViolation(err)) return { outcome: "busy", reason: "Another worker ran this step" };
      throw err;
    }
  }

  /** Records a step as skipped (or done) without acting, and advances. */
  private record(run: Run, pos: number, status: "succeeded" | "skipped", result: Record<string, unknown>, error: string, retry: Retry | null) {
    return this.internal(run, pos, retry, async () => ({ status, result, error }));
  }

  private async taskStep(run: Run, pos: number, retry: Retry | null): Promise<StepOutcome> {
    const { contact, campaign, workspaceId, e } = run;
    const step = run.steps[pos]!;
    const cfg = configOf(step);
    const isCall = step.type === "call_task";
    const vars = variablesFor(contact!, await this.sender(run));
    const titleSrc = cfg.taskTitle?.trim() || (isCall ? "Call {{full_name}}" : "Follow up with {{full_name}}");
    const title = (stripTokens(renderTemplate(titleSrc, vars)) || (isCall ? "Call the contact" : "Follow up")).slice(0, 300);
    const descSrc = typeof cfg.description === "string" ? cfg.description : (cfg.body ?? "");
    const description = stripTokens(renderTemplate(descSrc, vars)).slice(0, 5000);
    const type: TaskType = isCall ? "call" : (TASK_TYPES as readonly string[]).includes(String(cfg.taskType)) ? (cfg.taskType as TaskType) : "follow_up";
    const dueAt = new Date(run.now.getTime() + Math.max(0, Number(cfg.taskDueMinutes ?? 0)) * 60_000);
    const assigneeId = contact!.ownerId ?? campaign.ownerId ?? campaign.createdById ?? null;
    return this.internal(run, pos, retry, async (tx) => {
      const task = await tx.task.create({
        data: { workspaceId, type, title, description, dueAt, assigneeId, contactId: contact!.id, campaignId: campaign.id, enrollmentId: e.id, source: "sequence" },
      });
      await this.activity.log({ workspaceId, contactId: contact!.id, type: "task.created", summary: `Task created by “${campaign.name}”: ${title}`, data: { taskId: task.id, campaignId: campaign.id } }, tx);
      return {
        status: "succeeded",
        result: { taskId: task.id },
        after: async () => {
          if (assigneeId) {
            await this.notifications.notify(workspaceId, [assigneeId], { type: "task.assigned", title: `New task: ${title}`, body: `From the campaign “${campaign.name}”`, link: `/w/${workspaceId}/tasks?task=${task.id}` });
          }
        },
      };
    });
  }

  private async updateFieldStep(run: Run, pos: number, retry: Retry | null): Promise<StepOutcome> {
    const { contact, campaign, workspaceId } = run;
    const cfg = configOf(run.steps[pos]!);
    const trouble = updateFieldTrouble(cfg.field, cfg.value, await this.rules.customKeys(workspaceId));
    if (trouble) return this.record(run, pos, "skipped", {}, `Field not updated: ${trouble}`, retry);
    const field = cfg.field!;
    const value = typeof cfg.value === "string" ? cfg.value : "";
    const data: Prisma.ContactUpdateManyMutationInput = field.startsWith("custom.")
      ? { customFields: { ...asObj(contact!.customFields), [field.slice(7)]: value } as Prisma.InputJsonValue }
      : field === "leadSource"
        ? { leadSource: value }
        : ({ [field]: value } as Prisma.ContactUpdateManyMutationInput);
    return this.internal(run, pos, retry, async (tx) => {
      await tx.contact.updateMany({ where: { id: contact!.id, workspaceId }, data });
      await this.activity.log({ workspaceId, contactId: contact!.id, type: "contact.updated", summary: `“${campaign.name}” set ${field} to ${value || "(blank)"}`, data: { field, value, campaignId: campaign.id } }, tx);
      await this.events.emitIn(tx, { workspaceId, type: "contact.updated", subjectType: "contact", subjectId: contact!.id, payload: { contactId: contact!.id, fields: [field], source: "sequence", campaignId: campaign.id } });
      return { status: "succeeded", result: { field, value }, after: () => this.events.kick() };
    });
  }

  private async assignOwnerStep(run: Run, pos: number, retry: Retry | null): Promise<StepOutcome> {
    const { contact, campaign, workspaceId } = run;
    const cfg = configOf(run.steps[pos]!);
    const strategy = cfg.strategy ?? (cfg.userId ? "user" : "round_robin");
    const isMember = async (id: string | null | undefined) =>
      Boolean(id && (await this.prisma.db.membership.findFirst({ where: { workspaceId, userId: id }, select: { id: true } })));
    let ownerId: string | null = null;
    if (strategy === "user") ownerId = (await isMember(cfg.userId)) ? cfg.userId! : null;
    else if (strategy === "campaign_owner") {
      const id = campaign.ownerId ?? campaign.createdById;
      ownerId = (await isMember(id)) ? id : null;
    } else {
      // Round robin: the selling member who owns the fewest contacts right now.
      const members = await this.prisma.db.membership.findMany({
        where: { workspaceId, role: { in: ["owner", "admin", "manager", "member"] } },
        orderBy: { createdAt: "asc" },
        select: { userId: true },
      });
      if (members.length) {
        const counts = await this.prisma.db.contact.groupBy({
          by: ["ownerId"],
          where: { workspaceId, deletedAt: null, ownerId: { in: members.map((m) => m.userId) } },
          _count: { _all: true },
        });
        const owned = new Map(counts.map((c) => [c.ownerId, c._count._all]));
        ownerId = members.map((m) => m.userId).reduce((best, id) => ((owned.get(id) ?? 0) < (owned.get(best) ?? 0) ? id : best));
      }
    }
    if (!ownerId) return this.record(run, pos, "skipped", { strategy }, "Nobody could be assigned", retry);
    const chosen = ownerId;
    return this.internal(run, pos, retry, async (tx) => {
      await tx.contact.updateMany({ where: { id: contact!.id, workspaceId }, data: { ownerId: chosen } });
      await this.activity.log({ workspaceId, contactId: contact!.id, type: "contact.assigned", summary: `“${campaign.name}” assigned the contact`, data: { ownerId: chosen, strategy, campaignId: campaign.id } }, tx);
      return { status: "succeeded", result: { ownerId: chosen, strategy } };
    });
  }

  private async notifyStep(run: Run, pos: number, retry: Retry | null): Promise<StepOutcome> {
    const { contact, campaign, workspaceId } = run;
    const cfg = configOf(run.steps[pos]!);
    const userId = cfg.userId ?? contact!.ownerId ?? campaign.ownerId ?? campaign.createdById ?? null;
    if (!userId) return this.record(run, pos, "skipped", {}, "Nobody to notify", retry);
    const vars = variablesFor(contact!, await this.sender(run));
    const message = (stripTokens(renderTemplate(cfg.message?.trim() || "{{full_name}} reached a step in a campaign", vars)) || "A contact reached a step in a campaign").slice(0, 300);
    return this.internal(run, pos, retry, async () => ({
      status: "succeeded",
      result: { userId, message },
      after: () =>
        this.notifications.notify(workspaceId, [userId], { type: "campaign.step", title: message, body: `Campaign: ${campaign.name}`, link: `/w/${workspaceId}/contacts/${contact!.id}` }),
    }));
  }

  // ─── State changes ────────────────────────────────────────────────────────

  /** Closes an execution row and advances, in one transaction. */
  private async finish(
    run: Run,
    pos: number,
    execId: string,
    status: ExecutionStatus,
    patch: { messageId?: string | null; error?: string; result?: Record<string, unknown> },
    extra: Prisma.EnrollmentUpdateManyMutationInput & { mailboxId?: string; conversationId?: string } = {},
  ): Promise<StepOutcome> {
    const adv = await this.prisma.db.$transaction(async (tx) => {
      const current = await tx.stepExecution.findFirst({ where: { id: execId, workspaceId: run.workspaceId }, select: { result: true } });
      await tx.stepExecution.updateMany({
        where: { id: execId, workspaceId: run.workspaceId },
        data: {
          status,
          finishedAt: new Date(),
          error: (patch.error ?? "").slice(0, 1000),
          ...(patch.messageId ? { messageId: patch.messageId } : {}),
          ...(patch.result ? { result: { ...asObj(current?.result), ...patch.result } as Prisma.InputJsonValue } : {}),
        },
      });
      return this.advanceIn(tx, run, pos, extra, false);
    });
    return this.afterAdvance(run, adv);
  }

  /**
   * Moves past the step at `pos`: to the next position (waiting what that
   * step waits, inside the send window) or to completion. Conditional on
   * the stepRun this run read, and bumps it, which retires every job that
   * still names the old one.
   */
  private async advanceIn(
    tx: Tx,
    run: Run,
    pos: number,
    extra: Prisma.EnrollmentUpdateManyMutationInput & { mailboxId?: string; conversationId?: string },
    strict: boolean,
  ): Promise<StepOutcome> {
    const next = nextPosition(run.flow, pos);
    const now = new Date();
    const nextRunAt = next === null ? null : nextOpening(run.schedule, new Date(now.getTime() + waitBefore(run.flow, pos, next) * 60_000));
    const res = await tx.enrollment.updateMany({
      where: { id: run.e.id, workspaceId: run.workspaceId, stepRun: run.e.stepRun, status: "active" },
      data: {
        ...extra,
        ...(next === null ? { status: "completed", completedAt: now, position: pos } : { position: next }),
        nextRunAt,
        stepRun: { increment: 1 },
        lockedUntil: null,
        errorCount: 0,
        lastError: "",
      },
    });
    if (!res.count) {
      if (strict) throw new LostRace();
      return { outcome: "noop", reason: "The enrollment changed while the step ran" };
    }
    return next === null ? { outcome: "completed", reason: "Finished the sequence", nextRunAt: null } : { outcome: "advanced", nextRunAt };
  }

  private async afterAdvance(run: Run, adv: StepOutcome): Promise<StepOutcome> {
    if (adv.outcome === "completed") await this.timeline(run, "campaign.completed", `Finished the campaign “${run.campaign.name}”`);
    return adv;
  }

  /** Parks the enrollment on a step that waits before it runs. */
  private async park(run: Run, to: number, waitMinutes: number): Promise<StepOutcome> {
    const nextRunAt = nextOpening(run.schedule, new Date(run.now.getTime() + waitMinutes * 60_000));
    const res = await this.prisma.db.enrollment.updateMany({
      where: { id: run.e.id, workspaceId: run.workspaceId, stepRun: run.e.stepRun, status: "active" },
      data: { position: to, nextRunAt, stepRun: { increment: 1 }, lockedUntil: null },
    });
    return res.count ? { outcome: "advanced", nextRunAt } : { outcome: "noop", reason: "The enrollment changed while the step ran" };
  }

  /** Tries again later at the same step, without advancing. */
  private async reschedule(run: Run, pos: number, at: Date, lastError: string | null): Promise<StepOutcome> {
    const res = await this.prisma.db.enrollment.updateMany({
      where: { id: run.e.id, workspaceId: run.workspaceId, stepRun: run.e.stepRun, status: "active" },
      data: { position: pos, nextRunAt: at, lockedUntil: null, ...(lastError !== null ? { lastError: lastError.slice(0, 1000) } : {}) },
    });
    return res.count ? { outcome: "rescheduled", reason: lastError ?? undefined, nextRunAt: at } : { outcome: "noop", reason: "The enrollment changed while the step ran" };
  }

  private async stopIn(tx: Tx, run: Run, reason: string, status: "stopped" | "failed"): Promise<boolean> {
    const res = await tx.enrollment.updateMany({
      where: { id: run.e.id, workspaceId: run.workspaceId, stepRun: run.e.stepRun, status: "active" },
      data: { status, stopReason: reason.slice(0, 500), ...(status === "failed" ? { lastError: reason.slice(0, 1000) } : {}), nextRunAt: null, lockedUntil: null, stepRun: { increment: 1 } },
    });
    return res.count > 0;
  }

  private async stop(run: Run, reason: string): Promise<StepOutcome> {
    const ok = await this.prisma.db.$transaction((tx) => this.stopIn(tx, run, reason, "stopped"));
    if (!ok) return { outcome: "noop", reason: "The enrollment changed while the step ran" };
    await this.timeline(run, "campaign.stopped", `Stopped in “${run.campaign.name}”: ${reason}`);
    return { outcome: "stopped", reason, nextRunAt: null };
  }

  /** Ends the enrollment as failed (a problem a retry cannot fix), recording the step's execution. */
  private async fail(run: Run, pos: number, reason: string, retry: Retry | null): Promise<StepOutcome> {
    const step = run.steps[pos]!;
    const ok = await this.prisma.db.$transaction(async (tx) => {
      const data = { status: "failed" as const, position: pos, stepType: step.type, error: reason.slice(0, 1000), finishedAt: new Date() };
      if (retry) await tx.stepExecution.updateMany({ where: { id: retry.exec.id, workspaceId: run.workspaceId }, data });
      else await tx.stepExecution.create({ data: { ...data, workspaceId: run.workspaceId, enrollmentId: run.e.id, campaignId: run.campaign.id, stepRun: run.e.stepRun } }).catch((err) => {
        if (!isUniqueViolation(err)) throw err;
      });
      return this.stopIn(tx, run, reason, "failed");
    });
    if (!ok) return { outcome: "noop", reason: "The enrollment changed while the step ran" };
    await this.timeline(run, "campaign.failed", `Campaign “${run.campaign.name}” could not continue: ${reason}`);
    return { outcome: "failed", reason, nextRunAt: null };
  }

  private async complete(run: Run, pos: number, why: string): Promise<StepOutcome> {
    const res = await this.prisma.db.enrollment.updateMany({
      where: { id: run.e.id, workspaceId: run.workspaceId, stepRun: run.e.stepRun, status: "active" },
      data: { status: "completed", completedAt: new Date(), position: pos, nextRunAt: null, lockedUntil: null, stepRun: { increment: 1 } },
    });
    if (!res.count) return { outcome: "noop", reason: "The enrollment changed while the step ran" };
    await this.timeline(run, "campaign.completed", `Finished the campaign “${run.campaign.name}”`);
    return { outcome: "completed", reason: why, nextRunAt: null };
  }

  private async release(e: Enrollment) {
    await this.prisma.db.enrollment.updateMany({ where: { id: e.id, workspaceId: e.workspaceId, stepRun: e.stepRun }, data: { lockedUntil: null } });
  }

  private async timeline(run: Run, type: string, summary: string) {
    if (!run.contact) return;
    try {
      await this.activity.log({ workspaceId: run.workspaceId, contactId: run.contact.id, type, summary, data: { campaignId: run.campaign.id, enrollmentId: run.e.id } });
    } catch (err) {
      // The timeline is a record of the change, not part of it.
      this.log.warn(`could not write the timeline: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
