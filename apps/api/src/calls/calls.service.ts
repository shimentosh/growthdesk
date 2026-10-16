import { Injectable } from "@nestjs/common";
import type { z } from "zod";
import {
  isFinalCallStatus,
  normalizePhone,
  statusForOutcome,
  type CallListQueryT,
  type CallLogInput,
  type CallQueueAddInputT,
  type CallQueueQuery,
  type CallScriptInput,
  type CallUpdateInputT,
} from "@growthdesk/shared";
import type { Prisma } from "../generated/prisma/client.js";
import { PrismaService, type Tx } from "../prisma/prisma.service.js";
import { EventsService } from "../core/events.service.js";
import { EntitlementsService } from "../billing/entitlements.service.js";
import { ActivityService } from "../crm/activity.service.js";
import { SuppressionService } from "../crm/suppression.service.js";
import { dayBounds } from "../tasks/tasks.service.js";
import { badRequest, notFound } from "../common/errors.js";
import { actorId, holds, me, ownershipScope, ws, type RequestContext } from "../common/context.js";
import { callSummary } from "./call-rules.js";

/*
 * Calling, minus the Twilio line itself (twilio-calls.service.ts): call
 * history, manual logging, outcomes, the call queue and call scripts.
 *
 * A call is "finished" once the line has ended and somebody (or Twilio, for
 * busy / no answer) has recorded an outcome. That moment — and only that one,
 * once per call — writes the contact's timeline entry and the call.completed
 * event (settle()).
 *
 * The call queue is not a table of its own: it is the open call tasks
 * (Task.type = "call") — the ones sequences create with their call steps, the
 * ones a person adds here, and the callbacks an outcome schedules. Working
 * through it is always a person pressing Call on one contact; nothing here
 * dials on its own.
 */

type CallLogInputT = z.infer<typeof CallLogInput>;
type CallQueueQueryT = z.infer<typeof CallQueueQuery>;
type CallScriptInputT = z.infer<typeof CallScriptInput>;

const callInclude = {
  contact: { select: { id: true, fullName: true, firstName: true, lastName: true, email: true, phone: true, deletedAt: true } },
  deal: { select: { id: true, name: true } },
  user: { select: { id: true, name: true } },
  agent: { select: { id: true, name: true } },
} satisfies Prisma.CallInclude;

type CallRow = Prisma.CallGetPayload<{ include: typeof callInclude }>;

/** `full`: with the transcript (one call); lists leave it out. */
export function callDto(c: CallRow, full = true) {
  return {
    id: c.id,
    provider: c.provider,
    direction: c.direction,
    status: c.status,
    outcome: c.outcome,
    notes: c.notes,
    durationSec: c.durationSec,
    fromNumber: c.fromNumber,
    toNumber: c.toNumber,
    startedAt: c.startedAt,
    endedAt: c.endedAt,
    callbackAt: c.callbackAt,
    scriptId: c.scriptId,
    taskId: c.taskId,
    integrationId: c.integrationId,
    contact: c.contact && !c.contact.deletedAt ? { id: c.contact.id, fullName: c.contact.fullName, email: c.contact.email, phone: c.contact.phone } : null,
    deal: c.deal,
    user: c.user,
    /** AI calls: the agent that spoke, what was said, and the judgement on it. */
    agent: c.agent,
    campaignId: c.campaignId,
    summary: c.summary,
    endReason: c.endReason,
    analysis: c.provider === "cartesia" && c.analysis && typeof c.analysis === "object" && Object.keys(c.analysis).length ? c.analysis : null,
    transcript: full && Array.isArray(c.transcript) ? c.transcript : [],
    processedAt: c.processedAt,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

export type CallDto = ReturnType<typeof callDto>;

const name = (c: { fullName?: string | null; email?: string | null; phone?: string | null } | null | undefined) => c?.fullName || c?.email || c?.phone || "";

@Injectable()
export class CallsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
    private readonly entitlements: EntitlementsService,
    private readonly activity: ActivityService,
    private readonly suppression: SuppressionService,
  ) {}

  /** Without records.view_all a person sees the calls they made (and unattributed ones), like tasks. */
  scope(ctx: RequestContext): Prisma.CallWhereInput {
    if (holds(ctx, "records.view_all")) return {};
    return { OR: [{ userId: ctx.identity?.userId }, { userId: null }] };
  }

  // ─── History ───────────────────────────────────────────────────────────────

  async list(ctx: RequestContext, q: CallListQueryT) {
    const w = ws(ctx);
    const and: Prisma.CallWhereInput[] = [this.scope(ctx)];
    if (q.contactId) and.push({ contactId: q.contactId });
    if (q.userId) and.push({ userId: q.userId === "me" ? (ctx.identity?.userId ?? "") : q.userId });
    if (q.status) and.push({ status: q.status });
    if (q.outcome) and.push({ outcome: q.outcome === "none" ? "" : q.outcome });
    if (q.provider) and.push({ provider: q.provider });
    if (q.agentId) and.push({ agentId: q.agentId });
    if (q.from || q.to) and.push({ createdAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lt: q.to } : {}) } });
    const where: Prisma.CallWhereInput = { workspaceId: w.id, AND: and };
    const [rows, total] = await Promise.all([
      this.prisma.db.call.findMany({ where, include: callInclude, orderBy: { createdAt: q.dir === "asc" ? "asc" : "desc" }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      this.prisma.db.call.count({ where }),
    ]);
    return { items: rows.map((r) => callDto(r, false)), total, page: q.page, pageSize: q.pageSize };
  }

  private async find(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    const row = await this.prisma.db.call.findFirst({ where: { id, workspaceId: w.id, AND: [this.scope(ctx)] }, include: callInclude });
    if (!row) throw notFound("That call");
    return row;
  }

  async get(ctx: RequestContext, id: string) {
    return callDto(await this.find(ctx, id));
  }

  /** The links a call may carry, each checked to belong to this workspace (and the contact to be visible to the caller). */
  async assertRefs(ctx: RequestContext, input: { contactId?: string | null; dealId?: string | null; taskId?: string | null; scriptId?: string | null }) {
    const w = ws(ctx);
    const db = this.prisma.db;
    const contact = input.contactId
      ? await db.contact.findFirst({ where: { id: input.contactId, workspaceId: w.id, deletedAt: null, ...ownershipScope(ctx) } })
      : null;
    if (input.contactId && !contact) throw notFound("That contact");
    if (input.dealId && !(await db.deal.findFirst({ where: { id: input.dealId, workspaceId: w.id, deletedAt: null }, select: { id: true } }))) throw notFound("That deal");
    if (input.taskId && !(await db.task.findFirst({ where: { id: input.taskId, workspaceId: w.id }, select: { id: true } }))) throw notFound("That task");
    if (input.scriptId && !(await db.callScript.findFirst({ where: { id: input.scriptId, workspaceId: w.id }, select: { id: true } }))) throw notFound("That call script");
    return contact;
  }

  // ─── Manual logging and outcomes ──────────────────────────────────────────

  /** A call the rep dialled from their own phone, logged afterwards. Nothing is dialled. */
  async log(ctx: RequestContext, input: CallLogInputT) {
    const w = ws(ctx);
    await this.entitlements.assertFeature(w.billingAccountId, "calling");
    const contact = await this.assertRefs(ctx, input);
    const typed = input.toNumber?.trim() ?? "";
    const toNumber = normalizePhone(typed) ?? (typed || normalizePhone(contact?.phone) || contact?.phone || "");
    if (!contact && !toNumber) throw badRequest("Choose a contact or enter the number you called", { contactId: "Choose a contact or enter the number you called" });
    const now = new Date();
    const durationSec = input.durationSec ?? null;
    const actor = actorId(ctx);
    const id = await this.prisma.db.$transaction(async (tx) => {
      const call = await tx.call.create({
        data: {
          workspaceId: w.id,
          contactId: contact?.id ?? null,
          dealId: input.dealId ?? null,
          taskId: input.taskId ?? null,
          scriptId: input.scriptId ?? null,
          userId: actor,
          provider: "manual",
          direction: "outbound",
          toNumber,
          status: statusForOutcome(input.outcome),
          outcome: input.outcome,
          notes: input.notes ?? "",
          durationSec,
          startedAt: durationSec ? new Date(now.getTime() - durationSec * 1000) : now,
          endedAt: now,
          callbackAt: input.callbackAt ?? null,
        },
      });
      if (call.contactId) await this.touchContact(tx, w.id, call.contactId, now);
      await this.applyOutcome(tx, w.id, actor, call, { outcome: "", callbackAt: null });
      await this.settle(tx, w.id, call.id);
      return call.id;
    });
    await this.events.kick();
    return this.get(ctx, id);
  }

  /** Records what happened on a call: outcome, notes, a callback; and for manual calls, the length. */
  async update(ctx: RequestContext, id: string, input: CallUpdateInputT) {
    const w = ws(ctx);
    await this.entitlements.assertFeature(w.billingAccountId, "calling");
    const existing = await this.find(ctx, id);
    if (input.durationSec !== undefined && existing.provider !== "manual") {
      throw badRequest("Twilio reports the length of its own calls; it cannot be edited", { durationSec: "Set by Twilio" });
    }
    await this.assertRefs(ctx, { scriptId: input.scriptId });
    await this.prisma.db.$transaction(async (tx) => {
      const before = await this.lock(tx, w.id, id);
      const data: Prisma.CallUncheckedUpdateInput = {};
      if (input.outcome !== undefined) {
        data.outcome = input.outcome;
        // A manual call's line status follows what the rep says happened; a Twilio call's comes from Twilio.
        if (before.provider === "manual") data.status = statusForOutcome(input.outcome);
      }
      if (input.notes !== undefined) data.notes = input.notes;
      if (input.durationSec !== undefined) data.durationSec = input.durationSec;
      if (input.callbackAt !== undefined) data.callbackAt = input.callbackAt;
      if (input.scriptId !== undefined) data.scriptId = input.scriptId;
      const call = await tx.call.update({ where: { id, workspaceId: w.id }, data });
      // Only an outcome a person states completes the queue task (Twilio's own "busy" leaves it for them to confirm).
      await this.applyOutcome(tx, w.id, actorId(ctx), call, before, input.outcome !== undefined);
      await this.settle(tx, w.id, id);
    });
    await this.events.kick();
    return this.get(ctx, id);
  }

  /** Locks the call row for the rest of the transaction (an UPDATE holds the row lock until commit) and returns it as committed. */
  async lock(tx: Tx, workspaceId: string, id: string) {
    return tx.call.update({ where: { id, workspaceId }, data: { updatedAt: new Date() } });
  }

  /** A call attempt counts as contact: the contact's last-contacted time moves, and a new lead becomes "contacted". */
  async touchContact(tx: Tx, workspaceId: string, contactId: string, at: Date) {
    await tx.contact.updateMany({ where: { id: contactId, workspaceId }, data: { lastContactedAt: at } });
    await tx.contact.updateMany({ where: { id: contactId, workspaceId, status: "new" }, data: { status: "contacted" } });
  }

  /**
   * What a recorded outcome sets in motion:
   *  - the queue task this call was made from is completed (when a person recorded the outcome);
   *  - a new callback time becomes a call task for the caller, so it lands back in their queue;
   *  - "Do not call" puts the number on the workspace's do-not-contact list, which every
   *    call and WhatsApp send checks before it goes out.
   */
  async applyOutcome(
    tx: Tx,
    workspaceId: string,
    actor: string | null,
    call: { id: string; taskId: string | null; contactId: string | null; dealId: string | null; userId: string | null; outcome: string; callbackAt: Date | null; toNumber: string },
    before: { outcome: string; callbackAt: Date | null },
    recordedByPerson = true,
  ) {
    const now = new Date();
    const contact = call.contactId ? await tx.contact.findFirst({ where: { id: call.contactId, workspaceId }, select: { id: true, fullName: true, email: true, phone: true } }) : null;

    if (call.outcome && recordedByPerson && call.taskId) {
      const task = await tx.task.findFirst({ where: { id: call.taskId, workspaceId, status: "open" } });
      if (task) {
        await tx.task.update({ where: { id: task.id, workspaceId }, data: { status: "done", completedAt: now, completedById: actor } });
        if (task.contactId) {
          await this.activity.log({ workspaceId, contactId: task.contactId, dealId: task.dealId, actorId: actor, type: "task.completed", summary: `Completed: ${task.title}`, data: { taskId: task.id, callId: call.id } }, tx);
        }
      }
    }

    const callbackChanged = call.callbackAt && call.callbackAt.getTime() !== before.callbackAt?.getTime();
    if (callbackChanged && call.callbackAt! > now && (call.contactId || call.toNumber)) {
      const who = name(contact) || call.toNumber;
      const task = await tx.task.create({
        data: {
          workspaceId,
          type: "call",
          title: `Call back ${who}`.slice(0, 300),
          description: "Callback requested on an earlier call.",
          dueAt: call.callbackAt,
          assigneeId: call.userId ?? actor,
          createdById: actor,
          contactId: call.contactId,
          dealId: call.dealId,
          source: "manual",
        },
      });
      if (call.contactId) {
        await this.activity.log({ workspaceId, contactId: call.contactId, dealId: call.dealId, actorId: actor, type: "task.created", summary: `Task: ${task.title}`, data: { taskId: task.id, callId: call.id } }, tx);
      }
    }

    if (call.outcome === "do_not_call" && before.outcome !== "do_not_call") {
      const numbers = [...new Set([normalizePhone(call.toNumber), normalizePhone(contact?.phone)].filter((n): n is string => Boolean(n)))];
      for (const n of numbers) await this.suppression.add(workspaceId, "phone", n, "opted_out", "call", actor, tx);
      if (numbers.length && call.contactId) {
        await this.activity.log(
          { workspaceId, contactId: call.contactId, actorId: actor, type: "contact.suppressed", summary: `Asked not to be called: ${numbers.join(", ")} added to the do-not-contact list`, data: { callId: call.id } },
          tx,
        );
      }
    }
  }

  /**
   * The finish line: once a call has ended and has an outcome, write its
   * timeline entry and emit call.completed — exactly once. Callers have
   * already updated (and so locked) the call row in this transaction, which
   * serialises a Twilio callback and a person's save racing to finish it.
   */
  async settle(tx: Tx, workspaceId: string, callId: string): Promise<boolean> {
    const call = await tx.call.findFirst({ where: { id: callId, workspaceId }, include: { contact: { select: { fullName: true, email: true, phone: true } } } });
    if (!call || !isFinalCallStatus(call.status) || !call.outcome) return false;
    const done = await tx.domainEvent.findFirst({ where: { workspaceId, type: "call.completed", subjectType: "call", subjectId: call.id }, select: { id: true } });
    if (done) return false;
    if (call.contactId || call.dealId) {
      await this.activity.log(
        {
          workspaceId,
          contactId: call.contactId,
          dealId: call.dealId,
          actorId: call.userId,
          type: "call.completed",
          summary: callSummary({ contactName: name(call.contact) || call.toNumber, outcome: call.outcome, status: call.status, durationSec: call.durationSec, provider: call.provider }),
          data: { callId: call.id, outcome: call.outcome, status: call.status, durationSec: call.durationSec, provider: call.provider, notes: call.notes.slice(0, 500) },
          occurredAt: call.endedAt ?? new Date(),
        },
        tx,
      );
    }
    await this.events.emitIn(tx, {
      workspaceId,
      type: "call.completed",
      subjectType: "call",
      subjectId: call.id,
      actorId: call.userId,
      payload: {
        callId: call.id,
        contactId: call.contactId,
        dealId: call.dealId,
        taskId: call.taskId,
        userId: call.userId,
        provider: call.provider,
        status: call.status,
        outcome: call.outcome,
        durationSec: call.durationSec,
        callbackAt: call.callbackAt?.toISOString() ?? null,
      },
    });
    return true;
  }

  // ─── Queue ─────────────────────────────────────────────────────────────────

  private taskScope(ctx: RequestContext, scope: "mine" | "team"): Prisma.TaskWhereInput {
    const user = me(ctx).userId;
    if (scope === "mine") return { assigneeId: user };
    // Without records.view_all a person sees their own and unassigned tasks (TasksService's rule).
    if (holds(ctx, "records.view_all")) return {};
    return { OR: [{ assigneeId: user }, { assigneeId: null }] };
  }

  /** Why this contact cannot be called right now, or null. The same rules click-to-call enforces. */
  private blockReason(
    contact: { deletedAt: Date | null; doNotContact: boolean; phone: string | null } | null,
    suppressed: Map<string, string>,
  ): string | null {
    if (!contact || contact.deletedAt) return "The contact no longer exists.";
    if (contact.doNotContact) return "Marked do not contact.";
    const phone = normalizePhone(contact.phone);
    if (!phone) return "No phone number on file.";
    const reason = suppressed.get(phone);
    return reason ? `${phone} is on the do-not-contact list (${reason}).` : null;
  }

  private async suppressedPhones(workspaceId: string, phones: (string | null | undefined)[]) {
    const values = [...new Set(phones.map((p) => normalizePhone(p)).filter((p): p is string => Boolean(p)))];
    if (!values.length) return new Map<string, string>();
    const rows = await this.prisma.db.suppression.findMany({ where: { workspaceId, kind: "phone", value: { in: values } }, select: { value: true, reason: true } });
    return new Map(rows.map((r) => [r.value, r.reason]));
  }

  async queue(ctx: RequestContext, q: CallQueueQueryT) {
    const w = ws(ctx);
    const and: Prisma.TaskWhereInput[] = [this.taskScope(ctx, q.scope)];
    if (q.window === "today") {
      const { end } = dayBounds(w.timezone);
      and.push({ OR: [{ dueAt: null }, { dueAt: { lt: end } }] });
    }
    const where: Prisma.TaskWhereInput = { workspaceId: w.id, type: "call", status: "open", AND: and };
    const [tasks, total] = await Promise.all([
      this.prisma.db.task.findMany({
        where,
        include: {
          contact: {
            select: {
              id: true,
              fullName: true,
              email: true,
              phone: true,
              jobTitle: true,
              timezone: true,
              doNotContact: true,
              deletedAt: true,
              company: { select: { id: true, name: true } },
            },
          },
          deal: { select: { id: true, name: true } },
          assignee: { select: { id: true, name: true } },
        },
        orderBy: [{ dueAt: { sort: "asc", nulls: "last" } }, { priority: "desc" }, { createdAt: "asc" }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      this.prisma.db.task.count({ where }),
    ]);
    const contactIds = [...new Set(tasks.map((t) => t.contactId).filter((id): id is string => Boolean(id)))];
    const [suppressed, lastCalls] = await Promise.all([
      this.suppressedPhones(w.id, tasks.map((t) => t.contact?.phone)),
      contactIds.length
        ? this.prisma.db.call.findMany({
            where: { workspaceId: w.id, contactId: { in: contactIds } },
            distinct: ["contactId"],
            orderBy: [{ contactId: "asc" }, { createdAt: "desc" }],
            select: { id: true, contactId: true, status: true, outcome: true, createdAt: true },
          })
        : Promise.resolve([]),
    ]);
    const lastBy = new Map(lastCalls.map((c) => [c.contactId, c]));
    return {
      items: tasks.map((t) => ({
        taskId: t.id,
        title: t.title,
        description: t.description,
        priority: t.priority,
        dueAt: t.dueAt,
        source: t.source,
        createdAt: t.createdAt,
        assignee: t.assignee,
        deal: t.deal,
        contact: t.contact && !t.contact.deletedAt ? { id: t.contact.id, fullName: t.contact.fullName, email: t.contact.email, phone: t.contact.phone, jobTitle: t.contact.jobTitle, timezone: t.contact.timezone, company: t.contact.company } : null,
        blocked: this.blockReason(t.contact, suppressed),
        lastCall: t.contactId ? (lastBy.get(t.contactId) ?? null) : null,
      })),
      total,
      page: q.page,
      pageSize: q.pageSize,
    };
  }

  /**
   * Puts contacts on the caller's own call list, one call task each. Contacts
   * who cannot be called (do not contact, no number, on the do-not-contact
   * list) and those already on the caller's list are skipped and reported.
   */
  async addToQueue(ctx: RequestContext, input: CallQueueAddInputT) {
    const w = ws(ctx);
    const user = me(ctx).userId;
    await this.entitlements.assertFeature(w.billingAccountId, "calling");
    const ids = [...new Set(input.contactIds)];
    const contacts = await this.prisma.db.contact.findMany({
      where: { workspaceId: w.id, id: { in: ids }, deletedAt: null, ...ownershipScope(ctx) },
      select: { id: true, fullName: true, email: true, phone: true, doNotContact: true, deletedAt: true },
    });
    const queued = await this.prisma.db.task.findMany({
      where: { workspaceId: w.id, type: "call", status: "open", assigneeId: user, contactId: { in: ids } },
      select: { contactId: true },
    });
    const already = new Set(queued.map((t) => t.contactId));
    const suppressed = await this.suppressedPhones(w.id, contacts.map((c) => c.phone));
    const byId = new Map(contacts.map((c) => [c.id, c]));
    const skipped: { contactId: string; reason: string }[] = [];
    const add: (typeof contacts)[number][] = [];
    for (const id of ids) {
      const c = byId.get(id);
      if (!c) skipped.push({ contactId: id, reason: "Not found in this workspace." });
      else if (already.has(id)) skipped.push({ contactId: id, reason: "Already on your call list." });
      else {
        const blocked = this.blockReason(c, suppressed);
        if (blocked) skipped.push({ contactId: id, reason: blocked });
        else add.push(c);
      }
    }
    await this.prisma.db.$transaction(async (tx) => {
      for (const c of add) {
        const task = await tx.task.create({
          data: {
            workspaceId: w.id,
            type: "call",
            title: `Call ${name(c) || "contact"}`.slice(0, 300),
            description: input.note ?? "",
            dueAt: input.dueAt ?? null,
            assigneeId: user,
            createdById: user,
            contactId: c.id,
            source: "manual",
          },
        });
        await this.activity.log({ workspaceId: w.id, contactId: c.id, actorId: user, type: "task.created", summary: `Task: ${task.title}`, data: { taskId: task.id } }, tx);
      }
    });
    return { added: add.length, skipped };
  }

  /** Takes a call task off the list without calling: it is canceled (not deleted), so the record of it stays. */
  async removeFromQueue(ctx: RequestContext, taskId: string) {
    const w = ws(ctx);
    const task = await this.prisma.db.task.findFirst({ where: { id: taskId, workspaceId: w.id, type: "call", status: "open", AND: [this.taskScope(ctx, "team")] } });
    if (!task) throw notFound("That call task");
    await this.prisma.db.task.update({ where: { id: task.id, workspaceId: w.id }, data: { status: "canceled" } });
    return { removed: true };
  }

  // ─── Scripts ───────────────────────────────────────────────────────────────

  async listScripts(ctx: RequestContext) {
    const w = ws(ctx);
    return this.prisma.db.callScript.findMany({ where: { workspaceId: w.id }, orderBy: { name: "asc" } });
  }

  async createScript(ctx: RequestContext, input: CallScriptInputT) {
    const w = ws(ctx);
    await this.entitlements.assertFeature(w.billingAccountId, "calling");
    return this.prisma.db.callScript.create({ data: { workspaceId: w.id, name: input.name, body: input.body, createdById: actorId(ctx) } });
  }

  async updateScript(ctx: RequestContext, id: string, input: Partial<CallScriptInputT>) {
    const w = ws(ctx);
    const res = await this.prisma.db.callScript.updateMany({
      where: { id, workspaceId: w.id },
      data: { ...(input.name !== undefined ? { name: input.name } : {}), ...(input.body !== undefined ? { body: input.body } : {}) },
    });
    if (!res.count) throw notFound("That call script");
    return this.prisma.db.callScript.findFirstOrThrow({ where: { id, workspaceId: w.id } });
  }

  /** Calls that used the script keep their scriptId; the history simply no longer resolves its name. */
  async removeScript(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    const res = await this.prisma.db.callScript.deleteMany({ where: { id, workspaceId: w.id } });
    if (!res.count) throw notFound("That call script");
    return { deleted: true };
  }
}
