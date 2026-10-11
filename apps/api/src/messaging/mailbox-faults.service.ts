import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import type { Mailbox } from "../generated/prisma/client.js";

/** Consecutive transient failures (connection refused, DNS, TLS) before a working mailbox is put in error. */
export const TRANSIENT_FAILURES_BEFORE_ERROR = 3;

/*
 * The one place a send path (or the reply sync, for a refused IMAP sign-in)
 * decides a mailbox has stopped working. A definitive failure (the server
 * refused the sign-in, the OAuth grant was revoked) puts it in error at once; a transient one (the server could not be
 * reached) only after TRANSIENT_FAILURES_BEFORE_ERROR in a row, so one blip
 * mid-campaign does not stall every thread on the mailbox. Every transition
 * from connected to error tells the workspace's owners and admins — a mailbox
 * in error pauses its campaign threads until it passes a health check again.
 */
@Injectable()
export class MailboxFaultService {
  private readonly log = new Logger("mailbox-faults");

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Records a failure the mailbox is at fault for. True when this failure moved it from connected to error. */
  async failed(mailbox: Pick<Mailbox, "id" | "workspaceId" | "email">, error: string, transient: boolean): Promise<boolean> {
    const lastError = error.slice(0, 500);
    let moved: boolean;
    if (transient) {
      // One statement, so concurrent sends count every failure and only one of them sees the transition.
      const rows = await this.prisma.db.$queryRaw<{ status: string }[]>`
        UPDATE "Mailbox" SET
          "sendFailures" = CASE WHEN "sendFailures" + 1 >= ${TRANSIENT_FAILURES_BEFORE_ERROR} THEN 0 ELSE "sendFailures" + 1 END,
          status = CASE WHEN "sendFailures" + 1 >= ${TRANSIENT_FAILURES_BEFORE_ERROR} THEN 'error'::"ConnectionStatus" ELSE status END,
          "lastError" = ${lastError},
          "updatedAt" = now()
        WHERE id = ${mailbox.id}::uuid AND "workspaceId" = ${mailbox.workspaceId}::uuid AND status = 'connected' AND "deletedAt" IS NULL
        RETURNING status::text AS status`;
      moved = rows[0]?.status === "error";
    } else {
      const res = await this.prisma.db.mailbox.updateMany({
        where: { id: mailbox.id, workspaceId: mailbox.workspaceId, status: "connected", deletedAt: null },
        data: { status: "error", lastError, sendFailures: 0 },
      });
      moved = res.count > 0;
    }
    if (moved) await this.alert(mailbox, lastError);
    return moved;
  }

  private async alert(mailbox: Pick<Mailbox, "id" | "workspaceId" | "email">, lastError: string) {
    this.log.warn(`${mailbox.email} stopped working: ${lastError}`);
    await this.notifications.notifyRoles(mailbox.workspaceId, ["owner", "admin"], {
      type: "mailbox.error",
      title: `${mailbox.email} stopped working`,
      body: `${lastError}\n\nSending from this mailbox is paused, and campaign follow-ups from it wait, until it passes a check again. Open the mailbox to update its sign-in, or verify it once the server is back.`,
      link: `/w/${mailbox.workspaceId}/settings/mailboxes/${mailbox.id}`,
      email: true,
    });
  }
}
