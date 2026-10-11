import { Inject, Injectable, Logger } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { PlatformSettingsService } from "../core/platform-settings.service.js";
import { BrandingService, DEFAULT_PRODUCT_NAME } from "../core/branding.service.js";
import { QUEUES, Queues } from "../queues/queues.js";
import { addressOf, displayNameOf, isProviderError, type OutgoingMail, tagValue } from "./provider.js";
import { ResendProvider } from "./resend.provider.js";
import { SmtpProvider } from "./smtp.provider.js";
import { PlatformMailRateLimiter } from "./rate-limiter.js";

/*
 * The platform's own mail pipeline (system mail to our users; later also
 * broadcasts and drips):
 *
 *   submit()   writes EmailLog(queued) — the record of intent — and queues a
 *              `platform-mail` job whose id is the log id (5 attempts,
 *              exponential backoff; docs/GAP_PLAN.md 6.5).
 *   runSend()  (the worker) re-reads the log, sends through the provider,
 *              and records sent + providerMessageId, or the error. A log that
 *              is no longer `queued` is never sent again.
 *   deliver()  picks the provider. Resend when it is selected and has a key;
 *              SMTP otherwise, and SMTP takes over ONLY when Resend refused our
 *              credentials (401/403 — nothing was sent). After a timeout or a
 *              5xx the message may have gone out, so we retry Resend with the
 *              same Idempotency-Key (the log id; Resend dedupes for 24 h)
 *              instead of risking a second copy through SMTP.
 *
 * Every Resend call first takes a token from the shared Redis bucket
 * (resendRateLimitPerSec); a 429 pauses the bucket for everyone.
 */

export type MailStream = "transactional" | "marketing";

export type SubmitInput = {
  to: string;
  subject: string;
  html: string;
  text: string;
  template: string;
  stream?: MailStream;
  userId?: string | null;
  templateVersionId?: string | null;
  headers?: Record<string, string>;
};

export type JobMail = Omit<OutgoingMail, "tags"> & { template: string; stream: MailStream };
export type SendJob = { logId: string; mail: JobMail };

export type DeliveryResult = { provider: "smtp" | "resend"; providerMessageId: string | null; fallbackReason: string | null };

export type SendNowResult = {
  ok: boolean;
  emailLogId: string;
  provider: "smtp" | "resend";
  providerMessageId: string | null;
  /** Why SMTP sent it although Resend is selected. */
  fallbackReason: string | null;
  error: string | null;
};

/** One platform-marketing email whose EmailLog row already exists (see sendMarketingBatch). */
export type BatchItem = { logId: string; mail: OutgoingMail };
export type BatchOutcome = { logId: string; status: "sent" | "failed"; error: string | null };

const RESEND_BUCKET = "resend";
/** SMTP sends of marketing batches are paced by the same per-second setting, in their own bucket. */
const SMTP_MARKETING_BUCKET = "smtp-marketing";
const INLINE_RATE_RETRIES = 3;

@Injectable()
export class PlatformMailService {
  private readonly log = new Logger("platform-mail");

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly settings: PlatformSettingsService,
    private readonly branding: BrandingService,
    private readonly queues: Queues,
    readonly resend: ResendProvider,
    readonly smtp: SmtpProvider,
    private readonly limiter: PlatformMailRateLimiter,
  ) {}

  /** From and Reply-To for a stream. The From display name is the brand's when the setting has none. */
  async envelope(stream: MailStream = "transactional"): Promise<{ from: string; replyTo: string | undefined }> {
    const s = await this.settings.get();
    const raw = (stream === "marketing" ? s.marketingFrom || s.transactionalFrom : s.transactionalFrom) || this.config.MAIL_FROM;
    const address = addressOf(raw);
    let name = displayNameOf(raw);
    if (!name || name === DEFAULT_PRODUCT_NAME) name = (await this.branding.get()).productName;
    const quoted = /[",;:<>@()[\]\\]/.test(name) ? `"${name.replace(/["\\]/g, "")}"` : name;
    return { from: `${quoted} <${address}>`, replyTo: s.replyTo || this.config.MAIL_REPLY_TO || undefined };
  }

  /** The provider a send would use right now, and why. */
  async route(): Promise<{ provider: "smtp" | "resend"; reason: string }> {
    const s = await this.settings.get();
    if (s.mailProvider !== "resend") return { provider: "smtp", reason: "SMTP is selected" };
    if (!(await this.resend.isConfigured())) return { provider: "smtp", reason: "Resend is selected but has no API key, so SMTP sends" };
    return { provider: "resend", reason: "Resend is selected" };
  }

  /** Sends one message now. Throws a classified ProviderError when it could not. */
  async deliver(mail: OutgoingMail, idempotencyKey: string): Promise<DeliveryResult> {
    const { provider } = await this.route();
    if (provider === "smtp") return { provider: "smtp", providerMessageId: (await this.smtp.send(mail)).providerMessageId, fallbackReason: null };
    const rate = (await this.settings.get()).resendRateLimitPerSec;
    for (let attempt = 0; ; attempt++) {
      try {
        await this.limiter.acquire(RESEND_BUCKET, rate);
        const r = await this.resend.send(mail, idempotencyKey);
        return { provider: "resend", providerMessageId: r.providerMessageId, fallbackReason: null };
      } catch (e) {
        if (!isProviderError(e)) throw e;
        if (e.kind === "rate_limited" && e.code !== "local_rate_limit") {
          await this.limiter.block(RESEND_BUCKET, e.retryAfterMs ?? 1000);
          if (attempt < INLINE_RATE_RETRIES) continue;
        }
        if (e.allowsFallback) {
          this.log.warn(`Resend refused our credentials (${e.message}); sending through SMTP instead`);
          const r = await this.smtp.send(mail);
          return { provider: "smtp", providerMessageId: r.providerMessageId, fallbackReason: e.message };
        }
        throw e;
      }
    }
  }

  /** Records the intent and queues the send. Never throws; false when nothing could be queued. */
  async submit(input: SubmitInput): Promise<{ logId: string | null; queued: boolean }> {
    const stream = input.stream ?? "transactional";
    let logId: string | null = null;
    try {
      const env = await this.envelope(stream);
      const route = await this.route();
      const log = await this.prisma.db.emailLog.create({
        data: {
          to: input.to,
          template: input.template,
          status: "queued",
          stream,
          provider: route.provider,
          subject: input.subject.slice(0, 998),
          fromAddress: env.from,
          userId: input.userId ?? null,
          templateVersionId: input.templateVersionId ?? null,
        },
      });
      logId = log.id;
      const job: SendJob = {
        logId: log.id,
        mail: { from: env.from, to: input.to, subject: input.subject, html: input.html, text: input.text, replyTo: env.replyTo, headers: input.headers, template: input.template, stream },
      };
      await this.queues.add(QUEUES.platformMail, "send", job as unknown as Record<string, unknown>, { jobId: log.id });
      return { logId, queued: true };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.log.error(`could not queue ${input.template} to ${input.to}: ${message}`);
      if (logId) await this.prisma.db.emailLog.update({ where: { id: logId }, data: { status: "failed", error: `Could not queue: ${message}`.slice(0, 500) } }).catch(() => undefined);
      return { logId, queued: false };
    }
  }

  /**
   * The worker's half: sends a queued log once. Retryable failures are
   * rethrown (BullMQ backs off) until `final`, when the log is marked failed.
   */
  async runSend(job: SendJob, final: boolean): Promise<{ status: string }> {
    const row = await this.prisma.db.emailLog.findUnique({ where: { id: job.logId } });
    if (!row) return { status: "missing" };
    if (row.status !== "queued") return { status: row.status };
    await this.prisma.db.emailLog.update({ where: { id: row.id }, data: { attempts: { increment: 1 } } });
    const { template, stream, ...mail } = job.mail;
    const tags = [
      { name: "log_id", value: row.id },
      { name: "template", value: tagValue(template) },
      { name: "stream", value: stream },
    ];
    try {
      const r = await this.deliver({ ...mail, tags }, row.id);
      await this.markSent(row.id, r);
      return { status: "sent" };
    } catch (e) {
      const message = (e instanceof Error ? e.message : String(e)).slice(0, 500);
      const retry = isProviderError(e) ? e.retryable : true;
      if (retry && !final) {
        await this.prisma.db.emailLog.update({ where: { id: row.id }, data: { error: message } }).catch(() => undefined);
        throw e;
      }
      this.log.error(`could not send ${template} to ${mail.to}: ${message}`);
      await this.prisma.db.emailLog.updateMany({ where: { id: row.id, status: "queued" }, data: { status: "failed", error: message } });
      return { status: "failed" };
    }
  }

  private async markSent(logId: string, r: DeliveryResult) {
    const data = {
      provider: r.provider,
      sentAt: new Date(),
      error: r.fallbackReason ? `Sent through SMTP: ${r.fallbackReason}`.slice(0, 500) : "",
    };
    // A webhook may already have moved the row on (and set the id); never move it back.
    const moved = await this.prisma.db.emailLog.updateMany({ where: { id: logId, status: "queued" }, data: { ...data, status: "sent" } });
    if (!moved.count) await this.prisma.db.emailLog.update({ where: { id: logId }, data: { provider: r.provider, error: data.error } });
    if (r.providerMessageId) {
      await this.prisma.db.emailLog
        .update({ where: { id: logId }, data: { providerMessageId: r.providerMessageId } })
        .catch((e: unknown) => this.log.warn(`could not store provider id ${r.providerMessageId}: ${e instanceof Error ? e.message : String(e)}`));
    }
  }

  /**
   * Sends right away (admin test sends) and reports the outcome; the log row
   * is written like any other. No retries: the person sees the error.
   */
  async sendNow(input: SubmitInput): Promise<SendNowResult> {
    const stream = input.stream ?? "transactional";
    const env = await this.envelope(stream);
    const route = await this.route();
    const log = await this.prisma.db.emailLog.create({
      data: {
        to: input.to,
        template: input.template,
        status: "queued",
        stream,
        provider: route.provider,
        subject: input.subject.slice(0, 998),
        fromAddress: env.from,
        userId: input.userId ?? null,
        templateVersionId: input.templateVersionId ?? null,
      },
    });
    const job: SendJob = {
      logId: log.id,
      mail: { from: env.from, to: input.to, subject: input.subject, html: input.html, text: input.text, replyTo: env.replyTo, headers: input.headers, template: input.template, stream },
    };
    try {
      await this.runSend(job, true);
    } catch (e) {
      // runSend(final) only throws for database errors.
      await this.prisma.db.emailLog.updateMany({ where: { id: log.id, status: "queued" }, data: { status: "failed", error: String(e).slice(0, 500) } });
    }
    const after = await this.prisma.db.emailLog.findUniqueOrThrow({ where: { id: log.id } });
    const ok = after.status !== "failed" && after.status !== "queued";
    const fallbackReason = after.error.startsWith("Sent through SMTP: ") ? after.error.slice("Sent through SMTP: ".length) : null;
    return {
      ok,
      emailLogId: after.id,
      provider: after.provider === "resend" ? "resend" : "smtp",
      providerMessageId: after.providerMessageId,
      fallbackReason,
      error: ok ? null : after.error || "The message could not be sent",
    };
  }

  /** Marks queued logs whose job vanished (Redis flushed, job removed) as failed, so they do not sit "queued" forever. */
  async failLostJobs(olderThanMs = 60 * 60_000): Promise<number> {
    const stale = await this.prisma.db.emailLog.findMany({
      // Broadcast rows are sent by platform-marketing batch jobs (not one job per row), which track them themselves.
      where: { status: "queued", broadcastId: null, createdAt: { lt: new Date(Date.now() - olderThanMs) } },
      select: { id: true },
      take: 500,
    });
    let failed = 0;
    const queue = this.queues.queue(QUEUES.platformMail);
    for (const row of stale) {
      const job = await queue.getJob(row.id);
      const state = job ? await job.getState() : "missing";
      if (state === "missing" || state === "unknown" || state === "completed" || state === "failed") {
        const r = await this.prisma.db.emailLog.updateMany({ where: { id: row.id, status: "queued" }, data: { status: "failed", error: "The send job was lost before it ran" } });
        failed += r.count;
      }
    }
    return failed;
  }
  // ─── Platform marketing (apps/api/src/platform-growth) ────────────────────

  /**
   * Queues the send of an EmailLog row the caller wrote itself — a drip step
   * claims its enrollment and writes the log in one transaction, then queues
   * it here. Same job as submit(): jobId = log id, runSend never sends twice.
   */
  async enqueueLogged(logId: string, mail: JobMail): Promise<void> {
    const job: SendJob = { logId, mail };
    await this.queues.add(QUEUES.platformMail, "send", job as unknown as Record<string, unknown>, { jobId: logId });
  }

  /**
   * Sends up to 100 broadcast emails whose EmailLog rows exist and are still
   * `queued` (the caller filters). Resend: one /emails/batch request through
   * the shared limiter, with `idempotencyKey` (`${broadcastId}:${batchNo}`) —
   * a retry with the same rows and content is deduped by Resend for 24 h.
   * SMTP (selected, unconfigured Resend, or Resend refusing our key): one
   * message at a time, each paced by the limiter and marked as it goes, so a
   * retry skips what already went out.
   *
   * Retryable failures (timeout, 5xx, quota, busy) are rethrown for BullMQ to
   * back off, until `final`, when the rows are marked failed. A refused batch
   * (4xx) fails its rows at once.
   */
  async sendMarketingBatch(items: BatchItem[], idempotencyKey: string, final: boolean): Promise<BatchOutcome[]> {
    if (!items.length) return [];
    if (items.length > 100) throw new Error("A marketing batch holds at most 100 emails");
    const ids = items.map((i) => i.logId);
    await this.prisma.db.emailLog.updateMany({ where: { id: { in: ids } }, data: { attempts: { increment: 1 } } });
    const tagged = items.map((i) => ({ logId: i.logId, mail: { ...i.mail, tags: [{ name: "log_id", value: i.logId }, ...(i.mail.tags ?? [])] } }));
    const { provider } = await this.route();
    if (provider === "smtp") return this.sendOneByOne(tagged, final, null);
    const rate = (await this.settings.get()).resendRateLimitPerSec;
    for (let attempt = 0; ; attempt++) {
      try {
        await this.limiter.acquire(RESEND_BUCKET, rate);
        const results = await this.resend.sendBatch(
          tagged.map((i) => i.mail),
          idempotencyKey,
        );
        for (const [n, item] of tagged.entries()) {
          await this.markSent(item.logId, { provider: "resend", providerMessageId: results[n]?.providerMessageId ?? null, fallbackReason: null });
        }
        return tagged.map((i) => ({ logId: i.logId, status: "sent" as const, error: null }));
      } catch (e) {
        if (!isProviderError(e)) throw e;
        if (e.kind === "rate_limited" && e.code !== "local_rate_limit") {
          await this.limiter.block(RESEND_BUCKET, e.retryAfterMs ?? 1000);
          if (attempt < INLINE_RATE_RETRIES) continue;
        }
        if (e.allowsFallback) {
          this.log.warn(`Resend refused our credentials (${e.message}); sending the batch through SMTP instead`);
          return this.sendOneByOne(tagged, final, e.message);
        }
        const message = e.message.slice(0, 500);
        if (e.retryable && !final) {
          await this.prisma.db.emailLog.updateMany({ where: { id: { in: ids }, status: "queued" }, data: { error: message } });
          throw e;
        }
        this.log.error(`could not send a marketing batch (${idempotencyKey}): ${message}`);
        await this.prisma.db.emailLog.updateMany({ where: { id: { in: ids }, status: "queued" }, data: { status: "failed", error: message } });
        return tagged.map((i) => ({ logId: i.logId, status: "failed" as const, error: message }));
      }
    }
  }

  private async sendOneByOne(items: BatchItem[], final: boolean, fallbackReason: string | null): Promise<BatchOutcome[]> {
    const rate = (await this.settings.get()).resendRateLimitPerSec;
    const out: BatchOutcome[] = [];
    for (const item of items) {
      const row = await this.prisma.db.emailLog.findUnique({ where: { id: item.logId }, select: { status: true, error: true } });
      if (!row) continue;
      if (row.status !== "queued") {
        out.push({ logId: item.logId, status: row.status === "failed" ? "failed" : "sent", error: row.status === "failed" ? row.error : null });
        continue;
      }
      try {
        await this.limiter.acquire(SMTP_MARKETING_BUCKET, rate);
        const r = await this.smtp.send(item.mail);
        await this.markSent(item.logId, { provider: "smtp", providerMessageId: r.providerMessageId, fallbackReason });
        out.push({ logId: item.logId, status: "sent", error: null });
      } catch (e) {
        const message = (e instanceof Error ? e.message : String(e)).slice(0, 500);
        const retry = isProviderError(e) ? e.retryable : true;
        if (retry && !final) {
          await this.prisma.db.emailLog.update({ where: { id: item.logId }, data: { error: message } }).catch(() => undefined);
          throw e;
        }
        await this.prisma.db.emailLog.updateMany({ where: { id: item.logId, status: "queued" }, data: { status: "failed", error: message } });
        out.push({ logId: item.logId, status: "failed", error: message });
      }
    }
    return out;
  }
}

