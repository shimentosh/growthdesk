import { Injectable } from "@nestjs/common";
import type { EmailBlock, PlatformBroadcastInput, PlatformBroadcastScheduleInput, PlatformBroadcastUpdate, PlatformBroadcastStatus, PlatformMarketingPreviewInput } from "@growthdesk/shared";
import type { z } from "zod";
import { PrismaService } from "../prisma/prisma.service.js";
import { AuditService } from "../core/audit.service.js";
import { me, type RequestContext } from "../common/context.js";
import { ApiError, badRequest, conflict, notFound, tooMany } from "../common/errors.js";
import { PlatformMailService } from "../platform-mail/platform-mail.service.js";
import { AudiencesService, normaliseFilter } from "./audiences.service.js";
import { BroadcastRunner, totalsOf } from "./broadcast-runner.service.js";
import { contentOf, marketingProblems, MarketingMailer } from "./marketing-mailer.js";

/*
 * Broadcasts (admin side): drafts are freely editable; scheduling validates
 * the content against the marketing variables and refuses an empty audience;
 * a scheduled broadcast can be pulled back to draft, a sending one canceled
 * (its remaining recipients are never sent). Stats come from EmailLog rows
 * carrying the broadcast id, plus unsubscribes attributed through the token
 * (PlatformEmailEvent type "unsubscribed").
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TESTS_PER_HOUR = 20;

/** A sendable starting design (no button: its link would have to be a real https URL). */
export function starterMarketingBlocks(): EmailBlock[] {
  return [
    { type: "heading", id: "h1", text: "What's new in {{product_name}}", level: 1, align: "left" },
    { type: "text", id: "t1", text: "Hi {{name|there}},\n\nWrite your update here. Use **bold**, *italic* and [links](https://example.com).", align: "left" },
  ];
}

@Injectable()
export class BroadcastsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly audiences: AudiencesService,
    private readonly runner: BroadcastRunner,
    private readonly mailer: MarketingMailer,
    private readonly mail: PlatformMailService,
  ) {}

  private record(ctx: RequestContext, action: string, targetId: string, metadata: Record<string, unknown> = {}) {
    return this.audit.record(ctx, { workspaceId: null, action, targetType: "platform_broadcast", targetId, metadata }, "platform_admin");
  }

  private async find(id: string) {
    if (!UUID.test(id)) throw notFound("That broadcast");
    const row = await this.prisma.db.platformBroadcast.findUnique({ where: { id }, include: { audience: { select: { id: true, name: true, filter: true } } } });
    if (!row) throw notFound("That broadcast");
    return row;
  }

  async list(status?: PlatformBroadcastStatus) {
    const rows = await this.prisma.db.platformBroadcast.findMany({
      where: status ? { status } : {},
      orderBy: { createdAt: "desc" },
      take: 200,
      include: { audience: { select: { id: true, name: true } } },
    });
    const groups = rows.length
      ? await this.prisma.db.platformBroadcastRecipient.groupBy({ by: ["broadcastId", "status"], where: { broadcastId: { in: rows.map((r) => r.id) } }, _count: { _all: true } })
      : [];
    return rows.map((r) => {
      const of = (s: string) => groups.find((g) => g.broadcastId === r.id && g.status === s)?._count._all ?? 0;
      const progress = { pending: of("pending"), sent: of("sent"), failed: of("failed"), skipped: of("skipped"), canceled: of("canceled") };
      return {
        id: r.id,
        name: r.name,
        subject: r.subject,
        status: r.status,
        audience: r.audience,
        scheduledAt: r.scheduledAt,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        totals: totalsOf(r.totals),
        progress: { ...progress, total: progress.pending + progress.sent + progress.failed + progress.skipped + progress.canceled },
        error: r.error,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      };
    });
  }

  async detail(id: string) {
    const r = await this.find(id);
    const content = contentOf(r);
    const live = r.status === "draft" || r.status === "scheduled";
    return {
      id: r.id,
      name: r.name,
      status: r.status,
      audience: r.audience ? { id: r.audience.id, name: r.audience.name, count: live ? await this.audiences.count(normaliseFilter(r.audience.filter)) : null } : null,
      subject: r.subject,
      preheader: r.preheader,
      blocks: content.blocks,
      scheduledAt: r.scheduledAt,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      totals: totalsOf(r.totals),
      progress: await this.runner.progress(r.id),
      error: r.error,
      problems: marketingProblems(content),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  private async assertAudience(audienceId: string | null | undefined) {
    if (!audienceId) return;
    const exists = await this.prisma.db.platformAudience.count({ where: { id: audienceId } });
    if (!exists) throw badRequest("That audience does not exist", { audienceId: "Choose an audience" });
  }

  async create(ctx: RequestContext, input: z.infer<typeof PlatformBroadcastInput>) {
    await this.assertAudience(input.audienceId);
    const row = await this.prisma.db.platformBroadcast.create({
      data: {
        name: input.name,
        audienceId: input.audienceId ?? null,
        subject: input.subject ?? "",
        preheader: input.preheader ?? "",
        blocks: (input.blocks ?? starterMarketingBlocks()) as never,
        createdById: ctx.identity?.userId ?? null,
      },
    });
    await this.record(ctx, "platform.growth_broadcast_created", row.id, { name: row.name });
    return this.detail(row.id);
  }

  async update(ctx: RequestContext, id: string, input: z.infer<typeof PlatformBroadcastUpdate>) {
    const r = await this.find(id);
    if (r.status !== "draft") throw conflict("Only a draft can be edited. Cancel the schedule first.");
    await this.assertAudience(input.audienceId);
    const changed = await this.prisma.db.platformBroadcast.updateMany({
      where: { id, status: "draft" },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.audienceId !== undefined ? { audienceId: input.audienceId } : {}),
        ...(input.subject !== undefined ? { subject: input.subject } : {}),
        ...(input.preheader !== undefined ? { preheader: input.preheader } : {}),
        ...(input.blocks !== undefined ? { blocks: input.blocks as never } : {}),
      },
    });
    if (!changed.count) throw conflict("Only a draft can be edited.");
    await this.record(ctx, "platform.growth_broadcast_updated", id, { fields: Object.keys(input) });
    return this.detail(id);
  }

  async remove(ctx: RequestContext, id: string) {
    const r = await this.find(id);
    if (r.status === "scheduled" || r.status === "sending" || r.status === "sent") throw conflict("Scheduled, sending and sent broadcasts are kept. Cancel a scheduled one first.");
    await this.prisma.db.platformBroadcast.delete({ where: { id } });
    await this.record(ctx, "platform.growth_broadcast_deleted", id, { name: r.name });
    return { ok: true };
  }

  /** Renders any content (broadcast or drip step) with sample values. */
  async preview(input: z.infer<typeof PlatformMarketingPreviewInput>) {
    const content = { subject: input.subject, preheader: input.preheader, blocks: input.blocks };
    const r = this.mailer.preview(content, await this.mailer.brand());
    return { ...r, problems: marketingProblems(content) };
  }

  /** Sends the current draft to the caller, subject prefixed "[Test] ". Not counted in the stats. */
  async test(ctx: RequestContext, id: string) {
    const r = await this.find(id);
    return this.sendTest(ctx, contentOf(r), `broadcast:${r.id}`);
  }

  async sendTest(ctx: RequestContext, content: ReturnType<typeof contentOf>, ref: string) {
    const caller = me(ctx);
    const problems = marketingProblems(content);
    if (problems.length) throw new ApiError(400, "bad_request", problems[0]!, undefined, { problems });
    const recent = await this.prisma.db.emailLog.count({ where: { userId: caller.userId, template: "marketing_test", createdAt: { gt: new Date(Date.now() - 3_600_000) } } });
    if (recent >= TESTS_PER_HOUR) throw tooMany(`At most ${TESTS_PER_HOUR} test emails an hour.`);
    const user = await this.prisma.db.user.findUniqueOrThrow({ where: { id: caller.userId }, select: { id: true, email: true, name: true } });
    const env = await this.mailer.envelope();
    const mail = this.mailer.build(content, user, null, { brand: await this.mailer.brand(), from: env.from, replyTo: env.replyTo, kind: "test", ref, subjectPrefix: "[Test] " });
    const result = await this.mail.sendNow({ to: user.email, subject: mail.subject, html: mail.html, text: mail.text, template: "marketing_test", stream: "marketing", userId: user.id, headers: mail.headers });
    await this.record(ctx, "platform.growth_test_sent", ref, { to: user.email, ok: result.ok });
    return { ...result, to: user.email };
  }

  async schedule(ctx: RequestContext, id: string, input: z.infer<typeof PlatformBroadcastScheduleInput>) {
    const r = await this.find(id);
    if (r.status !== "draft") throw conflict("Only a draft can be scheduled.");
    if (!r.audience) throw badRequest("Choose an audience first", { audienceId: "Choose an audience" });
    const problems = marketingProblems(contentOf(r));
    if (problems.length) throw new ApiError(400, "bad_request", problems[0]!, undefined, { problems });
    const now = new Date();
    const at = input.now ? now : new Date(input.at!);
    if (!input.now && at.getTime() < now.getTime() + 60_000) throw badRequest("Choose a time at least a minute from now, or send now", { at: "Choose a later time" });
    const recipients = await this.audiences.count(normaliseFilter(r.audience.filter));
    if (!recipients) throw conflict("Nobody in this audience can receive product emails right now (consent, verification and unsubscribes are always checked).");
    const moved = await this.prisma.db.platformBroadcast.updateMany({ where: { id, status: "draft" }, data: { status: "scheduled", scheduledAt: at, error: "" } });
    if (!moved.count) throw conflict("Only a draft can be scheduled.");
    await this.runner.queueStart(id, at);
    await this.record(ctx, input.now ? "platform.growth_broadcast_sent_now" : "platform.growth_broadcast_scheduled", id, { at: at.toISOString(), recipients });
    return this.detail(id);
  }

  /** Scheduled → back to draft. Sending → canceled; whoever has not been sent to yet never is. */
  async cancel(ctx: RequestContext, id: string) {
    const r = await this.find(id);
    if (r.status === "scheduled") {
      const moved = await this.prisma.db.platformBroadcast.updateMany({ where: { id, status: "scheduled" }, data: { status: "draft", scheduledAt: null } });
      if (moved.count) {
        await this.runner.dropStart(id, r.scheduledAt);
        await this.record(ctx, "platform.growth_broadcast_unscheduled", id);
        return this.detail(id);
      }
    }
    if (r.status === "sending" || r.status === "scheduled") {
      const stopped = await this.prisma.db.$transaction(async (tx) => {
        const moved = await tx.platformBroadcast.updateMany({ where: { id, status: "sending" }, data: { status: "canceled", finishedAt: new Date() } });
        if (!moved.count) return null;
        const left = await tx.platformBroadcastRecipient.findMany({ where: { broadcastId: id, status: "pending" }, select: { emailLogId: true } });
        await tx.platformBroadcastRecipient.updateMany({ where: { broadcastId: id, status: "pending" }, data: { status: "canceled" } });
        const logIds = left.map((l) => l.emailLogId).filter((x): x is string => Boolean(x));
        if (logIds.length) await tx.emailLog.updateMany({ where: { id: { in: logIds }, status: "queued" }, data: { status: "failed", error: "The broadcast was canceled before this was sent" } });
        return left.length;
      });
      if (stopped !== null) {
        const p = await this.runner.progress(id);
        const b = await this.prisma.db.platformBroadcast.findUniqueOrThrow({ where: { id } });
        await this.prisma.db.platformBroadcast.update({ where: { id }, data: { totals: { ...totalsOf(b.totals), recipients: p.total, sent: p.sent, failed: p.failed, skipped: p.skipped, canceled: p.canceled } } });
        await this.record(ctx, "platform.growth_broadcast_canceled", id, { notSent: stopped });
        return this.detail(id);
      }
    }
    throw conflict("Only a scheduled or sending broadcast can be canceled.");
  }

  async stats(id: string) {
    const r = await this.find(id);
    const [row] = await this.prisma.db.$queryRaw<
      { total: number; queued: number; sent: number; delivered: number; opened: number; clicked: number; bounced: number; complained: number; failed: number }[]
    >`
      SELECT count(*)::int AS total,
        count(*) FILTER (WHERE status = 'queued')::int AS queued,
        count(*) FILTER (WHERE status NOT IN ('queued', 'failed', 'suppressed'))::int AS sent,
        count(*) FILTER (WHERE "deliveredAt" IS NOT NULL OR status IN ('delivered', 'complained'))::int AS delivered,
        count(*) FILTER (WHERE "openedAt" IS NOT NULL)::int AS opened,
        count(*) FILTER (WHERE "clickedAt" IS NOT NULL)::int AS clicked,
        count(*) FILTER (WHERE status = 'bounced')::int AS bounced,
        count(*) FILTER (WHERE status = 'complained')::int AS complained,
        count(*) FILTER (WHERE status IN ('failed', 'suppressed'))::int AS failed
      FROM "EmailLog" WHERE "broadcastId" = ${id}::uuid`;
    const [unsub] = await this.prisma.db.$queryRaw<{ n: number }[]>`
      SELECT count(DISTINCT l."userId")::int AS n FROM "PlatformEmailEvent" e JOIN "EmailLog" l ON l.id = e."emailLogId"
      WHERE e.type = 'unsubscribed' AND l."broadcastId" = ${id}::uuid`;
    return {
      id: r.id,
      status: r.status,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      recipients: await this.runner.progress(id),
      email: row ?? { total: 0, queued: 0, sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, complained: 0, failed: 0 },
      unsubscribes: unsub?.n ?? 0,
    };
  }
}

