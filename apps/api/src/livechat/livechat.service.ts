import { createHash, randomBytes } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import type { z } from "zod";
import { WIDGET_DEFAULTS, type WebWidgetInput, type WebWidgetPatch, type WebWidgetSettingsT, type WidgetMessageInput, type WidgetVisitorInput } from "@growthdesk/shared";
import type { ChannelIntegration, ChatVisitor, Message } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { ContactsService } from "../crm/contacts.service.js";
import { ActivityService } from "../crm/activity.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { RealtimeService } from "../realtime/realtime.service.js";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { ApiError, badRequest, forbidden, notFound } from "../common/errors.js";
import { ws, type RequestContext } from "../common/context.js";

/*
 * Website live chat: a "web" channel next to email, WhatsApp and Telegram.
 *
 * A widget is a ChannelIntegration with provider "web_widget". Its webhookKey
 * is the public key in the embed snippet; config holds the look and the rules
 * (WebWidgetSettings). A site loads ${PUBLIC_APP_URL}/widget.js, which frames
 * /chat/<key> — a page of this app, so every call below is same-origin
 * through the /api proxy and no cookie crosses sites.
 *
 * A visitor is identified by a random token the widget keeps in its own
 * storage; only its SHA-256 is stored (ChatVisitor.tokenHash). One
 * conversation per visitor per widget (externalKey "<integrationId>:<visitorId>"),
 * reopened when they write again — the same shape as WhatsApp and Telegram.
 *
 * Live: the agent's inbox hears "conversation changed" on ws:<workspaceId>;
 * the visitor's widget hears new messages on visitor:<visitorId>.
 */

export const WEB_PROVIDER = "web_widget";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const isUnique = (e: unknown) => (e as { code?: string })?.code === "P2002";

export function widgetSettings(i: Pick<ChannelIntegration, "config">): WebWidgetSettingsT {
  const raw = (i.config ?? {}) as Partial<WebWidgetSettingsT>;
  return { ...WIDGET_DEFAULTS, allowedDomains: [], tagIds: [], ...raw } as WebWidgetSettingsT;
}

/** "example.com" allows example.com and *.example.com; a port must match when given. */
export function hostAllowed(allowed: readonly string[], host: string | null | undefined): boolean {
  if (!allowed.length) return true;
  const h = (host ?? "").trim().toLowerCase();
  if (!h) return false;
  const bare = h.replace(/:\d+$/, "");
  return allowed.some((a) => (a.includes(":") ? h === a : bare === a || bare.endsWith(`.${a}`)));
}

/**
 * The website a chat came from ("shop.example.com"), kept as the conversation's
 * subject so the inbox shows it and search finds it — one widget may run on
 * many sites. The loader's reported host first, else the page URL's.
 */
export function siteOf(host: string | null | undefined, pageUrl: string | null | undefined): string {
  const h = (host ?? "").trim().toLowerCase().replace(/:\d+$/, "");
  if (/^[a-z0-9.-]{1,253}$/.test(h)) return h.replace(/^www\./, "");
  try {
    return new URL(pageUrl ?? "").hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** A message as the visitor sees it: theirs, or the team's (with the agent's first name). */
function visitorMessage(m: Message, authors: Map<string, string>) {
  return {
    id: m.id,
    from: m.direction === "inbound" ? ("visitor" as const) : ("agent" as const),
    body: m.bodyText,
    author: m.direction === "outbound" ? (m.authorId ? (authors.get(m.authorId) ?? "") : "") : "",
    at: m.createdAt,
  };
}
export type VisitorMessage = ReturnType<typeof visitorMessage>;

export type WidgetCaller = { key: string; token?: string | null; host?: string | null; ip: string; userAgent: string };

@Injectable()
export class LiveChatService {
  private readonly log = new Logger("livechat");

  constructor(
    private readonly prisma: PrismaService,
    private readonly contacts: ContactsService,
    private readonly activity: ActivityService,
    private readonly notifications: NotificationsService,
    private readonly realtime: RealtimeService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private appUrl() {
    return this.config.PUBLIC_APP_URL.replace(/\/+$/, "");
  }

  // ─── Widgets (workspace settings) ──────────────────────────────────────────

  dto(i: ChannelIntegration) {
    const settings = widgetSettings(i);
    const src = `${this.appUrl()}/widget.js`;
    return {
      id: i.id,
      name: i.name,
      key: i.webhookKey,
      enabled: i.status === "connected",
      settings,
      lastEventAt: i.lastEventAt,
      snippet: `<script src="${src}" data-key="${i.webhookKey}" async></script>`,
      previewUrl: `${this.appUrl()}/chat/${i.webhookKey}?preview=1`,
      createdAt: i.createdAt,
      updatedAt: i.updatedAt,
    };
  }

  private async checkSettings(workspaceId: string, s: Partial<WebWidgetSettingsT>) {
    if (s.assigneeId) {
      const member = await this.prisma.db.membership.findUnique({ where: { workspaceId_userId: { workspaceId, userId: s.assigneeId } } });
      if (!member) throw badRequest("Chats can only be assigned to members of this workspace", { "settings.assigneeId": "Not a member" });
    }
    if (s.tagIds?.length) {
      const found = await this.prisma.db.tag.count({ where: { workspaceId, id: { in: s.tagIds } } });
      if (found !== new Set(s.tagIds).size) throw badRequest("One of those tags does not exist", { "settings.tagIds": "Unknown tag" });
    }
  }

  async listWidgets(ctx: RequestContext) {
    const w = ws(ctx);
    const rows = await this.prisma.db.channelIntegration.findMany({
      where: { workspaceId: w.id, provider: WEB_PROVIDER, deletedAt: null },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((r) => this.dto(r));
  }

  private async widget(workspaceId: string, id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound("That widget");
    const row = await this.prisma.db.channelIntegration.findFirst({ where: { id, workspaceId, provider: WEB_PROVIDER, deletedAt: null } });
    if (!row) throw notFound("That widget");
    return row;
  }

  async createWidget(ctx: RequestContext, input: z.infer<typeof WebWidgetInput>) {
    const w = ws(ctx);
    const settings = { ...widgetSettings({ config: {} }), ...input.settings };
    await this.checkSettings(w.id, settings);
    const row = await this.prisma.db.channelIntegration.create({
      data: {
        workspaceId: w.id,
        channel: "web",
        provider: WEB_PROVIDER,
        name: input.name,
        status: input.enabled ? "connected" : "disconnected",
        config: settings,
        webhookKey: `lc_${randomBytes(18).toString("base64url")}`,
        createdById: ctx.identity?.userId ?? null,
      },
    });
    return this.dto(row);
  }

  async updateWidget(ctx: RequestContext, id: string, input: z.infer<typeof WebWidgetPatch>) {
    const w = ws(ctx);
    const row = await this.widget(w.id, id);
    const settings = { ...widgetSettings(row), ...input.settings };
    if (input.settings) await this.checkSettings(w.id, input.settings);
    const updated = await this.prisma.db.channelIntegration.update({
      where: { id: row.id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.enabled !== undefined ? { status: input.enabled ? "connected" : "disconnected" } : {}),
        config: settings,
      },
    });
    return this.dto(updated);
  }

  async removeWidget(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    const row = await this.widget(w.id, id);
    // Soft delete: past chats keep their conversations; the key stops answering.
    await this.prisma.db.channelIntegration.update({ where: { id: row.id }, data: { deletedAt: new Date(), status: "disconnected" } });
    return { ok: true };
  }

  // ─── The public widget ─────────────────────────────────────────────────────

  /** The widget behind a public key, if it is live and allowed on the caller's site. */
  private async live(caller: WidgetCaller, opts: { preview?: boolean } = {}) {
    if (!/^lc_[A-Za-z0-9_-]{10,60}$/.test(caller.key)) throw notFound("That chat");
    const row = await this.prisma.db.channelIntegration.findFirst({ where: { webhookKey: caller.key, provider: WEB_PROVIDER, deletedAt: null } });
    if (!row) throw notFound("That chat");
    if (row.status !== "connected" && !opts.preview) throw new ApiError(403, "widget_disabled", "This chat is switched off.");
    const settings = widgetSettings(row);
    if (!opts.preview && !hostAllowed(settings.allowedDomains, caller.host)) throw forbidden("This chat is not enabled on this website.");
    return { row, settings };
  }

  async publicConfig(caller: WidgetCaller, preview = false) {
    const { row, settings } = await this.live(caller, { preview });
    const workspace = await this.prisma.db.workspace.findUnique({ where: { id: row.workspaceId }, select: { name: true } });
    return {
      key: row.webhookKey,
      enabled: row.status === "connected",
      name: workspace?.name ?? "",
      title: settings.title,
      greeting: settings.greeting,
      replyTime: settings.replyTime,
      color: settings.color,
      position: settings.position,
      preChat: settings.preChat,
    };
  }

  private async visitorFor(row: ChannelIntegration, token: string | null | undefined): Promise<ChatVisitor | null> {
    if (!token || token.length < 20 || token.length > 100) return null;
    return this.prisma.db.chatVisitor.findFirst({ where: { tokenHash: sha256(token), channelIntegrationId: row.id, workspaceId: row.workspaceId } });
  }

  private async requireVisitor(caller: WidgetCaller) {
    const live = await this.live(caller);
    const visitor = await this.visitorFor(live.row, caller.token);
    if (!visitor) throw new ApiError(401, "no_visitor", "Start a chat first.");
    return { ...live, visitor };
  }

  private async authorNames(ids: (string | null)[]) {
    const unique = [...new Set(ids.filter((x): x is string => Boolean(x)))];
    if (!unique.length) return new Map<string, string>();
    const users = await this.prisma.db.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } });
    return new Map(users.map((u) => [u.id, (u.name ?? "").trim().split(/\s+/)[0] ?? ""]));
  }

  private externalKey(row: ChannelIntegration, visitor: ChatVisitor) {
    return `${row.id}:${visitor.id}`;
  }

  private async thread(row: ChannelIntegration, visitor: ChatVisitor) {
    const convo = await this.prisma.db.conversation.findUnique({ where: { workspaceId_externalKey: { workspaceId: row.workspaceId, externalKey: this.externalKey(row, visitor) } } });
    if (!convo) return [];
    const rows = await this.prisma.db.message.findMany({ where: { workspaceId: row.workspaceId, conversationId: convo.id }, orderBy: { createdAt: "desc" }, take: 200 });
    rows.reverse();
    const names = await this.authorNames(rows.map((m) => m.authorId));
    return rows.map((m) => visitorMessage(m, names));
  }

  private visitorDto(v: ChatVisitor) {
    return { name: v.name, email: v.email };
  }

  /**
   * Opens (or resumes) the visitor's session. With a valid token it is the same
   * visitor; otherwise a new one is made and its token returned once.
   */
  async session(caller: WidgetCaller, input: z.infer<typeof WidgetVisitorInput>) {
    const { row } = await this.live(caller);
    let visitor = await this.visitorFor(row, caller.token);
    let token: string | null = null;
    if (!visitor) {
      token = randomBytes(24).toString("base64url");
      visitor = await this.prisma.db.chatVisitor.create({
        data: {
          workspaceId: row.workspaceId,
          channelIntegrationId: row.id,
          tokenHash: sha256(token),
          pageUrl: input.pageUrl ?? "",
          userAgent: caller.userAgent.slice(0, 500),
        },
      });
    }
    if (input.name !== undefined || input.email !== undefined) visitor = await this.identify(row, visitor, input);
    else visitor = await this.prisma.db.chatVisitor.update({ where: { id: visitor.id }, data: { lastSeenAt: new Date(), ...(input.pageUrl ? { pageUrl: input.pageUrl } : {}) } });
    return { token, visitor: this.visitorDto(visitor), messages: await this.thread(row, visitor) };
  }

  async updateVisitor(caller: WidgetCaller, input: z.infer<typeof WidgetVisitorInput>) {
    const { row, visitor } = await this.requireVisitor(caller);
    const v = await this.identify(row, visitor, input);
    return { visitor: this.visitorDto(v) };
  }

  async messages(caller: WidgetCaller) {
    const { row, visitor } = await this.requireVisitor(caller);
    return { messages: await this.thread(row, visitor) };
  }

  /** Name / email from the pre-chat form or the in-chat prompt; an email links (or makes) the contact. */
  private async identify(row: ChannelIntegration, visitor: ChatVisitor, input: z.infer<typeof WidgetVisitorInput>): Promise<ChatVisitor> {
    const name = input.name?.trim() ?? visitor.name;
    const email = input.email?.trim().toLowerCase() ?? visitor.email;
    let contactId = visitor.contactId;
    if (email && email !== visitor.email) contactId = (await this.contactFor(row, name, email)) ?? contactId;
    const updated = await this.prisma.db.chatVisitor.update({
      where: { id: visitor.id },
      data: { name, email, contactId, lastSeenAt: new Date(), ...(input.pageUrl ? { pageUrl: input.pageUrl } : {}) },
    });
    // The conversation follows: its title and its contact.
    const convo = await this.prisma.db.conversation.findUnique({ where: { workspaceId_externalKey: { workspaceId: row.workspaceId, externalKey: this.externalKey(row, visitor) } } });
    if (convo) {
      await this.prisma.db.conversation.update({
        where: { id: convo.id },
        data: { displayName: name || email || convo.displayName, handle: email || convo.handle, peer: email || convo.peer, ...(contactId && !convo.contactId ? { contactId } : {}) },
      });
      await this.realtime.conversationChanged(row.workspaceId, convo.id, "visitor");
    }
    return updated;
  }

  private async contactFor(row: ChannelIntegration, name: string, email: string): Promise<string | null> {
    const workspace = await this.prisma.db.workspace.findUnique({ where: { id: row.workspaceId }, select: { billingAccountId: true } });
    if (!workspace) return null;
    try {
      const res = await this.contacts.upsert(
        row.workspaceId,
        workspace.billingAccountId,
        { email, ...(name ? { fullName: name } : {}) },
        // An existing contact keeps its own name: a visitor's typing does not overwrite the CRM.
        { source: "web_chat", onDuplicate: "skip", emitEvent: "contact.created", sourceData: { widget: row.name } },
      );
      return res.contactId;
    } catch (e) {
      this.log.warn(`${row.workspaceId}: chat visitor ${email} not linked to a contact — ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  /** A message from the visitor. */
  async visitorMessage(caller: WidgetCaller, input: z.infer<typeof WidgetMessageInput>) {
    const { row, settings, visitor } = await this.requireVisitor(caller);
    if (settings.preChat === "required" && !visitor.email) throw new ApiError(422, "details_required", "Please tell us your name and email first.");
    const db = this.prisma.db;
    const now = new Date();
    const externalKey = this.externalKey(row, visitor);
    const existing = await db.conversation.findUnique({ where: { workspaceId_externalKey: { workspaceId: row.workspaceId, externalKey } } });
    const assigneeId = settings.assigneeId && (await db.membership.findUnique({ where: { workspaceId_userId: { workspaceId: row.workspaceId, userId: settings.assigneeId } } })) ? settings.assigneeId : null;
    const title = visitor.name || visitor.email || "Website visitor";

    const run = () =>
      db.$transaction(async (tx) => {
        const convo = await tx.conversation.upsert({
          where: { workspaceId_externalKey: { workspaceId: row.workspaceId, externalKey } },
          create: {
            workspaceId: row.workspaceId,
            channel: "web",
            contactId: visitor.contactId,
            channelIntegrationId: row.id,
            chatVisitorId: visitor.id,
            externalKey,
            peer: visitor.email,
            handle: visitor.email || row.name,
            displayName: title,
            subject: siteOf(caller.host, input.pageUrl ?? visitor.pageUrl),
            status: "open",
            unread: true,
            assigneeId,
            lastMessageAt: now,
            lastInboundAt: now,
          },
          update: { unread: true, status: "open", snoozedUntil: null, lastMessageAt: now, lastInboundAt: now },
        });
        if (!existing && settings.tagIds.length) {
          const tags = await tx.tag.findMany({ where: { workspaceId: row.workspaceId, id: { in: settings.tagIds } }, select: { id: true } });
          if (tags.length) {
            await tx.conversationTag.createMany({ data: tags.map((t) => ({ workspaceId: row.workspaceId, conversationId: convo.id, tagId: t.id })), skipDuplicates: true });
          }
        }
        const message = await tx.message.create({
          data: {
            workspaceId: row.workspaceId,
            conversationId: convo.id,
            channel: "web",
            direction: "inbound",
            status: "received",
            fromAddress: visitor.email || title,
            toAddress: row.name,
            bodyText: input.body,
            channelIntegrationId: row.id,
            receivedAt: now,
          },
        });
        return { convo, message };
      });

    let filed: Awaited<ReturnType<typeof run>>;
    try {
      filed = await run();
    } catch (e) {
      // Two first messages raced to create the conversation: the second one retries onto it.
      if (!isUnique(e)) throw e;
      filed = await run();
    }
    await db.chatVisitor.update({ where: { id: visitor.id }, data: { lastSeenAt: now, ...(input.pageUrl ? { pageUrl: input.pageUrl } : {}) } });
    await db.channelIntegration.update({ where: { id: row.id }, data: { lastEventAt: now } });

    const out = visitorMessage(filed.message, new Map());
    await this.realtime.publish(`visitor:${visitor.id}`, { type: "message", message: out });
    await this.realtime.conversationChanged(row.workspaceId, filed.convo.id, "message");

    // One notification per burst: when the conversation goes from read (or nothing) to unread.
    if (!existing || !existing.unread || existing.status === "closed") {
      if (!existing && visitor.contactId) {
        await this.activity
          .log({ workspaceId: row.workspaceId, contactId: visitor.contactId, type: "livechat.started", summary: `Started a website chat on ${row.name}`, data: { conversationId: filed.convo.id } })
          .catch(() => undefined);
      }
      const n = { type: "reply.received", title: `${title} on website chat`, body: input.body.slice(0, 200), link: `/w/${row.workspaceId}/inbox?conversation=${filed.convo.id}` };
      const target = filed.convo.assigneeId;
      if (target) await this.notifications.notify(row.workspaceId, [target], n);
      else await this.notifications.notifyRoles(row.workspaceId, ["owner", "admin"], n);
    }
    return { message: out };
  }

  /** Streams the visitor's new messages until the widget goes away. */
  async streamTopics(caller: WidgetCaller) {
    const { visitor } = await this.requireVisitor(caller);
    return [`visitor:${visitor.id}`];
  }

  // ─── The agent's side ──────────────────────────────────────────────────────

  /** An agent's reply from the inbox: stored, then pushed to the visitor's open widget. */
  async agentReply(input: { workspaceId: string; conversationId: string; body: string; authorId: string }) {
    const db = this.prisma.db;
    const convo = await db.conversation.findFirst({ where: { id: input.conversationId, workspaceId: input.workspaceId, channel: "web" } });
    if (!convo) throw notFound("That conversation");
    if (!convo.chatVisitorId) throw badRequest("This chat has no visitor to reply to.");
    const now = new Date();
    const message = await db.$transaction(async (tx) => {
      const m = await tx.message.create({
        data: {
          workspaceId: input.workspaceId,
          conversationId: convo.id,
          channel: "web",
          direction: "outbound",
          status: "sent",
          fromAddress: "",
          toAddress: convo.handle,
          bodyText: input.body,
          authorId: input.authorId,
          channelIntegrationId: convo.channelIntegrationId,
          sentAt: now,
        },
      });
      await tx.conversation.update({ where: { id: convo.id }, data: { lastMessageAt: now, lastOutboundAt: now } });
      return m;
    });
    const names = await this.authorNames([input.authorId]);
    await this.realtime.publish(`visitor:${convo.chatVisitorId}`, { type: "message", message: visitorMessage(message, names) });
    await this.realtime.conversationChanged(input.workspaceId, convo.id, "message");
    return { messageRowId: message.id };
  }

  /** What the inbox shows about the visitor (the right-hand pane). */
  async visitorInfo(workspaceId: string, visitorId: string | null) {
    if (!visitorId) return null;
    const v = await this.prisma.db.chatVisitor.findFirst({
      where: { id: visitorId, workspaceId },
      include: { integration: { select: { id: true, name: true } } },
    });
    if (!v) return null;
    return { name: v.name, email: v.email, pageUrl: v.pageUrl, userAgent: v.userAgent, lastSeenAt: v.lastSeenAt, createdAt: v.createdAt, widget: v.integration };
  }
}
