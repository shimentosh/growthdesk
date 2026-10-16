import { Inject, Injectable } from "@nestjs/common";
import type { z } from "zod";
import { readAvailability, readQuestions, type BookingPageInput } from "@growthdesk/shared";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { Prisma, type BookingPage } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { AuditService } from "../core/audit.service.js";
import { actorId, ws, type RequestContext } from "../common/context.js";
import { badRequest, conflict, notFound } from "../common/errors.js";

type PageInputT = z.infer<typeof BookingPageInput>;

/*
 * Booking pages (booking.manage): a public /book/<slug> page per meeting
 * type. Slugs are unique across the installation (the URL has no workspace
 * in it); a deleted page gives its slug back. Hosts must be members of the
 * workspace; the editor shows which of them have a calendar connected.
 */
@Injectable()
export class BookingPagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  publicUrl(slug: string) {
    return `${this.config.PUBLIC_APP_URL.replace(/\/+$/, "")}/book/${slug}`;
  }

  private async dto(workspaceId: string, pages: BookingPage[]) {
    const hostIds = [...new Set(pages.flatMap((p) => (p.hostUserIds as string[]) ?? []))];
    const [users, calendars, upcoming] = await Promise.all([
      hostIds.length ? this.prisma.db.user.findMany({ where: { id: { in: hostIds } }, select: { id: true, name: true, email: true } }) : [],
      hostIds.length ? this.prisma.db.calendarConnection.findMany({ where: { workspaceId, userId: { in: hostIds }, deletedAt: null }, select: { userId: true, status: true, provider: true, email: true }, orderBy: { createdAt: "asc" } }) : [],
      pages.length
        ? this.prisma.db.meeting.groupBy({ by: ["bookingPageId"], where: { workspaceId, bookingPageId: { in: pages.map((p) => p.id) }, status: "scheduled", startsAt: { gte: new Date() } }, _count: { _all: true } })
        : [],
    ]);
    const userById = new Map(users.map((u) => [u.id, u]));
    const counts = new Map(upcoming.map((u) => [u.bookingPageId, u._count._all]));
    return pages.map((p) => ({
      id: p.id,
      slug: p.slug,
      url: this.publicUrl(p.slug),
      title: p.title,
      description: p.description,
      durationMinutes: p.durationMinutes,
      assignment: p.assignment,
      hostUserIds: (p.hostUserIds as string[]) ?? [],
      hosts: ((p.hostUserIds as string[]) ?? []).map((id) => {
        const u = userById.get(id);
        const cal = calendars.find((c) => c.userId === id && c.status === "connected") ?? calendars.find((c) => c.userId === id) ?? null;
        return { userId: id, name: u?.name ?? "", email: u?.email ?? "", calendar: cal ? { provider: cal.provider, email: cal.email, status: cal.status } : null };
      }),
      availability: readAvailability(p.availability),
      bufferBeforeMinutes: p.bufferBeforeMinutes,
      bufferAfterMinutes: p.bufferAfterMinutes,
      minNoticeMinutes: p.minNoticeMinutes,
      maxDaysAhead: p.maxDaysAhead,
      slotStepMinutes: p.slotStepMinutes,
      locationType: p.locationType,
      locationDetail: p.locationDetail,
      questions: readQuestions(p.questions),
      confirmationMessage: p.confirmationMessage,
      active: p.active,
      upcomingBookings: counts.get(p.id) ?? 0,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    }));
  }

  private async page(ctx: RequestContext, id: string) {
    const p = await this.prisma.db.bookingPage.findFirst({ where: { id, workspaceId: ws(ctx).id, deletedAt: null } });
    if (!p) throw notFound("That booking page");
    return p;
  }

  private async assertHosts(workspaceId: string, hostUserIds: string[]) {
    const ids = [...new Set(hostUserIds)];
    const members = await this.prisma.db.membership.count({ where: { workspaceId, userId: { in: ids } } });
    if (members !== ids.length) throw badRequest("Every host must be a member of this workspace", { hostUserIds: "Every host must be a member of this workspace" });
    return ids;
  }

  private taken(e: unknown): never {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw conflict("That link is already taken — choose another.", { slug: "That link is already taken" });
    throw e;
  }

  async list(ctx: RequestContext) {
    const w = ws(ctx);
    const rows = await this.prisma.db.bookingPage.findMany({ where: { workspaceId: w.id, deletedAt: null }, orderBy: { createdAt: "asc" }, take: 200 });
    return this.dto(w.id, rows);
  }

  async get(ctx: RequestContext, id: string) {
    return (await this.dto(ws(ctx).id, [await this.page(ctx, id)]))[0]!;
  }

  async create(ctx: RequestContext, input: PageInputT) {
    const w = ws(ctx);
    const hostUserIds = await this.assertHosts(w.id, input.hostUserIds);
    const row = await this.prisma.db.bookingPage
      .create({
        data: {
          workspaceId: w.id,
          slug: input.slug,
          title: input.title,
          description: input.description,
          durationMinutes: input.durationMinutes,
          assignment: input.assignment,
          hostUserIds,
          availability: input.availability,
          bufferBeforeMinutes: input.bufferBeforeMinutes,
          bufferAfterMinutes: input.bufferAfterMinutes,
          minNoticeMinutes: input.minNoticeMinutes,
          maxDaysAhead: input.maxDaysAhead,
          slotStepMinutes: input.slotStepMinutes,
          locationType: input.locationType,
          locationDetail: input.locationDetail,
          questions: input.questions,
          confirmationMessage: input.confirmationMessage,
          active: input.active,
          createdById: actorId(ctx),
        },
      })
      .catch((e: unknown) => this.taken(e));
    await this.audit.record(ctx, { action: "booking_page.created", targetType: "booking_page", targetId: row.id, metadata: { slug: row.slug, title: row.title } });
    return this.get(ctx, row.id);
  }

  async update(ctx: RequestContext, id: string, input: Partial<PageInputT>) {
    const existing = await this.page(ctx, id);
    const hostUserIds = input.hostUserIds ? await this.assertHosts(existing.workspaceId, input.hostUserIds) : undefined;
    const { hostUserIds: _h, ...rest } = input;
    const data: Prisma.BookingPageUpdateInput = {};
    for (const [k, v] of Object.entries(rest)) if (v !== undefined) (data as Record<string, unknown>)[k] = v;
    if (hostUserIds) {
      data.hostUserIds = hostUserIds;
      // A new host list starts its rotation from the top.
      if (JSON.stringify(hostUserIds) !== JSON.stringify(existing.hostUserIds)) data.roundRobinCursor = 0;
    }
    await this.prisma.db.bookingPage.update({ where: { id: existing.id, workspaceId: existing.workspaceId }, data }).catch((e: unknown) => this.taken(e));
    await this.audit.record(ctx, { action: "booking_page.updated", targetType: "booking_page", targetId: id, metadata: { fields: Object.keys(input) } });
    return this.get(ctx, id);
  }

  async remove(ctx: RequestContext, id: string) {
    const existing = await this.page(ctx, id);
    // The slug is unique across every page ever made; a deleted page frees it for reuse.
    await this.prisma.db.bookingPage.update({ where: { id: existing.id, workspaceId: existing.workspaceId }, data: { deletedAt: new Date(), active: false, slug: `${existing.slug}~${existing.id}` } });
    await this.audit.record(ctx, { action: "booking_page.deleted", targetType: "booking_page", targetId: id, metadata: { slug: existing.slug, title: existing.title } });
  }
}
