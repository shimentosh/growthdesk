import { Injectable, Logger } from "@nestjs/common";
import type { PlatformDripTrigger } from "@growthdesk/shared";
import { Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { PlatformMailService } from "../platform-mail/platform-mail.service.js";
import { audienceFromWhere, marketingRule, userIdIn, utc } from "./audience-sql.js";
import { advance, enrollFloor, stepAt, TRIAL_ENDED_GRACE_MS, TRIAL_ENDING_LEAD_MS } from "./drip-schedule.js";
import { contentOf, marketingProblems, MarketingMailer } from "./marketing-mailer.js";

/*
 * Onboarding drips (worker, `drip.sweep` every 10 minutes; idempotent):
 *
 * 1. Enroll. For each active sequence, people whose trigger happened AFTER
 *    the sequence was activated (and within the last 7 days — drip-schedule.ts)
 *    and who pass the marketing rule right now. One INSERT … SELECT with
 *    ON CONFLICT (sequenceId, userId) DO NOTHING: a person is enrolled into a
 *    sequence at most once, however often the sweep runs.
 *    Trigger times are real timestamps:
 *      signup         User.createdAt
 *      verified       User.emailVerifiedAt
 *      trial_started  SubscriptionStatusChange → trialing (billing account owner)
 *      trial_ending   Subscription.trialEndsAt − 3 days, while still trialing
 *      trial_ended    Subscription.trialEndsAt + 1 hour, when not converted
 *
 * 2. Send due steps. Each enrollment is claimed with a conditional update
 *    (same nextStepPosition and nextRunAt as read) in the same transaction
 *    that writes its EmailLog row, then queued on `platform-mail` (jobId =
 *    log id). Two sweeps can never send the same step twice. Someone who no
 *    longer passes the marketing rule is stopped instead (unsubscribe and
 *    suppression also stop enrollments immediately).
 *
 * Activation time: PlatformDripSequence has no activatedAt column, so while a
 * sequence is active its updatedAt IS the activation time — SequencesService
 * never touches an active sequence without preserving updatedAt (see there).
 */

const DUE_PAGE = 200;
const MAX_PER_SWEEP = 2_000;

export function triggerSql(trigger: PlatformDripTrigger, floor: Date, now: Date): Prisma.Sql {
  const after = utc(floor);
  const until = utc(now);
  switch (trigger) {
    case "signup":
      return Prisma.sql`SELECT u0.id AS uid, u0."createdAt" AS at FROM "User" u0 WHERE u0."createdAt" > ${after} AND u0."createdAt" <= ${until}`;
    case "verified":
      return Prisma.sql`SELECT u0.id AS uid, u0."emailVerifiedAt" AS at FROM "User" u0 WHERE u0."emailVerifiedAt" > ${after} AND u0."emailVerifiedAt" <= ${until}`;
    case "trial_started":
      return Prisma.sql`SELECT ba."ownerId" AS uid, min(c.at) AS at FROM "SubscriptionStatusChange" c JOIN "BillingAccount" ba ON ba.id = c."billingAccountId"
        WHERE c."toStatus" = 'trialing' AND (c."fromStatus" IS NULL OR c."fromStatus" <> 'trialing') AND c.at > ${after} AND c.at <= ${until}
        GROUP BY ba."ownerId"`;
    case "trial_ending": {
      const lead = Prisma.sql`make_interval(secs => ${TRIAL_ENDING_LEAD_MS / 1000}::double precision)`;
      return Prisma.sql`SELECT ba."ownerId" AS uid, min(s."trialEndsAt" - ${lead}) AS at FROM "Subscription" s JOIN "BillingAccount" ba ON ba.id = s."billingAccountId"
        WHERE s.status = 'trialing' AND s."trialEndsAt" > ${until} AND s."trialEndsAt" - ${lead} > ${after} AND s."trialEndsAt" - ${lead} <= ${until}
        GROUP BY ba."ownerId"`;
    }
    case "trial_ended": {
      const grace = Prisma.sql`make_interval(secs => ${TRIAL_ENDED_GRACE_MS / 1000}::double precision)`;
      return Prisma.sql`SELECT ba."ownerId" AS uid, min(s."trialEndsAt" + ${grace}) AS at FROM "Subscription" s JOIN "BillingAccount" ba ON ba.id = s."billingAccountId"
        WHERE s."trialEndsAt" IS NOT NULL AND s.status NOT IN ('active', 'past_due') AND s."trialEndsAt" + ${grace} > ${after} AND s."trialEndsAt" + ${grace} <= ${until}
        GROUP BY ba."ownerId"`;
    }
  }
}

type Seq = { id: string; trigger: string; active: boolean; updatedAt: Date; steps: { id: string; position: number; delayHours: number; subject: string; preheader: string; blocks: unknown }[] };

@Injectable()
export class DripRunner {
  private readonly log = new Logger("platform-drips");

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: PlatformMailService,
    private readonly mailer: MarketingMailer,
  ) {}

  async sweep(now = new Date()) {
    const seqs = await this.prisma.db.platformDripSequence.findMany({ where: { active: true }, include: { steps: true } });
    let enrolled = 0;
    for (const seq of seqs) enrolled += await this.enroll(seq, now);
    const sent = await this.sendDue(now);
    return { sequences: seqs.length, enrolled, ...sent };
  }

  /** Enrolls everyone whose trigger fired since activation. Returns the number of new enrollments. */
  async enroll(seq: Seq, now: Date): Promise<number> {
    const { step: first } = stepAt(seq.steps, 1);
    if (!seq.active || !first) return 0;
    const floor = enrollFloor(seq.updatedAt, now);
    const trigger = triggerSql(seq.trigger as PlatformDripTrigger, floor, now);
    const stamp = utc(now);
    return this.prisma.db.$executeRaw`
      INSERT INTO "PlatformDripEnrollment" (id, "sequenceId", "userId", "nextStepPosition", "nextRunAt", status, "createdAt", "updatedAt")
      SELECT gen_random_uuid(), ${seq.id}::uuid, u.id, ${first.position}::int, t.at + make_interval(hours => ${first.delayHours}::int), 'active', ${stamp}, ${stamp}
      FROM (${trigger}) t JOIN "User" u ON u.id = t.uid JOIN "PlatformUserProfile" p ON p."userId" = u.id
      WHERE ${marketingRule()}
      ON CONFLICT ("sequenceId", "userId") DO NOTHING`;
  }

  async sendDue(now: Date): Promise<{ sent: number; stopped: number; completed: number }> {
    const out = { sent: 0, stopped: 0, completed: 0 };
    let handled = 0;
    const seen = new Set<string>();
    while (handled < MAX_PER_SWEEP) {
      const due = await this.prisma.db.platformDripEnrollment.findMany({
        where: { status: "active", nextRunAt: { lte: now }, sequence: { active: true }, id: { notIn: [...seen] } },
        orderBy: { nextRunAt: "asc" },
        take: DUE_PAGE,
        include: { sequence: { include: { steps: true } } },
      });
      if (!due.length) break;
      const people = await this.prisma.db.$queryRaw<{ id: string; email: string; name: string }[]>`
        SELECT u.id, u.email, u.name ${audienceFromWhere(null, [userIdIn([...new Set(due.map((e) => e.userId))])])}`;
      const eligible = new Map(people.map((p) => [p.id, p]));
      const brand = await this.mailer.brand();
      const env = await this.mailer.envelope();
      const route = await this.mail.route();
      for (const e of due) {
        seen.add(e.id);
        handled++;
        const r = await this.runOne(e, e.sequence.steps, eligible.get(e.userId) ?? null, { brand, env, provider: route.provider });
        if (r) out[r]++;
      }
      if (due.length < DUE_PAGE) break;
    }
    return out;
  }

  private async runOne(
    e: { id: string; userId: string; nextStepPosition: number; nextRunAt: Date | null },
    steps: Seq["steps"],
    person: { id: string; email: string; name: string } | null,
    ctx: { brand: Awaited<ReturnType<MarketingMailer["brand"]>>; env: { from: string; replyTo: string | undefined }; provider: string },
  ): Promise<"sent" | "stopped" | "completed" | null> {
    const same = { id: e.id, status: "active", nextStepPosition: e.nextStepPosition, nextRunAt: e.nextRunAt };
    const { step } = stepAt(steps, e.nextStepPosition);
    if (!step) {
      const r = await this.prisma.db.platformDripEnrollment.updateMany({ where: same, data: { status: "completed", nextRunAt: null } });
      return r.count ? "completed" : null;
    }
    if (!person) {
      const r = await this.prisma.db.platformDripEnrollment.updateMany({ where: same, data: { status: "stopped", nextRunAt: null } });
      return r.count ? "stopped" : null;
    }
    const content = contentOf(step);
    const sentAt = new Date();
    const next = advance(steps, step, sentAt);
    if (marketingProblems(content).length) {
      // Cannot happen through the admin (steps of an active sequence are validated); never send a broken email.
      this.log.warn(`drip step ${step.id} has problems; skipping it for enrollment ${e.id}`);
      await this.prisma.db.platformDripEnrollment.updateMany({ where: same, data: next });
      return null;
    }
    const draft = this.mailer.build(content, person, null, { brand: ctx.brand, from: ctx.env.from, replyTo: ctx.env.replyTo, kind: "drip", ref: step.id });
    const log = await this.prisma.db.$transaction(async (tx) => {
      const claimed = await tx.platformDripEnrollment.updateMany({ where: same, data: next });
      if (!claimed.count) return null;
      return tx.emailLog.create({
        data: { to: person.email, template: "drip", status: "queued", stream: "marketing", provider: ctx.provider, subject: draft.subject, fromAddress: ctx.env.from, userId: person.id, dripStepId: step.id },
      });
    });
    if (!log) return null;
    const mail = this.mailer.build(content, person, log.id, { brand: ctx.brand, from: ctx.env.from, replyTo: ctx.env.replyTo, kind: "drip", ref: step.id });
    try {
      await this.mail.enqueueLogged(log.id, { from: mail.from, to: mail.to, subject: mail.subject, html: mail.html, text: mail.text, replyTo: mail.replyTo, headers: mail.headers, template: "drip", stream: "marketing" });
    } catch (err) {
      // The row stays queued; platform-mail's sweep marks it failed if the job never appears.
      this.log.error(`could not queue drip step ${step.id} for ${person.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return "sent";
  }
}
