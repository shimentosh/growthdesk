import { Inject, Injectable, Logger } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { MailboxAuthService } from "../messaging/mailbox-auth.service.js";
import { imapClient, imapErrorText, isImapAuthError } from "./imap.js";
import { assertReachableTarget, isLocalHost } from "./net-guard.js";
import { parseMail } from "./inbound-parse.js";
import { InboundEmailService } from "./inbound-email.service.js";

/** How far back a mailbox nobody has read yet is willing to look. */
export const FIRST_PASS_DAYS = 14;
/** No pass takes more than this, so one busy mailbox cannot hold the worker. */
export const PER_PASS = 50;
/** Larger messages are read truncated: headers and text come first, attachments are not needed. */
const MAX_SOURCE_BYTES = 15 * 1024 * 1024;

export type SyncResult = {
  mailboxId: string;
  read: number;
  filed: number;
  replies: number;
  duplicates: number;
  bounces: number;
  skipped: number;
  failed: number;
  /** More messages are waiting than one pass takes. */
  more: boolean;
  uidValidityChanged: boolean;
  error?: string;
};

/*
 * One pass over one mailbox's INBOX. Ported from LinkDesk
 * InboundMailService.syncMailbox: the first pass reads the last 14 days,
 * later passes read by UID from where the last one stopped, at most 50
 * messages a pass, and one unreadable message never stops the ones behind it.
 *
 * Added: UIDVALIDITY. A server that renumbers the mailbox (UIDVALIDITY
 * changes) invalidates the stored UID pointer, so the pass starts over from
 * the 14-day window — the per-workspace Message-ID dedup keeps that from
 * filing anything twice. Credentials come from MailboxAuthService (password,
 * or an OAuth access token for XOAUTH2). An authentication failure marks the
 * mailbox as errored; anything else is recorded as `syncError` and retried by
 * the next pass.
 */
@Injectable()
export class ImapSyncService {
  private readonly log = new Logger("imap-sync");

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: MailboxAuthService,
    private readonly inbound: InboundEmailService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async sync(workspaceId: string, mailboxId: string): Promise<SyncResult> {
    const result: SyncResult = { mailboxId, read: 0, filed: 0, replies: 0, duplicates: 0, bounces: 0, skipped: 0, failed: 0, more: false, uidValidityChanged: false };
    const db = this.prisma.db;
    const box = await db.mailbox.findFirst({ where: { id: mailboxId, workspaceId, deletedAt: null } });
    if (!box) return { ...result, error: "The mailbox no longer exists" };
    if (!box.imapEnabled || !box.imapHost) return { ...result, error: "Reply tracking (IMAP) is off for this mailbox" };

    const fail = async (error: string, authFailed: boolean) => {
      result.error = error;
      await db.mailbox.update({
        where: { id: box.id, workspaceId },
        data: { syncError: error.slice(0, 1000), ...(authFailed ? { status: "error", lastError: `IMAP sign-in failed: ${error}`.slice(0, 500), lastCheckedAt: new Date() } : {}) },
      });
      return result;
    };

    try {
      await assertReachableTarget(box.imapHost, box.imapPort, "IMAP", this.config.ALLOW_PRIVATE_MAIL_HOSTS);
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e), false);
    }

    let auth;
    try {
      auth = await this.auth.imapAuth(box);
    } catch (e) {
      // The password cannot be opened, or the OAuth refresh was refused: the mailbox needs reconnecting.
      return fail(e instanceof Error ? e.message : String(e), true);
    }

    const client = imapClient({
      host: box.imapHost,
      port: box.imapPort,
      security: box.imapSecurity,
      auth,
      allowSelfSigned: isLocalHost(box.imapHost) && this.config.ALLOW_PRIVATE_MAIL_HOSTS,
    });
    client.on("error", (e: unknown) => this.log.warn(`${box.email}: ${imapErrorText(e)}`));

    let firstFailure = "";
    try {
      await client.connect();
      const lock = await client.getMailboxLock("INBOX", { readOnly: true });
      try {
        const opened = client.mailbox;
        if (!opened) throw new Error("INBOX could not be opened");
        const validity = String(opened.uidValidity);
        let uidNext = box.imapUidNext;
        if (box.imapUidValidity && box.imapUidValidity !== validity) {
          this.log.warn(`${box.email}: UIDVALIDITY changed (${box.imapUidValidity} → ${validity}); re-reading the last ${FIRST_PASS_DAYS} days`);
          result.uidValidityChanged = true;
          uidNext = null;
        }
        const current = { ...box, imapUidValidity: validity };

        const found = uidNext
          ? await client.search({ uid: `${uidNext}:*` }, { uid: true })
          : await client.search({ since: new Date(Date.now() - FIRST_PASS_DAYS * 86_400_000) }, { uid: true });
        // `n:*` always matches the newest message, even when its uid is below n.
        const uids = [...new Set(found || [])].filter((u) => !uidNext || u >= uidNext).sort((a, b) => a - b);
        const batch = uids.slice(0, PER_PASS);
        result.more = uids.length > batch.length;

        let highest = uidNext ? uidNext - 1 : 0;
        for (const uid of batch) {
          result.read += 1;
          highest = Math.max(highest, uid);
          try {
            // One message at a time: bounded memory, and no IMAP command is issued inside a fetch stream.
            const fetched = await client.fetchOne(String(uid), { uid: true, source: { maxLength: MAX_SOURCE_BYTES } }, { uid: true });
            if (!fetched || !fetched.source) {
              result.skipped += 1;
              continue;
            }
            const outcome = await this.inbound.ingest(current, await parseMail(fetched.source), uid);
            if (outcome.outcome === "filed") {
              result.filed += 1;
              if (outcome.reply) result.replies += 1;
            } else if (outcome.outcome === "duplicate") result.duplicates += 1;
            else if (outcome.outcome === "bounced") result.bounces += 1;
            else result.skipped += 1;
          } catch (e) {
            // One bad message must not stop the ones behind it; the pointer moves past it.
            result.failed += 1;
            firstFailure ||= `uid ${uid}: ${e instanceof Error ? e.message : String(e)}`;
          }
        }

        // Nothing new: remember where the mailbox ends, so the next pass is incremental.
        const next = batch.length ? highest + 1 : Math.max(uidNext ?? 0, opened.uidNext ?? 0) || null;
        const recovered = box.status === "error" && box.lastError.startsWith("IMAP");
        await db.mailbox.update({
          where: { id: box.id, workspaceId },
          data: {
            imapUidValidity: validity,
            imapUidNext: next,
            lastSyncedAt: new Date(),
            syncError: firstFailure ? `${result.failed} message(s) could not be read — ${firstFailure}`.slice(0, 1000) : "",
            ...(recovered ? { status: "connected", lastError: "" } : {}),
          },
        });
      } finally {
        lock.release();
      }
    } catch (e) {
      const error = imapErrorText(e);
      return fail(error, isImapAuthError(e));
    } finally {
      await client.logout().catch(() => client.close());
    }

    if (result.failed) this.log.warn(`${box.email}: ${result.failed} of ${result.read} messages could not be read — ${firstFailure}`);
    return result;
  }
}
