import { Inject, Injectable, Logger } from "@nestjs/common";
import type { ImapFlow } from "imapflow";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { Prisma, type Mailbox } from "../generated/prisma/client.js";
import { MailboxAuthService } from "../messaging/mailbox-auth.service.js";
import { MailboxFaultService } from "../messaging/mailbox-faults.service.js";
import { imapClient, imapErrorText, isImapAuthError } from "./imap.js";
import { assertReachableTarget, isLocalHost } from "./net-guard.js";
import { parseMail } from "./inbound-parse.js";
import { InboundEmailService, type InboundFolder } from "./inbound-email.service.js";

/** How far back a mailbox nobody has read yet is willing to look. */
export const FIRST_PASS_DAYS = 14;
/** No pass takes more than this (per folder), so one busy mailbox cannot hold the worker. */
export const PER_PASS = 50;
/** A message that fails to file holds the pointer for this many passes, then is skipped so the ones behind it are read. */
export const MAX_MESSAGE_ATTEMPTS = 5;
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

/** Where reading a folder stopped. INBOX keeps it in Mailbox columns, Junk in `imapJunkState`. */
export type FolderCursor = { uidValidity: string | null; uidNext: number | null; failedUid: number | null; failedAttempts: number };
type JunkState = FolderCursor & { path: string };

const junkStateOf = (raw: Prisma.JsonValue | null): JunkState | null => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.path !== "string") return null;
  return {
    path: v.path,
    uidValidity: typeof v.uidValidity === "string" ? v.uidValidity : null,
    uidNext: typeof v.uidNext === "number" ? v.uidNext : null,
    failedUid: typeof v.failedUid === "number" ? v.failedUid : null,
    failedAttempts: typeof v.failedAttempts === "number" ? v.failedAttempts : 0,
  };
};

/**
 * What to do about a message that failed to file: hold the pointer on it for
 * another try, or — after MAX_MESSAGE_ATTEMPTS passes failing on the same uid
 * — give up on it so the mailbox moves on. Pure, for the unit tests.
 */
export function onMessageFailure(cursor: Pick<FolderCursor, "failedUid" | "failedAttempts">, uid: number): { hold: boolean; attempts: number } {
  const attempts = (cursor.failedUid === uid ? cursor.failedAttempts : 0) + 1;
  return { hold: attempts < MAX_MESSAGE_ATTEMPTS, attempts };
}

/*
 * One pass over one mailbox: INBOX, then the Junk/Spam folder. Ported from
 * LinkDesk InboundMailService.syncMailbox: the first pass reads the last 14
 * days, later passes read by UID from where the last one stopped, at most 50
 * messages a pass per folder.
 *
 * Added:
 *   - UIDVALIDITY. A server that renumbers a folder invalidates the stored
 *     UID pointer, so the pass starts over from the 14-day window — the
 *     per-workspace Message-ID dedup keeps that from filing anything twice.
 *   - A message that fails to file (a database hiccup, a parser error) holds
 *     the pointer at its uid: the rest of the batch is still read, and the
 *     next pass starts from the failed one again (what was filed meanwhile
 *     comes back as a duplicate). After MAX_MESSAGE_ATTEMPTS failing passes
 *     on the same uid it is skipped and named in `syncError`.
 *   - The Junk folder (found by its SPECIAL-USE flag or a known name), so a
 *     reply a spam filter caught still stops the sequence. Only mail answering
 *     a message we sent is filed from there (InboundEmailService).
 *
 * Credentials come from MailboxAuthService (password, or an OAuth access
 * token for XOAUTH2). An authentication failure puts the mailbox in error
 * through MailboxFaultService, which tells owners and admins once, on the
 * move from connected; anything else is recorded as `syncError` and retried
 * by the next pass.
 */
@Injectable()
export class ImapSyncService {
  private readonly log = new Logger("imap-sync");

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: MailboxAuthService,
    private readonly inbound: InboundEmailService,
    private readonly faults: MailboxFaultService,
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
      const lastError = `IMAP sign-in failed: ${error}`.slice(0, 500);
      // connected → error, and the one notification for that move. A mailbox already in error (or
      // disconnected) is not moved or announced again; its error text is still brought up to date.
      if (authFailed) await this.faults.failed(box, lastError, false);
      await db.mailbox.update({
        where: { id: box.id, workspaceId },
        data: { syncError: error.slice(0, 1000), ...(authFailed ? { lastCheckedAt: new Date(), ...(box.status === "error" ? { lastError } : {}) } : {}) },
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

    const notes: string[] = [];
    try {
      await client.connect();
      const inbox = await this.readFolder(client, box, "INBOX", "inbox", { uidValidity: box.imapUidValidity, uidNext: box.imapUidNext, failedUid: box.imapFailedUid, failedAttempts: box.imapFailedAttempts }, result);
      if (inbox.note) notes.push(inbox.note);

      // Junk is a best effort on top of INBOX: a folder that cannot be read is noted, not fatal.
      let junk: JunkState | null = junkStateOf(box.imapJunkState);
      try {
        const path = await this.junkPath(client);
        if (path) {
          // Same folder, and the INBOX pointer was not reset (a new server or account starts both over).
          const prior = junk?.path === path && box.imapUidNext !== null ? junk : null;
          const read = await this.readFolder(client, box, path, "junk", prior ?? { uidValidity: null, uidNext: null, failedUid: null, failedAttempts: 0 }, result);
          junk = { path, uidValidity: read.uidValidity, uidNext: read.uidNext, failedUid: read.failedUid, failedAttempts: read.failedAttempts };
          if (read.note) notes.push(`${path}: ${read.note}`);
        } else junk = null;
      } catch (e) {
        if (isImapAuthError(e)) throw e;
        notes.push(`Junk folder could not be read — ${imapErrorText(e)}`);
      }

      const recovered = box.status === "error" && box.lastError.startsWith("IMAP");
      await db.mailbox.update({
        where: { id: box.id, workspaceId },
        data: {
          imapUidValidity: inbox.uidValidity,
          imapUidNext: inbox.uidNext,
          imapFailedUid: inbox.failedUid,
          imapFailedAttempts: inbox.failedAttempts,
          imapJunkState: junk ?? Prisma.DbNull,
          lastSyncedAt: new Date(),
          syncError: notes.join(" · ").slice(0, 1000),
          ...(recovered ? { status: "connected", lastError: "" } : {}),
        },
      });
    } catch (e) {
      const error = imapErrorText(e);
      return fail(error, isImapAuthError(e));
    } finally {
      await client.logout().catch(() => client.close());
    }

    if (result.failed) this.log.warn(`${box.email}: ${result.failed} of ${result.read} messages could not be read — ${notes.join(" · ")}`);
    return result;
  }

  /** The Junk/Spam folder: SPECIAL-USE `\Junk` reported by the server first, else one imapflow recognises by name. */
  private async junkPath(client: ImapFlow): Promise<string | null> {
    const folders = (await client.list()).filter((f) => f.specialUse === "\\Junk" && !f.flags.has("\\Noselect") && !f.flags.has("\\NonExistent"));
    return (folders.find((f) => f.specialUseSource === "extension") ?? folders[0])?.path ?? null;
  }

  /** Reads one folder from its cursor, filing what is new. Returns where the next pass starts and what went wrong. */
  private async readFolder(client: ImapFlow, box: Mailbox, path: string, folder: InboundFolder, cursor: FolderCursor, result: SyncResult): Promise<FolderCursor & { note: string }> {
    const lock = await client.getMailboxLock(path, { readOnly: true });
    try {
      const opened = client.mailbox;
      if (!opened) throw new Error(`${path} could not be opened`);
      const validity = String(opened.uidValidity);
      let { uidNext, failedUid, failedAttempts } = cursor;
      if (cursor.uidValidity && cursor.uidValidity !== validity) {
        this.log.warn(`${box.email}: ${path} UIDVALIDITY changed (${cursor.uidValidity} → ${validity}); re-reading the last ${FIRST_PASS_DAYS} days`);
        result.uidValidityChanged = true;
        uidNext = null;
      }
      // A fresh window (first pass, renumbered folder, reset pointer): earlier failures name uids that mean nothing now.
      if (!uidNext) {
        failedUid = null;
        failedAttempts = 0;
      }
      const current = { ...box, imapUidValidity: validity };

      const found = uidNext
        ? await client.search({ uid: `${uidNext}:*` }, { uid: true })
        : await client.search({ since: new Date(Date.now() - FIRST_PASS_DAYS * 86_400_000) }, { uid: true });
      // `n:*` always matches the newest message, even when its uid is below n.
      const uids = [...new Set(found || [])].filter((u) => !uidNext || u >= uidNext).sort((a, b) => a - b);
      const batch = uids.slice(0, PER_PASS);

      let highest = uidNext ? uidNext - 1 : 0;
      let held: { uid: number; attempts: number } | null = null;
      const problems: string[] = [];
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
          const outcome = await this.inbound.ingest(current, await parseMail(fetched.source), uid, folder);
          if (outcome.outcome === "filed") {
            result.filed += 1;
            if (outcome.reply) result.replies += 1;
          } else if (outcome.outcome === "duplicate") result.duplicates += 1;
          else if (outcome.outcome === "bounced") result.bounces += 1;
          else result.skipped += 1;
        } catch (e) {
          // One bad message does not stop the ones behind it, but the pointer stays on the first failure.
          result.failed += 1;
          const reason = `uid ${uid}: ${e instanceof Error ? e.message : String(e)}`;
          if (held) {
            problems.push(reason);
            continue; // already behind the held pointer: retried with it
          }
          const verdict = onMessageFailure({ failedUid, failedAttempts }, uid);
          if (verdict.hold) {
            held = { uid, attempts: verdict.attempts };
            problems.push(`${reason} (attempt ${verdict.attempts} of ${MAX_MESSAGE_ATTEMPTS}, will retry)`);
          } else {
            this.log.warn(`${box.email}: giving up on ${path} ${reason} after ${verdict.attempts} attempts`);
            problems.push(`${reason} — skipped after ${verdict.attempts} attempts`);
          }
        }
      }

      // A held failure: retried from there by the next sweep, not by this job's next pass (which would use up its attempts at once).
      result.more ||= !held && uids.length > batch.length;
      // Nothing new: remember where the folder ends, so the next pass is incremental.
      const next = held ? held.uid : batch.length ? highest + 1 : Math.max(uidNext ?? 0, opened.uidNext ?? 0) || null;
      const note = problems.length ? `${problems.length} message(s) could not be read — ${problems[0]}` : "";
      return { uidValidity: validity, uidNext: next, failedUid: held?.uid ?? null, failedAttempts: held?.attempts ?? 0, note };
    } finally {
      lock.release();
    }
  }
}
