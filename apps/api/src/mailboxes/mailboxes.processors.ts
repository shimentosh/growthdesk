import { Inject, Injectable, Logger, Module, type OnModuleInit } from "@nestjs/common";
import { Processor, WorkerHost } from "@nestjs/bullmq";
import type { Job } from "bullmq";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { QUEUES, Queues } from "../queues/queues.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { MailboxesModule } from "./mailboxes.module.js";
import { MailboxesService } from "./mailboxes.service.js";
import { ImapSyncService, type SyncResult } from "./imap-sync.service.js";
import {
  ERROR_RECHECK_MS,
  HEALTH_SWEEP_EVERY_MS,
  MAX_SYNC_PASSES,
  SYNC_SWEEP_EVERY_MS,
  healthCheckDue,
  syncBlockedBySignIn,
} from "./mailbox-upkeep.js";

/*
 * The `mail` queue (owned by mailboxes). Sending is not queued here — the
 * campaign engine and the inbox call OutboundEmailService directly.
 *   sync-mailbox  {workspaceId, mailboxId} — reads new mail over IMAP
 *                 (ImapSyncService). Queued by connect / "Sync now" and by the
 *                 sweep below; the fixed job id `sync-<mailboxId>` means one
 *                 sync per mailbox at a time. Keeps reading while the server
 *                 has more, up to MAX_SYNC_PASSES passes.
 *   sync-due      every 60 s — queues a sync for every mailbox with reply
 *                 tracking on (active workspaces, not deleted, sign-in not
 *                 known broken).
 *   check-mailbox {workspaceId, mailboxId} — re-proves SMTP/IMAP sign-in
 *                 (MailboxesService.healthCheck); tells owners and admins when a
 *                 working mailbox stops working.
 *   check-due     every 15 min — queues checks: daily for working mailboxes,
 *                 hourly for mailboxes in error (so they recover on their own).
 * OAuth access tokens need no job: MailboxAuthService refreshes them on use.
 */

type MailboxJob = { workspaceId?: string; mailboxId?: string };

@Processor(QUEUES.mail, { concurrency: 5 })
export class MailProcessor extends WorkerHost {
  private readonly log = new Logger("mail-worker");

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailboxes: MailboxesService,
    private readonly sync: ImapSyncService,
    private readonly notifications: NotificationsService,
    private readonly queues: Queues,
  ) {
    super();
  }

  override async process(job: Job<MailboxJob>): Promise<unknown> {
    switch (job.name) {
      case "sync-mailbox": {
        const { workspaceId, mailboxId } = job.data;
        if (!workspaceId || !mailboxId) return null;
        return this.syncMailbox(workspaceId, mailboxId);
      }
      case "sync-due":
        return { queued: await this.queueDueSyncs() };
      case "check-mailbox": {
        const { workspaceId, mailboxId } = job.data;
        if (!workspaceId || !mailboxId) return null;
        return this.checkMailbox(workspaceId, mailboxId);
      }
      case "check-due":
        return { queued: await this.queueDueChecks() };
      default:
        this.log.warn(`unknown mail job ${job.name}`);
        return null;
    }
  }

  /** Passes over one mailbox until it is caught up (or the pass cap). Failures are recorded on the mailbox, not thrown. */
  async syncMailbox(workspaceId: string, mailboxId: string) {
    const total: { passes: number; read: number; filed: number; replies: number; bounces: number; failed: number; more: boolean; error?: string } = { passes: 0, read: 0, filed: 0, replies: 0, bounces: 0, failed: 0, more: false };
    let last: SyncResult;
    do {
      last = await this.sync.sync(workspaceId, mailboxId);
      total.passes += 1;
      total.read += last.read;
      total.filed += last.filed;
      total.replies += last.replies;
      total.bounces += last.bounces;
      total.failed += last.failed;
    } while (last.more && !last.error && total.passes < MAX_SYNC_PASSES);
    total.more = last.more;
    total.error = last.error;
    return total;
  }

  async queueDueSyncs(): Promise<number> {
    // Unscoped by necessity: the sweep discovers mailboxes across every workspace; each sync job re-scopes by workspaceId.
    const boxes = await this.prisma.unscoped.mailbox.findMany({
      where: { deletedAt: null, imapEnabled: true, imapHost: { not: "" }, status: { in: ["connected", "error"] }, workspace: { status: "active" } },
      select: { id: true, workspaceId: true, status: true, lastError: true },
    });
    let queued = 0;
    for (const b of boxes) {
      if (syncBlockedBySignIn(b)) continue;
      await this.mailboxes.enqueueSync(b.workspaceId, b.id);
      queued += 1;
    }
    return queued;
  }

  async checkMailbox(workspaceId: string, mailboxId: string) {
    const res = await this.mailboxes.healthCheck(workspaceId, mailboxId);
    if (!res) return null;
    const box = res.mailbox;
    if (res.before === "connected" && res.after === "error") {
      this.log.warn(`${box.email} failed its health check: ${box.lastError}`);
      await this.notifications.notifyRoles(workspaceId, ["owner", "admin"], {
        type: "mailbox.error",
        title: `${box.email} stopped working`,
        body: `${box.lastError}\n\nSending from this mailbox is paused until it passes a check again. Open the mailbox to update its sign-in, or verify it once the server is back.`,
        link: `/w/${workspaceId}/settings/mailboxes/${box.id}`,
        email: true,
      });
    } else if (res.before === "error" && res.after === "connected") {
      this.log.log(`${box.email} passed its health check and is connected again`);
      // Reply tracking may have been held back by the failed sign-in; catch up now.
      if (box.imapEnabled && box.imapHost) await this.mailboxes.enqueueSync(workspaceId, box.id);
    }
    return { before: res.before, after: res.after };
  }

  async queueDueChecks(now = new Date()): Promise<number> {
    // Unscoped by necessity: the sweep discovers mailboxes across every workspace; each check job re-scopes by workspaceId.
    const candidates = await this.prisma.unscoped.mailbox.findMany({
      where: {
        deletedAt: null,
        status: { in: ["connected", "error"] },
        workspace: { status: "active" },
        OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: new Date(now.getTime() - ERROR_RECHECK_MS) } }],
      },
      select: { id: true, workspaceId: true, status: true, lastError: true, lastCheckedAt: true },
    });
    let queued = 0;
    for (const b of candidates) {
      if (!healthCheckDue(b, now)) continue;
      // One check per mailbox at a time; removed when done so the id frees for the next sweep.
      await this.queues.add(QUEUES.mail, "check-mailbox", { workspaceId: b.workspaceId, mailboxId: b.id }, { jobId: `check-${b.id}`, attempts: 1, removeOnComplete: true, removeOnFail: true });
      queued += 1;
    }
    return queued;
  }
}

@Injectable()
export class MailSchedules implements OnModuleInit {
  constructor(
    private readonly queues: Queues,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onModuleInit() {
    if (!this.config.RUN_WORKERS) return;
    const opts = { attempts: 1, removeOnComplete: true, removeOnFail: 50 };
    await this.queues.queue(QUEUES.mail).upsertJobScheduler("mail-sync-due", { every: SYNC_SWEEP_EVERY_MS }, { name: "sync-due", data: {}, opts });
    await this.queues.queue(QUEUES.mail).upsertJobScheduler("mail-check-due", { every: HEALTH_SWEEP_EVERY_MS }, { name: "check-due", data: {}, opts });
  }
}

@Module({ imports: [MailboxesModule], providers: [MailProcessor, MailSchedules] })
export class MailboxesProcessorsModule {}
