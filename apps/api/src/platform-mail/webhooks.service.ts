import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service.js";
import type { Tx } from "../prisma/prisma.service.js";
import { PlatformSettingsService } from "../core/platform-settings.service.js";
import { badRequest, unauthorized, unavailable } from "../common/errors.js";
import { verifySvix } from "./svix.js";

/*
 * Resend delivery events → EmailLog. Each event is stored once
 * (PlatformEmailEvent.providerEventId = svix-id; Svix retries reuse it), in the
 * same transaction as the EmailLog change, so a retried delivery never applies
 * twice and a failed one is not half-applied.
 *
 * Matching: EmailLog.providerMessageId = data.email_id, else the `log_id` tag
 * we attach to every send (covers an event that beats our own "sent" update).
 *
 * A hard bounce, a spam complaint, or Resend suppressing the address marks
 * the user suppressed in PlatformUserProfile. Only marketing (broadcasts,
 * drips) obeys that flag; system mail still goes out.
 *
 * Status never moves backwards: queued < sent < delivered < bounced/failed/suppressed < complained.
 */

type ResendEvent = {
  type?: string;
  created_at?: string;
  data?: {
    email_id?: string;
    to?: string[] | string;
    tags?: Record<string, string> | { name: string; value: string }[];
    bounce?: { type?: string; subType?: string; message?: string };
    failed?: { reason?: string };
  };
};

const RANK: Record<string, number> = { queued: 0, sent: 1, delivered: 2, bounced: 3, failed: 3, suppressed: 3, complained: 4 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resend sends tags as { name: value }; older payloads used [{ name, value }]. */
function tag(tags: unknown, name: string): string | null {
  if (!tags || typeof tags !== "object") return null;
  if (Array.isArray(tags)) {
    const v = (tags as { name?: unknown; value?: unknown }[]).find((t) => t?.name === name)?.value;
    return typeof v === "string" ? v : null;
  }
  const v = (tags as Record<string, unknown>)[name];
  return typeof v === "string" ? v : null;
}

@Injectable()
export class PlatformMailWebhooksService {
  private readonly log = new Logger("platform-mail-webhook");

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: PlatformSettingsService,
  ) {}

  async handleResend(rawBody: Buffer | undefined, headers: Record<string, string | string[] | undefined>) {
    const secret = await this.settings.resendWebhookSecret();
    if (!secret) throw unavailable("Resend webhooks are not set up: add the signing secret under Email settings.");
    if (!rawBody?.length) throw badRequest("Empty webhook body");
    const verified = verifySvix(secret, headers, rawBody);
    if (!verified.ok) throw unauthorized(`Webhook signature refused: ${verified.reason}`);
    let event: ResendEvent;
    try {
      event = JSON.parse(rawBody.toString("utf8")) as ResendEvent;
    } catch {
      throw badRequest("The body must be JSON");
    }
    const type = String(event.type ?? "unknown").slice(0, 60);
    const occurredAt = event.created_at && !Number.isNaN(Date.parse(event.created_at)) ? new Date(event.created_at) : new Date();
    const emailId = typeof event.data?.email_id === "string" ? event.data.email_id : null;
    const logIdTag = tag(event.data?.tags, "log_id");

    try {
      return await this.prisma.db.$transaction(async (tx) => {
        let log = emailId ? await tx.emailLog.findUnique({ where: { providerMessageId: emailId } }) : null;
        if (!log && logIdTag && UUID.test(logIdTag)) {
          log = await tx.emailLog.findUnique({ where: { id: logIdTag } });
          if (log && emailId && !log.providerMessageId) log = await tx.emailLog.update({ where: { id: log.id }, data: { providerMessageId: emailId } });
        }
        await tx.platformEmailEvent.create({
          data: { providerEventId: verified.id, emailLogId: log?.id ?? null, type, payload: event as never, occurredAt },
        });
        if (!log) return { ok: true, matched: false, duplicate: false };
        await this.apply(tx, log, type, event, occurredAt);
        return { ok: true, matched: true, duplicate: false };
      });
    } catch (e) {
      // The unique providerEventId: this delivery was already processed.
      if ((e as { code?: string }).code === "P2002") return { ok: true, matched: false, duplicate: true };
      throw e;
    }
  }

  private async apply(tx: Tx, log: { id: string; status: string; userId: string | null; to: string; stream: string; sentAt: Date | null }, type: string, event: ResendEvent, at: Date) {
    const data: Record<string, unknown> = {};
    const advance = (status: string) => {
      if ((RANK[status] ?? 0) >= (RANK[log.status] ?? 0) && status !== log.status) data.status = status;
    };
    let suppress: string | null = null;
    switch (type) {
      case "email.sent":
        if (!log.sentAt) data.sentAt = at;
        advance("sent");
        break;
      case "email.delivered":
        data.deliveredAt = at;
        advance("delivered");
        break;
      case "email.delivery_delayed":
        break; // Recorded as an event; the status stays.
      case "email.bounced": {
        data.bouncedAt = at;
        advance("bounced");
        const b = event.data?.bounce;
        data.error = `Bounced${b?.type ? ` (${b.type}${b.subType ? `/${b.subType}` : ""})` : ""}${b?.message ? `: ${b.message}` : ""}`.slice(0, 500);
        // Resend documents Permanent | Temporary; anything not Temporary is treated as hard.
        if ((b?.type ?? "Permanent").toLowerCase() !== "temporary") suppress = "hard_bounce";
        break;
      }
      case "email.complained":
        data.complainedAt = at;
        advance("complained");
        suppress = "complaint";
        break;
      case "email.opened":
        data.openedAt = at;
        break;
      case "email.clicked":
        data.clickedAt = at;
        break;
      case "email.failed":
        advance("failed");
        data.error = `Resend could not send it${event.data?.failed?.reason ? `: ${event.data.failed.reason}` : ""}`.slice(0, 500);
        break;
      case "email.suppressed":
        advance("suppressed");
        data.error = "Resend suppressed this address (an earlier bounce or complaint)";
        suppress = "provider_suppressed";
        break;
      default:
        return;
    }
    // First open/click wins; later ones are only events.
    if (data.openedAt || data.clickedAt) {
      const current = await tx.emailLog.findUnique({ where: { id: log.id }, select: { openedAt: true, clickedAt: true } });
      if (current?.openedAt) delete data.openedAt;
      if (current?.clickedAt) delete data.clickedAt;
    }
    if (Object.keys(data).length) await tx.emailLog.update({ where: { id: log.id }, data });
    if (suppress) await this.suppress(tx, log, suppress, at);
  }

  private async suppress(tx: Tx, log: { userId: string | null; to: string }, reason: string, at: Date) {
    let userId = log.userId;
    if (!userId) {
      const user = await tx.user.findFirst({ where: { email: { equals: log.to, mode: "insensitive" } }, select: { id: true } });
      userId = user?.id ?? null;
    }
    if (!userId) return;
    const existing = await tx.platformUserProfile.findUnique({ where: { userId }, select: { suppressedAt: true } });
    if (existing?.suppressedAt) return;
    await tx.platformUserProfile.upsert({
      where: { userId },
      create: { userId, suppressedAt: at, suppressionReason: reason },
      update: { suppressedAt: at, suppressionReason: reason },
    });
    this.log.log(`user ${userId} suppressed for marketing (${reason})`);
  }
}
