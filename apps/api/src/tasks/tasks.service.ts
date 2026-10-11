import { Injectable } from "@nestjs/common";
import type { z } from "zod";
import type { TaskInput } from "@growthdesk/shared";
import { Prisma } from "../generated/prisma/client.js";
import { PrismaService, type Tx } from "../prisma/prisma.service.js";
import { EventsService } from "../core/events.service.js";
import { ActivityService } from "../crm/activity.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { badRequest, forbidden, notFound } from "../common/errors.js";
import { actorId, holds, me, ws, type RequestContext } from "../common/context.js";

type TaskInputT = z.infer<typeof TaskInput>;
export type TaskView = "today" | "overdue" | "upcoming" | "completed" | "mine" | "team" | "all";

const taskInclude = {
  contact: { select: { id: true, fullName: true, email: true, phone: true } },
  deal: { select: { id: true, name: true } },
  assignee: { select: { id: true, name: true } },
  conversation: { select: { id: true, channel: true, subject: true } },
} satisfies Prisma.TaskInclude;

/** Start and end of "today" in a time zone, as instants. */
export function dayBounds(tz: string, now = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const [y, m, d] = fmt.format(now).split("-").map(Number) as [number, number, number];
  const probe = new Date(Date.UTC(y, m - 1, d));
  const offset = (() => {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(probe);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute")) - probe.getTime();
  })();
  const start = new Date(probe.getTime() - offset);
  return { start, end: new Date(start.getTime() + 86_400_000) };
}

@Injectable()
export class TasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
    private readonly activity: ActivityService,
    private readonly notifications: NotificationsService,
  ) {}

  private scope(ctx: RequestContext): Prisma.TaskWhereInput {
    // Without records.view_all a person sees their own tasks and unassigned ones.
    if (holds(ctx, "records.view_all")) return {};
    return { OR: [{ assigneeId: ctx.identity?.userId }, { assigneeId: null }] };
  }

  async list(ctx: RequestContext, view: TaskView, opts: { assigneeId?: string; contactId?: string; dealId?: string; type?: string; page: number; pageSize: number }) {
    const w = ws(ctx);
    const user = ctx.identity?.userId;
    const { start, end } = dayBounds(w.timezone);
    const now = new Date();
    const where: Prisma.TaskWhereInput = { workspaceId: w.id, AND: [this.scope(ctx)] };
    const and = where.AND as Prisma.TaskWhereInput[];
    switch (view) {
      case "today":
        and.push({ status: "open", dueAt: { gte: start, lt: end } });
        break;
      case "overdue":
        and.push({ status: "open", dueAt: { lt: now } });
        break;
      case "upcoming":
        and.push({ status: "open", OR: [{ dueAt: { gte: end } }, { dueAt: null }] });
        break;
      case "completed":
        and.push({ status: "done" });
        break;
      case "mine":
        and.push({ status: "open", assigneeId: user });
        break;
      case "team":
        // `not` alone excludes NULLs in SQL, which would hide unassigned tasks from the team view.
        and.push({ status: "open", OR: [{ assigneeId: { not: user } }, { assigneeId: null }] });
        break;
      case "all":
        break;
    }
    if (opts.assigneeId) and.push({ assigneeId: opts.assigneeId === "me" ? user : opts.assigneeId });
    if (opts.contactId) and.push({ contactId: opts.contactId });
    if (opts.dealId) and.push({ dealId: opts.dealId });
    if (opts.type) and.push({ type: opts.type as never });
    const orderBy: Prisma.TaskOrderByWithRelationInput[] =
      view === "completed" ? [{ completedAt: "desc" }] : [{ dueAt: { sort: "asc", nulls: "last" } }, { priority: "desc" }, { createdAt: "asc" }];
    const [items, total] = await Promise.all([
      this.prisma.db.task.findMany({ where, include: taskInclude, orderBy, skip: (opts.page - 1) * opts.pageSize, take: opts.pageSize }),
      this.prisma.db.task.count({ where }),
    ]);
    return { items, total, page: opts.page, pageSize: opts.pageSize };
  }

  /** The daily work queue's headline numbers and attention lists. */
  async summary(ctx: RequestContext) {
    const w = ws(ctx);
    const user = me(ctx).userId;
    const { start, end } = dayBounds(w.timezone);
    const now = new Date();
    const mine: Prisma.TaskWhereInput = { workspaceId: w.id, status: "open", assigneeId: user };
    const staleCutoff = new Date(Date.now() - 14 * 86_400_000);
    const [today, overdue, upcoming, unansweredReplies, noNextAction, upcomingMeetings, inactiveDeals] = await Promise.all([
      this.prisma.db.task.count({ where: { ...mine, dueAt: { gte: start, lt: end } } }),
      this.prisma.db.task.count({ where: { ...mine, dueAt: { lt: now } } }),
      this.prisma.db.task.count({ where: { ...mine, dueAt: { gte: end } } }),
      this.prisma.db.conversation.findMany({
        where: { workspaceId: w.id, status: "open", unread: true, lastInboundAt: { not: null }, ...(holds(ctx, "records.view_all") ? {} : { OR: [{ assigneeId: user }, { assigneeId: null }] }) },
        include: { contact: { select: { id: true, fullName: true } } },
        orderBy: { lastInboundAt: "asc" },
        take: 10,
      }),
      this.prisma.db.contact.findMany({
        where: { workspaceId: w.id, deletedAt: null, ownerId: user, nextActionAt: null, status: { in: ["replied", "interested"] } },
        select: { id: true, fullName: true, email: true, status: true },
        take: 10,
      }),
      this.prisma.db.meeting.findMany({
        where: { workspaceId: w.id, status: "scheduled", startsAt: { gte: now, lte: new Date(Date.now() + 7 * 86_400_000) }, OR: [{ ownerId: user }, { ownerId: null }] },
        include: { contact: { select: { id: true, fullName: true } } },
        orderBy: { startsAt: "asc" },
        take: 10,
      }),
      this.prisma.db.deal.findMany({
        where: { workspaceId: w.id, deletedAt: null, status: "open", ownerId: user, updatedAt: { lt: staleCutoff } },
        select: { id: true, name: true, updatedAt: true, value: true, currency: true },
        orderBy: { updatedAt: "asc" },
        take: 10,
      }),
    ]);
    return {
      counts: { today, overdue, upcoming },
      unansweredReplies,
      noNextAction,
      upcomingMeetings,
      inactiveDeals: inactiveDeals.map((d) => ({ ...d, value: Number(d.value) })),
    };
  }

  async get(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    const t = await this.prisma.db.task.findFirst({ where: { id, workspaceId: w.id, AND: [this.scope(ctx)] }, include: taskInclude });
    if (!t) throw notFound("That task");
    return t;
  }

  async assertRefs(tx: Tx, workspaceId: string, input: Partial<TaskInputT>) {
    if (input.contactId && !(await tx.contact.findFirst({ where: { id: input.contactId, workspaceId, deletedAt: null } }))) throw notFound("That contact");
    if (input.dealId && !(await tx.deal.findFirst({ where: { id: input.dealId, workspaceId, deletedAt: null } }))) throw notFound("That deal");
    if (input.conversationId && !(await tx.conversation.findFirst({ where: { id: input.conversationId, workspaceId } }))) throw notFound("That conversation");
    if (input.assigneeId && !(await tx.membership.findUnique({ where: { workspaceId_userId: { workspaceId, userId: input.assigneeId } } }))) {
      throw badRequest("Tasks can only be assigned to members of this workspace");
    }
  }

  async create(ctx: RequestContext, input: TaskInputT) {
    const w = ws(ctx);
    const self = ctx.identity?.userId ?? null;
    const assigneeId = input.assigneeId === undefined ? self : input.assigneeId;
    if (assigneeId && assigneeId !== self && !holds(ctx, "tasks.assign")) throw forbidden("Your role cannot assign tasks to other people");
    const task = await this.prisma.db.$transaction(async (tx) => {
      await this.assertRefs(tx, w.id, { ...input, assigneeId });
      const t = await tx.task.create({
        data: {
          workspaceId: w.id,
          type: input.type,
          title: input.title,
          description: input.description ?? "",
          priority: input.priority ?? "medium",
          dueAt: input.dueAt ?? null,
          remindAt: input.remindAt ?? null,
          assigneeId,
          createdById: self,
          contactId: input.contactId ?? null,
          dealId: input.dealId ?? null,
          conversationId: input.conversationId ?? null,
          source: "manual",
        },
        include: taskInclude,
      });
      if (t.contactId) await this.activity.log({ workspaceId: w.id, contactId: t.contactId, dealId: t.dealId, actorId: self, type: "task.created", summary: `Task: ${t.title}` }, tx);
      return t;
    });
    if (assigneeId && assigneeId !== self) {
      await this.notifications.notify(w.id, [assigneeId], { type: "task.assigned", title: `New task: ${task.title}`, body: task.dueAt ? `Due ${task.dueAt.toISOString().slice(0, 16).replace("T", " ")} UTC` : "", link: `/w/${w.id}/tasks?task=${task.id}` });
    }
    return task;
  }

  async update(ctx: RequestContext, id: string, input: Partial<TaskInputT>) {
    const w = ws(ctx);
    const existing = await this.get(ctx, id);
    if (input.assigneeId !== undefined && input.assigneeId !== existing.assigneeId && input.assigneeId !== ctx.identity?.userId && !holds(ctx, "tasks.assign")) {
      throw forbidden("Your role cannot assign tasks to other people");
    }
    await this.prisma.db.$transaction(async (tx) => {
      await this.assertRefs(tx, w.id, input);
      const data: Prisma.TaskUncheckedUpdateInput = {};
      for (const key of ["type", "title", "description", "priority", "dueAt", "remindAt", "assigneeId", "contactId", "dealId", "conversationId"] as const) {
        if (input[key] !== undefined) (data as Record<string, unknown>)[key] = input[key];
      }
      if (input.remindAt !== undefined) data.reminderSentAt = null;
      if (input.dueAt !== undefined) data.overdueSentAt = null;
      if (input.status && input.status !== existing.status) {
        data.status = input.status;
        data.completedAt = input.status === "done" ? new Date() : null;
        data.completedById = input.status === "done" ? actorId(ctx) : null;
        if (input.status === "done" && existing.contactId) {
          await this.activity.log({ workspaceId: w.id, contactId: existing.contactId, dealId: existing.dealId, actorId: actorId(ctx), type: "task.completed", summary: `Completed: ${existing.title}` }, tx);
        }
      }
      await tx.task.update({ where: { id, workspaceId: w.id }, data });
    });
    if (input.assigneeId && input.assigneeId !== existing.assigneeId && input.assigneeId !== ctx.identity?.userId) {
      await this.notifications.notify(w.id, [input.assigneeId], { type: "task.assigned", title: `Task assigned to you: ${input.title ?? existing.title}`, body: "", link: `/w/${w.id}/tasks?task=${id}` });
    }
    return this.get(ctx, id);
  }

  async remove(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    await this.get(ctx, id);
    await this.prisma.db.task.deleteMany({ where: { id, workspaceId: w.id } });
  }

  /** Worker: reminders due now, one notification each (reminderSentAt makes it idempotent). */
  async sendReminders(now = new Date()) {
    // Unscoped by necessity: the sweep looks across workspaces for due reminders, then acts per workspace.
    const due = await this.prisma.unscoped.task.findMany({
      where: { status: "open", remindAt: { lte: now }, reminderSentAt: null, assigneeId: { not: null } },
      take: 500,
    });
    for (const t of due) {
      const claimed = await this.prisma.db.task.updateMany({ where: { id: t.id, workspaceId: t.workspaceId, reminderSentAt: null }, data: { reminderSentAt: now } });
      if (!claimed.count) continue;
      await this.notifications.notify(t.workspaceId, [t.assigneeId!], {
        type: "task.reminder",
        title: `Reminder: ${t.title}`,
        body: t.dueAt ? `Due ${t.dueAt.toISOString().slice(0, 16).replace("T", " ")} UTC` : "",
        link: `/w/${t.workspaceId}/tasks?task=${t.id}`,
        email: true,
      });
    }
    return due.length;
  }

  /**
   * Worker: emits task.overdue once per due date. `overdueSentAt` is claimed in the
   * same transaction as the event, so two sweeps can never both announce a task,
   * and rescheduling a task (update clears the flag) lets it go overdue again.
   */
  async emitOverdue(now = new Date()) {
    let emitted = 0;
    for (;;) {
      // Unscoped: a scheduler discovering due work across every workspace (index Task(status, dueAt)).
      // Claimed tasks drop out of the filter, so each pass sees only tasks not yet announced.
      const overdue = await this.prisma.unscoped.task.findMany({
        where: { status: "open", overdueSentAt: null, dueAt: { lt: now, gt: new Date(now.getTime() - 7 * 86_400_000) } },
        select: { id: true, workspaceId: true, contactId: true, assigneeId: true },
        orderBy: { id: "asc" },
        take: 500,
      });
      if (!overdue.length) break;
      for (const t of overdue) {
        const sent = await this.prisma.db.$transaction(async (tx) => {
          const claimed = await tx.task.updateMany({ where: { id: t.id, workspaceId: t.workspaceId, overdueSentAt: null }, data: { overdueSentAt: now } });
          if (!claimed.count) return false;
          await tx.domainEvent.create({
            data: { workspaceId: t.workspaceId, type: "task.overdue", subjectType: "task", subjectId: t.id, payload: { contactId: t.contactId, assigneeId: t.assigneeId } },
          });
          return true;
        });
        if (sent) emitted += 1;
      }
    }
    if (emitted) await this.events.kick();
    return emitted;
  }
}
