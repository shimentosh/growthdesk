import { Controller, Get, Global, HttpCode, Injectable, Logger, Module, Param, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { PrismaService } from "../prisma/prisma.service.js";
import { MailService } from "../core/mail.service.js";
import { Ctx } from "../common/decorators.js";
import { me, ws, type RequestContext } from "../common/context.js";

export type NotificationInput = {
  type: string;
  title: string;
  body?: string;
  link?: string;
  /** Also email it, if the workspace's notification settings allow email. */
  email?: boolean;
};

/*
 * In-app notifications (the bell) plus optional email. Fan-out targets are
 * always members of the workspace — a user id that is not a member is
 * dropped, so a stale assignee can never receive another tenant's data.
 * Never throws: a failed notification must not fail the action behind it.
 */
@Injectable()
export class NotificationsService {
  private readonly log = new Logger("notifications");

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
  ) {}

  async notify(workspaceId: string, userIds: string[], n: NotificationInput) {
    try {
      const unique = [...new Set(userIds.filter(Boolean))];
      if (!unique.length) return;
      const members = await this.prisma.db.membership.findMany({
        where: { workspaceId, userId: { in: unique } },
        include: { user: { select: { id: true, email: true, suspendedAt: true } } },
      });
      if (!members.length) return;
      await this.prisma.db.notification.createMany({
        data: members.map((m) => ({ workspaceId, userId: m.userId, type: n.type, title: n.title.slice(0, 300), body: (n.body ?? "").slice(0, 2000), link: n.link ?? "" })),
      });
      if (n.email) {
        const ws = await this.prisma.db.workspace.findUnique({ where: { id: workspaceId }, select: { settings: true } });
        const prefs = ((ws?.settings ?? {}) as { notifications?: { email?: boolean } }).notifications;
        if (prefs?.email !== false) {
          for (const m of members) {
            if (!m.user.suspendedAt) await this.mail.notification(m.user.email, n.title, n.body ?? "", n.link ?? "/");
          }
        }
      }
    } catch (e) {
      this.log.error(`could not notify: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Everyone in the workspace holding one of the given roles (e.g. owners and admins). */
  async notifyRoles(workspaceId: string, roles: string[], n: NotificationInput) {
    const members = await this.prisma.db.membership.findMany({ where: { workspaceId, role: { in: roles as never } }, select: { userId: true } });
    await this.notify(workspaceId, members.map((m) => m.userId), n);
  }

  async list(workspaceId: string, userId: string) {
    const [items, unread] = await Promise.all([
      this.prisma.db.notification.findMany({ where: { workspaceId, userId }, orderBy: { createdAt: "desc" }, take: 50 }),
      this.prisma.db.notification.count({ where: { workspaceId, userId, readAt: null } }),
    ]);
    return { items, unread };
  }

  async markRead(workspaceId: string, userId: string, id?: string) {
    await this.prisma.db.notification.updateMany({ where: { workspaceId, userId, readAt: null, ...(id ? { id } : {}) }, data: { readAt: new Date() } });
  }
}

@ApiTags("notifications")
@Controller("workspaces/:workspaceId/notifications")
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@Ctx() ctx: RequestContext) {
    return this.notifications.list(ws(ctx).id, me(ctx).userId);
  }

  @HttpCode(200)
  @Post("read")
  async readAll(@Ctx() ctx: RequestContext) {
    await this.notifications.markRead(ws(ctx).id, me(ctx).userId);
    return { ok: true };
  }

  @HttpCode(200)
  @Post(":id/read")
  async readOne(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    await this.notifications.markRead(ws(ctx).id, me(ctx).userId, id);
    return { ok: true };
  }
}

@Global()
@Module({ controllers: [NotificationsController], providers: [NotificationsService], exports: [NotificationsService] })
export class NotificationsModule {}
