import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service.js";
import { QUEUES, Queues } from "../queues/queues.js";
import { PlatformMailService, type BatchItem } from "../platform-mail/platform-mail.service.js";
import { audienceFromWhere, userIdIn } from "./audience-sql.js";
import { normaliseFilter } from "./audiences.service.js";
import { contentOf, MarketingMailer } from "./marketing-mailer.js";

/*
 * Sending a broadcast (worker side, queue `platform-marketing`):
 *
 *   broadcast.start   scheduled → sending once scheduledAt has passed (a
 *                     delayed job, plus the 1-minute sweep as a safety net).
 *                     Snapshots the audience into PlatformBroadcastRecipient
 *                     once (row lock + totals.snapshotAt; ON CONFLICT DO
 *                     NOTHING), then queues one batch job per 100 recipients.
 *   broadcast.batch   recipients [batchNo*100, +100) in userId order — a
 *                     fixed slice, because the snapshot never changes. New
 *                     recipients are re-checked against the marketing rule at
 *                     send time (consent may have been withdrawn since the
 *                     snapshot) and get their EmailLog row BEFORE the send, so
 *                     a retry re-sends exactly the same rows and content under
 *                     the same Resend Idempotency-Key `${broadcastId}:${batchNo}`.
 *   broadcast.sweep   every minute: starts due broadcasts whose job was lost,
 *                     re-queues batches that still have pending recipients,
 *                     and finishes broadcasts with nothing left to send.
 *
 * Cancel (BroadcastsService.cancel) flips the status and marks the pending
 * recipients canceled; a batch checks the status again right before sending.
 */

export const BATCH_SIZE = 100;
const MARKETING_JOB = { removeOnComplete: true, removeOnFail: true } as const;

export const jobIds = {
  start: (id: string, at: Date) => `pb-start-${id}-${at.getTime()}`,
  batch: (id: string, batchNo: number) => `pb-batch-${id}-${batchNo}`,
};

type Totals = { recipients?: number; snapshotAt?: string; sent?: number; failed?: number; skipped?: number; canceled?: number; pending?: number };
export const totalsOf = (raw: unknown): Totals => (raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Totals) : {});

@Injectable()
export class BroadcastRunner {
  private readonly log = new Logger("platform-broadcasts");

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: Queues,
    private readonly mail: PlatformMailService,
    private readonly mailer: MarketingMailer,
  ) {}

  async queueStart(broadcastId: string, scheduledAt: Date) {
    const delay = Math.max(0, scheduledAt.getTime() - Date.now());
    await this.queues.add(QUEUES.platformMarketing, "broadcast.start", { broadcastId }, { ...MARKETING_JOB, jobId: jobIds.start(broadcastId, scheduledAt), delay });
  }

  /** Best effort: a stale start job is harmless anyway (start() re-checks status and time). */
  async dropStart(broadcastId: string, scheduledAt: Date | null) {
    if (!scheduledAt) return;
    const job = await this.queues.queue(QUEUES.platformMarketing).getJob(jobIds.start(broadcastId, scheduledAt));
    await job?.remove().catch(() => undefined);
  }

  async start(broadcastId: string): Promise<{ status: string; recipients?: number }> {
    const now = new Date();
    await this.prisma.db.platformBroadcast.updateMany({
      where: { id: broadcastId, status: "scheduled", scheduledAt: { lte: new Date(now.getTime() + 1000) } },
      data: { status: "sending", startedAt: now },
    });
    const b = await this.prisma.db.platformBroadcast.findUnique({ where: { id: broadcastId } });
    if (!b || b.status !== "sending") return { status: b?.status ?? "missing" };
    if (!totalsOf(b.totals).snapshotAt) {
      const ok = await this.snapshot(broadcastId);
      if (!ok) return { status: "failed" };
    }
    const queued = await this.queueBatches(broadcastId);
    const done = await this.finishIfDone(broadcastId);
    const after = await this.prisma.db.platformBroadcast.findUniqueOrThrow({ where: { id: broadcastId } });
    return { status: done ? "sent" : `sending (${queued} batches)`, recipients: totalsOf(after.totals).recipients };
  }

  /** Writes the recipient list once. False when the broadcast failed (its audience is gone). */
  private async snapshot(broadcastId: string): Promise<boolean> {
    const b = await this.prisma.db.platformBroadcast.findUniqueOrThrow({ where: { id: broadcastId }, include: { audience: true } });
    if (!b.audience) {
      await this.prisma.db.platformBroadcast.updateMany({
        where: { id: broadcastId, status: "sending" },
        data: { status: "failed", finishedAt: new Date(), error: "The audience was deleted before the broadcast started" },
      });
      return false;
    }
    const filter = normaliseFilter(b.audience.filter);
    await this.prisma.db.$transaction(async (tx) => {
      // Two starts (the delayed job and the sweep) serialise on the row; the second sees snapshotAt and does nothing.
      const locked = await tx.$queryRaw<{ totals: unknown }[]>`SELECT totals FROM "PlatformBroadcast" WHERE id = ${broadcastId}::uuid FOR UPDATE`;
      if (totalsOf(locked[0]?.totals).snapshotAt) return;
      await tx.$executeRaw`
        INSERT INTO "PlatformBroadcastRecipient" ("broadcastId", "userId", email, status)
        SELECT ${broadcastId}::uuid, u.id, u.email, 'pending' ${audienceFromWhere(filter)}
        ON CONFLICT DO NOTHING`;
      const recipients = await tx.platformBroadcastRecipient.count({ where: { broadcastId } });
      await tx.platformBroadcast.update({ where: { id: broadcastId }, data: { totals: { recipients, snapshotAt: new Date().toISOString() } } });
    });
    return true;
  }

  /** Queues every batch that still has pending recipients (job ids dedupe batches already waiting or running). */
  async queueBatches(broadcastId: string): Promise<number> {
    const rows = await this.prisma.db.$queryRaw<{ n: number }[]>`
      SELECT DISTINCT ((rn - 1) / ${BATCH_SIZE})::int AS n FROM (
        SELECT status, row_number() OVER (ORDER BY "userId") AS rn FROM "PlatformBroadcastRecipient" WHERE "broadcastId" = ${broadcastId}::uuid
      ) t WHERE status = 'pending' ORDER BY 1`;
    for (const { n } of rows) {
      await this.queues.add(
        QUEUES.platformMarketing,
        "broadcast.batch",
        { broadcastId, batchNo: n },
        { ...MARKETING_JOB, jobId: jobIds.batch(broadcastId, n), attempts: 6, backoff: { type: "exponential", delay: 10_000 } },
      );
    }
    return rows.length;
  }

  async batch(broadcastId: string, batchNo: number, final: boolean): Promise<{ status: string; sent?: number; failed?: number; skipped?: number }> {
    const b = await this.prisma.db.platformBroadcast.findUnique({ where: { id: broadcastId } });
    if (!b || b.status !== "sending") return { status: b?.status ?? "missing" };
    const slice = await this.prisma.db.platformBroadcastRecipient.findMany({
      where: { broadcastId },
      orderBy: { userId: "asc" },
      skip: batchNo * BATCH_SIZE,
      take: BATCH_SIZE,
    });
    const pending = slice.filter((r) => r.status === "pending");
    if (!pending.length) {
      await this.finishIfDone(broadcastId);
      return { status: "nothing_pending" };
    }

    // 1. Send-time re-check for recipients that have no log yet.
    const fresh = pending.filter((r) => !r.emailLogId);
    let skipped = 0;
    let eligible: { id: string; email: string; name: string }[] = [];
    if (fresh.length) {
      eligible = await this.prisma.db.$queryRaw<{ id: string; email: string; name: string }[]>`
        SELECT u.id, u.email, u.name ${audienceFromWhere(null, [userIdIn(fresh.map((r) => r.userId))])}`;
      const ok = new Set(eligible.map((u) => u.id));
      const out = fresh.filter((r) => !ok.has(r.userId)).map((r) => r.userId);
      if (out.length) {
        const r = await this.prisma.db.platformBroadcastRecipient.updateMany({ where: { broadcastId, userId: { in: out }, status: "pending" }, data: { status: "skipped" } });
        skipped = r.count;
      }
    }

    // 2. EmailLog rows first, so a retry sends the same rows (same ids in the tags → same body → Resend dedupes the key).
    const content = contentOf(b);
    const brand = await this.mailer.brand();
    const env = await this.mailer.envelope();
    const from = b.fromOverride || env.from;
    const route = await this.mail.route();
    const people = new Map(eligible.map((u) => [u.id, u]));
    if (eligible.length) {
      await this.prisma.db.$transaction(async (tx) => {
        for (const r of fresh) {
          const u = people.get(r.userId);
          if (!u) continue;
          const subject = this.mailer.build(content, u, null, { brand, from, replyTo: env.replyTo, kind: "broadcast", ref: b.id }).subject;
          const log = await tx.emailLog.create({
            data: { to: u.email, template: "broadcast", status: "queued", stream: "marketing", provider: route.provider, subject, fromAddress: from, userId: u.id, broadcastId: b.id },
          });
          await tx.platformBroadcastRecipient.update({ where: { broadcastId_userId: { broadcastId, userId: u.id } }, data: { emailLogId: log.id, email: u.email } });
        }
      });
    }

    // 3. The rows of this batch that still need sending.
    const assigned = await this.prisma.db.platformBroadcastRecipient.findMany({ where: { broadcastId, userId: { in: pending.map((r) => r.userId) }, status: "pending", emailLogId: { not: null } } });
    const logs = await this.prisma.db.emailLog.findMany({ where: { id: { in: assigned.map((r) => r.emailLogId!) } } });
    const logById = new Map(logs.map((l) => [l.id, l]));
    const names = new Map(
      (await this.prisma.db.user.findMany({ where: { id: { in: assigned.map((r) => r.userId) } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]),
    );
    const items: (BatchItem & { userId: string })[] = [];
    for (const r of assigned) {
      const log = logById.get(r.emailLogId!);
      if (!log) continue;
      if (log.status !== "queued") {
        // Sent (or failed) by an earlier attempt that died before recording it here.
        await this.setRecipient(broadcastId, r.userId, log.status === "failed" || log.status === "suppressed" ? "failed" : "sent");
        continue;
      }
      const mail = this.mailer.build(content, { id: r.userId, email: log.to, name: names.get(r.userId) ?? "" }, log.id, { brand, from: log.fromAddress || from, replyTo: env.replyTo, kind: "broadcast", ref: b.id });
      items.push({ logId: log.id, userId: r.userId, mail });
    }

    // 4. Canceled meanwhile? Stop before the provider call.
    const current = await this.prisma.db.platformBroadcast.findUnique({ where: { id: broadcastId }, select: { status: true } });
    if (current?.status !== "sending") return { status: current?.status ?? "missing", skipped };

    const outcomes = await this.mail.sendMarketingBatch(
      items.map(({ logId, mail }) => ({ logId, mail })),
      `${broadcastId}:${batchNo}`,
      final,
    );
    const byLog = new Map(outcomes.map((o) => [o.logId, o]));
    let sent = 0;
    let failed = 0;
    for (const item of items) {
      const o = byLog.get(item.logId);
      if (!o) continue;
      await this.setRecipient(broadcastId, item.userId, o.status);
      if (o.status === "sent") sent++;
      else failed++;
    }
    await this.finishIfDone(broadcastId);
    return { status: "ok", sent, failed, skipped };
  }

  private setRecipient(broadcastId: string, userId: string, status: "sent" | "failed") {
    return this.prisma.db.platformBroadcastRecipient.updateMany({ where: { broadcastId, userId, status: "pending" }, data: { status } });
  }

  /** Recipient tallies for totals and the progress bar. */
  async progress(broadcastId: string) {
    const groups = await this.prisma.db.platformBroadcastRecipient.groupBy({ by: ["status"], where: { broadcastId }, _count: { _all: true } });
    const of = (s: string) => groups.find((g) => g.status === s)?._count._all ?? 0;
    const p = { pending: of("pending"), sent: of("sent"), failed: of("failed"), skipped: of("skipped"), canceled: of("canceled") };
    return { ...p, total: p.pending + p.sent + p.failed + p.skipped + p.canceled };
  }

  /** sending → sent when nothing is pending. True when it finished now or already had. */
  async finishIfDone(broadcastId: string): Promise<boolean> {
    const b = await this.prisma.db.platformBroadcast.findUnique({ where: { id: broadcastId } });
    if (!b) return false;
    if (b.status === "sent") return true;
    if (b.status !== "sending" || !totalsOf(b.totals).snapshotAt) return false;
    const p = await this.progress(broadcastId);
    if (p.pending > 0) return false;
    const done = await this.prisma.db.platformBroadcast.updateMany({
      where: { id: broadcastId, status: "sending" },
      data: { status: "sent", finishedAt: new Date(), totals: { ...totalsOf(b.totals), recipients: p.total, sent: p.sent, failed: p.failed, skipped: p.skipped, canceled: p.canceled } },
    });
    if (done.count) this.log.log(`broadcast ${broadcastId} finished: ${p.sent} sent, ${p.failed} failed, ${p.skipped} skipped`);
    return true;
  }

  /** Every minute: the safety net for lost jobs. */
  async sweep(now = new Date()) {
    const due = await this.prisma.db.platformBroadcast.findMany({ where: { status: "scheduled", scheduledAt: { lte: now } }, select: { id: true, scheduledAt: true }, take: 50 });
    for (const b of due) await this.queueStart(b.id, b.scheduledAt!);
    const sending = await this.prisma.db.platformBroadcast.findMany({ where: { status: "sending" }, select: { id: true, totals: true, scheduledAt: true, startedAt: true }, take: 50 });
    for (const b of sending) {
      if (!totalsOf(b.totals).snapshotAt) {
        await this.queueStart(b.id, b.scheduledAt ?? b.startedAt ?? now);
        continue;
      }
      if (!(await this.finishIfDone(b.id))) await this.queueBatches(b.id);
    }
    return { started: due.length, sending: sending.length };
  }
}
