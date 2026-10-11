import { Injectable } from "@nestjs/common";
import { AI_MAX_MESSAGE_CHARS, isUnlimited, type AiDraftInput, type AiReplyDraftInputT, type AiSummaryInputT, type AiWriteInputT } from "@growthdesk/shared";
import type { z } from "zod";
import type { Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { EntitlementsService } from "../billing/entitlements.service.js";
import { InboxService } from "../inbox/inbox.service.js";
import { forbidden, notFound } from "../common/errors.js";
import { actorId, holds, ownershipScope, ws, type RequestContext } from "../common/context.js";
import { AiEngine } from "./ai.engine.js";
import {
  checkTokens,
  classifyPrompt,
  day,
  newMessagePrompt,
  parseClassification,
  parseDraft,
  parseSummary,
  parseWritten,
  replyDraftPrompt,
  summaryPrompt,
  writePrompt,
  type Classification,
  type ContactFacts,
  type Summary,
  type TimelineFacts,
} from "./ai.prompts.js";

/*
 * The AI assistant's features. Each one gathers its context with the
 * caller's own visibility rules (a conversation, contact or deal the person
 * cannot open is 404 here too), builds a prompt (ai.prompts.ts) and runs it
 * through AiEngine (provider, plan, credits, cache, usage).
 *
 * Nothing here sends or saves on anyone's behalf: drafts and written
 * templates are returned to the editor that asked; summaries are returned and
 * cached; the only write is the reply label on a conversation
 * (aiCategory / aiSentiment / aiSummary), which is advisory.
 */

const HOUR = 3_600_000;
const TTL = {
  draft: 24 * HOUR,
  write: 24 * HOUR,
  summary: 7 * 24 * HOUR,
  classify: 30 * 24 * HOUR,
};

const MESSAGE_SHOWN: Prisma.MessageWhereInput = { status: { notIn: ["failed", "queued"] } };

type ClassifyOutcome = { status: "classified"; classification: Classification; cached: boolean } | { status: "skipped"; reason: string };

@Injectable()
export class AiService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: AiEngine,
    private readonly entitlements: EntitlementsService,
    private readonly inbox: InboxService,
  ) {}

  /** What the UI needs to show, hide or disable AI controls — and why. */
  async status(ctx: RequestContext) {
    const w = ws(ctx);
    const [cfg, ent, used, workspace] = await Promise.all([
      this.engine.provider(),
      this.entitlements.forAccount(w.billingAccountId),
      this.entitlements.usage(w.billingAccountId, "monthlyAiCredits"),
      this.prisma.db.workspace.findFirst({ where: { id: w.id }, select: { settings: true } }),
    ]);
    const limit = ent.limits.monthlyAiCredits;
    const permitted = holds(ctx, "ai.use");
    const reason = !cfg
      ? "No AI provider is configured on this installation."
      : !ent.features.ai
        ? `The AI sales assistant is not included in the ${ent.effectivePlan.name} plan.`
        : !permitted
          ? "Your role cannot use the AI assistant."
          : !isUnlimited(limit) && used >= limit
            ? "This month's AI credits are used up. They renew on the 1st."
            : null;
    return {
      available: reason === null,
      reason,
      configured: Boolean(cfg),
      provider: cfg?.provider ?? null,
      model: cfg?.model ?? null,
      planIncludesAi: ent.features.ai,
      plan: ent.effectivePlan.name,
      permitted,
      credits: { used, limit },
      autoClassify: (workspace?.settings as { aiAutoClassify?: boolean } | null)?.aiAutoClassify !== false,
    };
  }

  // ─── Drafts ────────────────────────────────────────────────────────────────

  /** A reply suggestion for an inbox thread. Returned to the composer; never sent. */
  async draftReply(ctx: RequestContext, conversationId: string, input: AiReplyDraftInputT) {
    const w = ws(ctx);
    if (!holds(ctx, "inbox.read")) throw forbidden("Drafting a reply needs access to the inbox");
    const convo = await this.inbox.find(ctx, conversationId);
    const [messages, contact, mailbox] = await Promise.all([
      this.prisma.db.message.findMany({
        where: { workspaceId: w.id, conversationId: convo.id, ...MESSAGE_SHOWN },
        orderBy: { createdAt: "desc" },
        take: 20,
        select: { direction: true, channel: true, createdAt: true, fromAddress: true, subject: true, bodyText: true },
      }),
      convo.contactId ? this.contactFacts(w.id, convo.contactId) : Promise.resolve(null),
      convo.mailboxId ? this.prisma.db.mailbox.findFirst({ where: { id: convo.mailboxId, workspaceId: w.id }, select: { displayName: true } }) : Promise.resolve(null),
    ]);
    if (!messages.some((m) => m.direction === "inbound")) throw notFound("A message to reply to in that conversation");
    const request = replyDraftPrompt({
      senderName: mailbox?.displayName || ctx.identity?.name || "",
      workspaceName: w.name,
      channel: convo.channel,
      tone: input.tone,
      instructions: input.instructions,
      contact: contact ?? (convo.displayName ? { fullName: convo.displayName } : null),
      thread: this.budget(messages.reverse()).map((m) => ({ direction: m.direction, channel: m.channel, at: m.createdAt, from: m.fromAddress, subject: m.subject, body: m.bodyText })),
    });
    const res = await this.engine.run({
      workspaceId: w.id,
      billingAccountId: w.billingAccountId,
      userId: actorId(ctx),
      feature: "reply_draft",
      request,
      parse: parseDraft,
      cacheTtlMs: TTL.draft,
      fresh: input.fresh,
    });
    return { body: res.output, cached: res.cached, model: res.model };
  }

  /** A first message to a contact (inbox compose). */
  async draftMessage(ctx: RequestContext, input: z.infer<typeof AiDraftInput>) {
    const w = ws(ctx);
    if (!holds(ctx, "contacts.read")) throw forbidden("Drafting a message needs access to contacts");
    const visible = await this.prisma.db.contact.findFirst({ where: { id: input.contactId, workspaceId: w.id, deletedAt: null, ...(ownershipScope(ctx) as Prisma.ContactWhereInput) }, select: { id: true } });
    if (!visible) throw notFound("That contact");
    const contact = await this.contactFacts(w.id, input.contactId);
    const res = await this.engine.run({
      workspaceId: w.id,
      billingAccountId: w.billingAccountId,
      userId: actorId(ctx),
      feature: "message_draft",
      request: newMessagePrompt({ senderName: ctx.identity?.name ?? "", workspaceName: w.name, channel: input.channel, tone: input.tone, goal: input.goal, contact: contact! }),
      parse: parseWritten,
      cacheTtlMs: TTL.draft,
    });
    return { subject: input.channel === "email" ? res.output.subject : "", body: res.output.body, cached: res.cached, model: res.model };
  }

  /** Writes or improves a template / sequence step. Personalisation tokens are checked against the workspace's fields. */
  async write(ctx: RequestContext, input: AiWriteInputT) {
    const w = ws(ctx);
    const defs = await this.prisma.db.customFieldDefinition.findMany({ where: { workspaceId: w.id, entity: "contact" }, select: { key: true } });
    const customKeys = defs.map((d) => d.key);
    const res = await this.engine.run({
      workspaceId: w.id,
      billingAccountId: w.billingAccountId,
      userId: actorId(ctx),
      feature: "write",
      request: writePrompt({ ...input, workspaceName: w.name, customKeys }),
      parse: parseWritten,
      cacheTtlMs: TTL.write,
      fresh: input.fresh,
    });
    const original = input.mode === "improve" ? `${input.subject ?? ""}\n${input.body ?? ""}` : "";
    const checked = checkTokens({ subject: input.channel === "email" ? res.output.subject : "", body: res.output.body }, customKeys, original);
    return { ...checked, cached: res.cached, model: res.model };
  }

  // ─── Summaries ─────────────────────────────────────────────────────────────

  /**
   * POST generates (one credit unless the same record state was summarised
   * recently); GET (`generate: false`) only returns a cached summary of the
   * record as it is now, or null — it never calls the provider.
   */
  async summary(ctx: RequestContext, kind: "contact" | "deal", id: string, input: AiSummaryInputT, generate: boolean): Promise<{ summary: Summary | null; cached: boolean; model: string | null }> {
    const w = ws(ctx);
    if (!holds(ctx, kind === "contact" ? "contacts.read" : "deals.read")) throw forbidden(`Summaries need access to ${kind}s`);
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound(kind === "contact" ? "That contact" : "That deal");
    const facts = kind === "contact" ? await this.contactTimeline(ctx, id) : await this.dealTimeline(ctx, id);
    const request = summaryPrompt(facts);
    const feature = kind === "contact" ? "contact_summary" : "deal_summary";
    if (!generate) {
      const hit = await this.engine.peek<Summary>(w.id, feature, request);
      return { summary: hit, cached: Boolean(hit), model: null };
    }
    const res = await this.engine.run({
      workspaceId: w.id,
      billingAccountId: w.billingAccountId,
      userId: actorId(ctx),
      feature,
      request,
      parse: parseSummary,
      cacheTtlMs: TTL.summary,
      fresh: input.fresh,
    });
    return { summary: res.output, cached: res.cached, model: res.model };
  }

  // ─── Reply classification ──────────────────────────────────────────────────

  /** Classify on demand (the inbox "Classify" action). Same rules as the worker, but always runs. */
  async classifyConversation(ctx: RequestContext, conversationId: string) {
    const w = ws(ctx);
    if (!holds(ctx, "inbox.reply") && !holds(ctx, "inbox.assign")) throw forbidden("Labelling a conversation needs permission to work the inbox");
    const convo = await this.inbox.find(ctx, conversationId);
    const last = await this.prisma.db.message.findFirst({
      where: { workspaceId: w.id, conversationId: convo.id, direction: "inbound" },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (!last) throw notFound("An inbound message in that conversation");
    const out = await this.classifyReply(w.id, last.id, { userId: actorId(ctx), manual: true });
    const row = await this.prisma.db.conversation.findFirst({ where: { id: convo.id, workspaceId: w.id }, select: { aiCategory: true, aiSentiment: true, aiSummary: true, aiUpdatedAt: true } });
    return { ...row, cached: out.status === "classified" ? out.cached : false };
  }

  /**
   * Labels an inbound reply and stores the label on its conversation. Called
   * by the `ai` worker for `classify-reply` jobs (queued when a reply is filed)
   * and by classifyConversation. Idempotent: a message that is no longer the
   * latest inbound one, or whose conversation was labelled after it arrived,
   * is skipped. Preflight failures (no provider, plan without AI, credits
   * used up, auto-classify off) throw only for the manual path.
   */
  async classifyReply(workspaceId: string, messageId: string, opts: { userId?: string | null; manual?: boolean } = {}): Promise<ClassifyOutcome> {
    const db = this.prisma.db;
    const message = await db.message.findFirst({
      where: { id: messageId, workspaceId },
      select: { id: true, conversationId: true, direction: true, channel: true, subject: true, bodyText: true, isAutoReply: true, createdAt: true },
    });
    if (!message || message.direction !== "inbound") return { status: "skipped", reason: "not an inbound message" };
    const [workspace, convo, newer] = await Promise.all([
      db.workspace.findFirst({ where: { id: workspaceId }, select: { billingAccountId: true, settings: true } }),
      db.conversation.findFirst({ where: { id: message.conversationId, workspaceId }, select: { id: true, aiUpdatedAt: true } }),
      db.message.count({ where: { workspaceId, conversationId: message.conversationId, direction: "inbound", createdAt: { gt: message.createdAt } } }),
    ]);
    if (!workspace || !convo) return { status: "skipped", reason: "conversation gone" };
    if (!opts.manual) {
      if ((workspace.settings as { aiAutoClassify?: boolean } | null)?.aiAutoClassify === false) return { status: "skipped", reason: "auto-classify is off" };
      if (newer > 0) return { status: "skipped", reason: "a newer reply arrived" };
      if (convo.aiUpdatedAt && convo.aiUpdatedAt >= message.createdAt) return { status: "skipped", reason: "already classified" };
      // Cheap preflight so a workspace without AI never builds a prompt or logs failures.
      if (!(await this.engine.provider("light"))) return { status: "skipped", reason: "no AI provider" };
      const ent = await this.entitlements.forAccount(workspace.billingAccountId);
      if (!ent.features.ai) return { status: "skipped", reason: "plan does not include AI" };
    }
    const previous = await db.message.findFirst({
      where: { workspaceId, conversationId: message.conversationId, direction: "outbound", createdAt: { lt: message.createdAt }, ...MESSAGE_SHOWN },
      orderBy: { createdAt: "desc" },
      select: { subject: true, bodyText: true },
    });
    let res;
    try {
      res = await this.engine.run({
        workspaceId,
        billingAccountId: workspace.billingAccountId,
        userId: opts.userId ?? null,
        feature: "classify",
        tier: "light",
        request: classifyPrompt({
          channel: message.channel,
          reply: { subject: message.subject, body: message.bodyText, isAutoReply: message.isAutoReply },
          previous: previous ? { subject: previous.subject, body: previous.bodyText } : null,
        }),
        parse: parseClassification,
        cacheTtlMs: TTL.classify,
        fresh: opts.manual,
      });
    } catch (e) {
      // Out of credits (402) in the background: leave the reply unlabelled rather than retrying all month.
      if (!opts.manual && (e as { status?: number }).status === 402) return { status: "skipped", reason: "AI credits used up" };
      throw e;
    }
    await db.conversation.updateMany({
      where: { id: convo.id, workspaceId },
      data: { aiCategory: res.output.category, aiSentiment: res.output.sentiment, aiSummary: res.output.summary, aiUpdatedAt: new Date() },
    });
    return { status: "classified", classification: res.output, cached: res.cached };
  }

  // ─── Context gathering ─────────────────────────────────────────────────────

  private async contactFacts(workspaceId: string, contactId: string): Promise<ContactFacts | null> {
    const c = await this.prisma.db.contact.findFirst({
      where: { id: contactId, workspaceId, deletedAt: null },
      select: {
        fullName: true,
        email: true,
        jobTitle: true,
        status: true,
        city: true,
        country: true,
        company: { select: { name: true } },
        deals: { where: { deletedAt: null, status: "open" }, select: { name: true, status: true, stage: { select: { name: true } } }, take: 5 },
      },
    });
    if (!c) return null;
    return {
      fullName: c.fullName,
      email: c.email,
      jobTitle: c.jobTitle,
      company: c.company?.name,
      status: c.status,
      city: c.city,
      country: c.country,
      deals: c.deals.map((d) => ({ name: d.name, stage: d.stage.name, status: d.status })),
    };
  }

  /** Keeps the newest messages within a total character budget (oldest dropped first). */
  private budget<T extends { bodyText: string }>(messages: T[], total = 24_000): T[] {
    const kept: T[] = [];
    let used = 0;
    for (const m of [...messages].reverse()) {
      const size = Math.min(m.bodyText.length, AI_MAX_MESSAGE_CHARS) + 200;
      if (kept.length && used + size > total) break;
      kept.unshift(m);
      used += size;
    }
    return kept;
  }

  private async recentMessages(workspaceId: string, contactId: string, take = 12): Promise<string[]> {
    const rows = await this.prisma.db.message.findMany({
      where: { workspaceId, conversation: { contactId }, ...MESSAGE_SHOWN },
      orderBy: { createdAt: "desc" },
      take,
      select: { direction: true, channel: true, createdAt: true, subject: true, bodyText: true },
    });
    return rows
      .reverse()
      .map((m) => `${day(m.createdAt)} ${m.direction === "inbound" ? "from the contact" : "from our team"} (${m.channel})${m.subject ? ` — ${m.subject}` : ""}: ${clip(m.bodyText, 800)}`);
  }

  private async contactTimeline(ctx: RequestContext, id: string): Promise<TimelineFacts> {
    const w = ws(ctx);
    const db = this.prisma.db;
    const c = await db.contact.findFirst({
      where: { id, workspaceId: w.id, deletedAt: null, ...(ownershipScope(ctx) as Prisma.ContactWhereInput) },
      include: { company: { select: { name: true, industry: true } }, owner: { select: { name: true } } },
    });
    if (!c) throw notFound("That contact");
    const [deals, tasks, meetings, calls, notes, activities, messages] = await Promise.all([
      db.deal.findMany({ where: { workspaceId: w.id, contactId: id, deletedAt: null }, include: { stage: { select: { name: true } } }, orderBy: { createdAt: "desc" }, take: 10 }),
      db.task.findMany({ where: { workspaceId: w.id, contactId: id, status: "open" }, orderBy: { dueAt: { sort: "asc", nulls: "last" } }, take: 10 }),
      db.meeting.findMany({ where: { workspaceId: w.id, contactId: id }, orderBy: { startsAt: "desc" }, take: 10 }),
      db.call.findMany({ where: { workspaceId: w.id, contactId: id }, orderBy: { createdAt: "desc" }, take: 10 }),
      db.note.findMany({ where: { workspaceId: w.id, contactId: id }, orderBy: { createdAt: "desc" }, take: 10 }),
      db.activity.findMany({ where: { workspaceId: w.id, contactId: id }, orderBy: { occurredAt: "desc" }, take: 30 }),
      this.recentMessages(w.id, id),
    ]);
    const header = [
      `Name: ${c.fullName}`,
      c.jobTitle && `Job title: ${c.jobTitle}`,
      c.company && `Company: ${c.company.name}${c.company.industry ? ` (${c.company.industry})` : ""}`,
      `Lead status: ${c.status}; qualification: ${c.qualification}; priority: ${c.priority}`,
      c.leadSource && `Lead source: ${c.leadSource}`,
      c.owner && `Owner: ${c.owner.name}`,
      `Added: ${day(c.createdAt)}`,
      c.lastContactedAt && `Last contacted: ${day(c.lastContactedAt)}`,
      c.lastRepliedAt && `Last replied: ${day(c.lastRepliedAt)}`,
      c.nextActionAt && `Next action: ${day(c.nextActionAt)} ${c.nextActionNote}`,
      c.unsubscribedAt && `Unsubscribed: ${day(c.unsubscribedAt)}`,
      c.doNotContact && "Marked do-not-contact",
      c.bouncedAt && `Email bounced: ${day(c.bouncedAt)}`,
    ]
      .filter(Boolean)
      .join("\n");
    return {
      kind: "contact",
      today: new Date(),
      header: clip(header, 3000),
      sections: [
        { label: "deals", items: deals.map((d) => `${d.name} — ${d.stage.name} (${d.status}), ${Number(d.value)} ${d.currency}${d.expectedCloseDate ? `, expected close ${day(d.expectedCloseDate)}` : ""}`) },
        { label: "open tasks", items: tasks.map((t) => `${t.dueAt ? `due ${day(t.dueAt)}` : "no due date"} — ${t.title} (${t.type})`) },
        { label: "meetings", items: meetings.map((m) => `${day(m.startsAt)} — ${m.title} (${m.status})${m.notes ? `: ${clip(m.notes, 400)}` : ""}`) },
        { label: "calls", items: calls.map((k) => `${day(k.startedAt ?? k.createdAt)} — ${k.direction} call, ${k.status}${k.outcome ? `, outcome ${k.outcome}` : ""}${k.notes ? `: ${clip(k.notes, 400)}` : ""}`) },
        { label: "notes", items: notes.map((n) => `${day(n.createdAt)}: ${clip(n.body, 600)}`) },
        { label: "activity", items: activities.map((a) => `${day(a.occurredAt)} ${a.type}: ${clip(a.summary, 200)}`) },
        { label: "messages", items: messages },
      ],
    };
  }

  private async dealTimeline(ctx: RequestContext, id: string): Promise<TimelineFacts> {
    const w = ws(ctx);
    const db = this.prisma.db;
    const d = await db.deal.findFirst({
      where: { id, workspaceId: w.id, deletedAt: null, ...(ownershipScope(ctx) as Prisma.DealWhereInput) },
      include: { stage: { select: { name: true } }, pipeline: { select: { name: true } }, contact: { select: { id: true, fullName: true, jobTitle: true } }, company: { select: { name: true } }, owner: { select: { name: true } } },
    });
    if (!d) throw notFound("That deal");
    const [history, tasks, meetings, calls, notes, activities, messages] = await Promise.all([
      db.dealStageChange.findMany({ where: { workspaceId: w.id, dealId: id }, orderBy: { changedAt: "asc" }, take: 30 }),
      db.task.findMany({ where: { workspaceId: w.id, dealId: id, status: "open" }, orderBy: { dueAt: { sort: "asc", nulls: "last" } }, take: 10 }),
      db.meeting.findMany({ where: { workspaceId: w.id, dealId: id }, orderBy: { startsAt: "desc" }, take: 10 }),
      db.call.findMany({ where: { workspaceId: w.id, dealId: id }, orderBy: { createdAt: "desc" }, take: 10 }),
      db.note.findMany({ where: { workspaceId: w.id, dealId: id }, orderBy: { createdAt: "desc" }, take: 10 }),
      db.activity.findMany({ where: { workspaceId: w.id, dealId: id }, orderBy: { occurredAt: "desc" }, take: 30 }),
      d.contact ? this.recentMessages(w.id, d.contact.id, 8) : Promise.resolve([]),
    ]);
    const stageIds = [...new Set(history.flatMap((h) => [h.fromStageId, h.toStageId]).filter((s): s is string => Boolean(s)))];
    const stages = new Map((await db.pipelineStage.findMany({ where: { workspaceId: w.id, id: { in: stageIds } }, select: { id: true, name: true } })).map((s) => [s.id, s.name]));
    const header = [
      `Deal: ${d.name}`,
      `Pipeline: ${d.pipeline.name}; stage: ${d.stage.name} (since ${day(d.stageEnteredAt)}); status: ${d.status}`,
      `Value: ${Number(d.value)} ${d.currency}`,
      d.expectedCloseDate && `Expected close: ${day(d.expectedCloseDate)}`,
      d.contact && `Contact: ${d.contact.fullName}${d.contact.jobTitle ? ` (${d.contact.jobTitle})` : ""}`,
      d.company && `Company: ${d.company.name}`,
      d.owner && `Owner: ${d.owner.name}`,
      `Created: ${day(d.createdAt)}`,
      d.closedAt && `Closed: ${day(d.closedAt)}`,
      d.wonReason && `Won reason: ${d.wonReason}`,
      d.lostReason && `Lost reason: ${d.lostReason}`,
      d.description && `Description: ${clip(d.description, 1000)}`,
    ]
      .filter(Boolean)
      .join("\n");
    return {
      kind: "deal",
      today: new Date(),
      header: clip(header, 4000),
      sections: [
        { label: "stage history", items: history.map((h) => `${day(h.changedAt)}: ${h.fromStageId ? (stages.get(h.fromStageId) ?? "?") : "created"} → ${stages.get(h.toStageId) ?? "?"}`) },
        { label: "open tasks", items: tasks.map((t) => `${t.dueAt ? `due ${day(t.dueAt)}` : "no due date"} — ${t.title} (${t.type})`) },
        { label: "meetings", items: meetings.map((m) => `${day(m.startsAt)} — ${m.title} (${m.status})${m.notes ? `: ${clip(m.notes, 400)}` : ""}`) },
        { label: "calls", items: calls.map((k) => `${day(k.startedAt ?? k.createdAt)} — ${k.direction} call, ${k.status}${k.outcome ? `, outcome ${k.outcome}` : ""}${k.notes ? `: ${clip(k.notes, 400)}` : ""}`) },
        { label: "notes", items: notes.map((n) => `${day(n.createdAt)}: ${clip(n.body, 600)}`) },
        { label: "activity", items: activities.map((a) => `${day(a.occurredAt)} ${a.type}: ${clip(a.summary, 200)}`) },
        { label: "messages with the contact", items: messages },
      ],
    };
  }

  /** For the worker's log line. */
  describe(out: ClassifyOutcome): string {
    return out.status === "classified" ? `${out.classification.category}/${out.classification.sentiment}${out.cached ? " (cached)" : ""}` : `skipped: ${out.reason}`;
  }
}

const clip = (s: string, max: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
};
