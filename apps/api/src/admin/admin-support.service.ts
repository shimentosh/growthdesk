import { Injectable } from "@nestjs/common";
import type { SupportCasePriority, SupportCaseStatus } from "@growthdesk/shared";
import type { Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { AuditService, type AuditInput } from "../core/audit.service.js";
import { me, type RequestContext } from "../common/context.js";
import { badRequest, forbidden, notFound } from "../common/errors.js";

/*
 * Support: the case queue staff work from, and the support view of a
 * customer workspace.
 *
 * The support view is the only way platform staff read a customer's records,
 * and it opens only while the workspace's owner has an active
 * SupportAccessGrant (Settings → Support access, workspaces.service.ts
 * `grantSupportAccess`). Every read is recorded in the customer's own audit
 * log. Credentials — mailbox passwords and tokens, integration secrets,
 * webhook keys — are never selected, grant or not.
 *
 * Reads of tenant models go through the guarded client with the workspace id
 * in every `where`, so the tenant guard still checks them.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const insensitive = (q: string) => ({ contains: q, mode: "insensitive" as const });
const paged = <T>(items: T[], total: number, page: number, pageSize: number) => ({ items, total, page, pageSize });

export const NO_GRANT_MESSAGE =
  "This workspace has not granted support access, or the grant has ended. The workspace owner can grant it in Settings → Support access.";

@Injectable()
export class AdminSupportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private record(ctx: RequestContext, input: AuditInput) {
    return this.audit.record(ctx, { workspaceId: null, ...input }, "platform_admin");
  }

  // ─── Cases ─────────────────────────────────────────────────────────────────

  async listCases(q: { page: number; pageSize: number; q?: string; status?: SupportCaseStatus; workspaceId?: string }) {
    const where: Prisma.SupportCaseWhereInput = {};
    if (q.status) where.status = q.status;
    if (q.workspaceId) where.workspaceId = q.workspaceId;
    if (q.q) where.OR = [{ subject: insensitive(q.q) }, { body: insensitive(q.q) }];
    const [rows, total] = await Promise.all([
      this.prisma.db.supportCase.findMany({
        where,
        include: { _count: { select: { notes: true } } },
        orderBy: [{ updatedAt: "desc" }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      this.prisma.db.supportCase.count({ where }),
    ]);
    const people = await this.people(rows.flatMap((r) => [r.userId, r.assigneeId]));
    const workspaces = await this.workspaces(rows.map((r) => r.workspaceId));
    return paged(
      rows.map((r) => ({
        id: r.id,
        subject: r.subject,
        status: r.status,
        priority: r.priority,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        closedAt: r.closedAt,
        notes: r._count.notes,
        workspace: r.workspaceId ? (workspaces.get(r.workspaceId) ?? null) : null,
        user: r.userId ? (people.get(r.userId) ?? null) : null,
        assignee: r.assigneeId ? (people.get(r.assigneeId) ?? null) : null,
      })),
      total,
      q.page,
      q.pageSize,
    );
  }

  private async people(ids: (string | null)[]) {
    const unique = [...new Set(ids.filter((v): v is string => Boolean(v)))];
    const rows = unique.length ? await this.prisma.db.user.findMany({ where: { id: { in: unique } }, select: { id: true, email: true, name: true } }) : [];
    return new Map(rows.map((u) => [u.id, u]));
  }

  private async workspaces(ids: (string | null)[]) {
    const unique = [...new Set(ids.filter((v): v is string => Boolean(v)))];
    const rows = unique.length ? await this.prisma.db.workspace.findMany({ where: { id: { in: unique } }, select: { id: true, name: true, status: true } }) : [];
    return new Map(rows.map((w) => [w.id, w]));
  }

  async createCase(
    ctx: RequestContext,
    input: { subject: string; body: string; priority: SupportCasePriority; workspaceId?: string | null; userEmail?: string },
  ) {
    let userId: string | null = null;
    if (input.userEmail) {
      const user = await this.prisma.db.user.findUnique({ where: { email: input.userEmail } });
      if (!user) throw badRequest("No account uses that email address", { userEmail: "No account uses this email" });
      userId = user.id;
    }
    if (input.workspaceId && !(await this.prisma.db.workspace.findUnique({ where: { id: input.workspaceId } }))) {
      throw badRequest("That workspace does not exist", { workspaceId: "Unknown workspace" });
    }
    const row = await this.prisma.db.supportCase.create({
      data: { subject: input.subject, body: input.body, priority: input.priority, workspaceId: input.workspaceId ?? null, userId, assigneeId: me(ctx).userId },
    });
    await this.record(ctx, { workspaceId: row.workspaceId, action: "platform.support_case_opened", targetType: "support_case", targetId: row.id, metadata: { subject: row.subject } });
    return this.caseDetail(row.id);
  }

  private async findCase(id: string) {
    if (!UUID.test(id)) throw notFound("That support case");
    const row = await this.prisma.db.supportCase.findUnique({ where: { id }, include: { notes: { orderBy: { createdAt: "asc" } } } });
    if (!row) throw notFound("That support case");
    return row;
  }

  async caseDetail(id: string) {
    const row = await this.findCase(id);
    const people = await this.people([row.userId, row.assigneeId, ...row.notes.map((n) => n.authorId)]);
    const workspace = row.workspaceId ? ((await this.workspaces([row.workspaceId])).get(row.workspaceId) ?? null) : null;
    const grant = row.workspaceId ? await this.activeGrant(row.workspaceId) : null;
    const staff = await this.prisma.db.user.findMany({
      where: { platformRole: { not: "none" }, suspendedAt: null },
      select: { id: true, email: true, name: true, platformRole: true },
      orderBy: { email: "asc" },
    });
    return {
      id: row.id,
      subject: row.subject,
      body: row.body,
      status: row.status,
      priority: row.priority,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      closedAt: row.closedAt,
      workspace,
      user: row.userId ? (people.get(row.userId) ?? null) : null,
      assignee: row.assigneeId ? (people.get(row.assigneeId) ?? null) : null,
      notes: row.notes.map((n) => ({ id: n.id, body: n.body, createdAt: n.createdAt, author: n.authorId ? (people.get(n.authorId) ?? null) : null })),
      supportGrant: grant ? { id: grant.id, expiresAt: grant.expiresAt, reason: grant.reason } : null,
      staff,
    };
  }

  async updateCase(ctx: RequestContext, id: string, input: { status?: SupportCaseStatus; priority?: SupportCasePriority; assigneeId?: string | null }) {
    const row = await this.findCase(id);
    if (input.assigneeId) {
      const assignee = await this.prisma.db.user.findUnique({ where: { id: input.assigneeId } });
      if (!assignee || assignee.platformRole === "none" || assignee.suspendedAt) {
        throw badRequest("Cases can only be assigned to active platform staff", { assigneeId: "Not platform staff" });
      }
    }
    const data: Prisma.SupportCaseUpdateInput = {};
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    if (input.status !== undefined && input.status !== row.status) {
      data.status = input.status;
      data.closedAt = input.status === "closed" ? new Date() : null;
      changes.status = { from: row.status, to: input.status };
    }
    if (input.priority !== undefined && input.priority !== row.priority) {
      data.priority = input.priority;
      changes.priority = { from: row.priority, to: input.priority };
    }
    if (input.assigneeId !== undefined && input.assigneeId !== row.assigneeId) {
      data.assigneeId = input.assigneeId;
      changes.assigneeId = { from: row.assigneeId, to: input.assigneeId };
    }
    if (Object.keys(changes).length) {
      await this.prisma.db.supportCase.update({ where: { id }, data });
      await this.record(ctx, { workspaceId: row.workspaceId, action: "platform.support_case_updated", targetType: "support_case", targetId: id, metadata: { changes } });
    }
    return this.caseDetail(id);
  }

  /** Notes are internal: there is no customer-facing view of a case. */
  async addNote(ctx: RequestContext, id: string, body: string) {
    const row = await this.findCase(id);
    const note = await this.prisma.db.supportCaseNote.create({ data: { caseId: id, authorId: me(ctx).userId, body, internal: true } });
    await this.prisma.db.supportCase.update({ where: { id }, data: { updatedAt: new Date() } });
    await this.record(ctx, { workspaceId: row.workspaceId, action: "platform.support_note_added", targetType: "support_case", targetId: id, metadata: { noteId: note.id } });
    return this.caseDetail(id);
  }

  // ─── Support access ────────────────────────────────────────────────────────

  async activeGrant(workspaceId: string) {
    return this.prisma.db.supportAccessGrant.findFirst({
      where: { workspaceId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { expiresAt: "desc" },
    });
  }

  /** Every workspace whose owner currently allows support in. */
  async activeGrants() {
    const grants = await this.prisma.db.supportAccessGrant.findMany({
      where: { revokedAt: null, expiresAt: { gt: new Date() } },
      include: { workspace: { select: { id: true, name: true, status: true } } },
      orderBy: { expiresAt: "asc" },
    });
    const people = await this.people(grants.map((g) => g.grantedById));
    return grants.map((g) => ({
      id: g.id,
      reason: g.reason,
      createdAt: g.createdAt,
      expiresAt: g.expiresAt,
      workspace: g.workspace,
      grantedBy: people.get(g.grantedById) ?? null,
    }));
  }

  /** The grant that lets support read this workspace now, or a 403 that says how to get one. */
  private async requireGrant(workspaceId: string) {
    if (!UUID.test(workspaceId)) throw notFound("That workspace");
    const workspace = await this.prisma.db.workspace.findUnique({ where: { id: workspaceId }, select: { id: true, name: true, status: true, timezone: true } });
    if (!workspace) throw notFound("That workspace");
    const grant = await this.activeGrant(workspaceId);
    if (!grant) throw forbidden(NO_GRANT_MESSAGE);
    return { workspace, grant };
  }

  private viewed(ctx: RequestContext, workspaceId: string, grantId: string, section: string, extra: Record<string, unknown> = {}) {
    return this.record(ctx, { workspaceId, action: "platform.support_viewed", targetType: "support_grant", targetId: grantId, metadata: { section, ...extra } });
  }

  async supportSummary(ctx: RequestContext, workspaceId: string) {
    const { workspace, grant } = await this.requireGrant(workspaceId);
    const where = { workspaceId };
    const [contacts, deals, conversations, mailboxes, integrations, campaigns, imports, grantedBy] = await Promise.all([
      this.prisma.db.contact.count({ where: { workspaceId, deletedAt: null } }),
      this.prisma.db.deal.count({ where }),
      this.prisma.db.conversation.count({ where }),
      this.prisma.db.mailbox.findMany({
        where: { workspaceId, deletedAt: null },
        // Never the sealed secrets or the sign-in user names.
        select: {
          id: true,
          provider: true,
          email: true,
          displayName: true,
          status: true,
          lastError: true,
          lastCheckedAt: true,
          smtpHost: true,
          smtpPort: true,
          imapEnabled: true,
          imapHost: true,
          imapPort: true,
          dailyLimit: true,
          lastSyncedAt: true,
          syncError: true,
          createdAt: true,
        },
        orderBy: { createdAt: "asc" },
      }),
      this.prisma.db.channelIntegration.findMany({
        where: { workspaceId, deletedAt: null },
        select: { id: true, channel: true, provider: true, name: true, status: true, lastError: true, lastEventAt: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      }),
      this.prisma.db.campaign.findMany({
        where: { workspaceId, deletedAt: null },
        select: {
          id: true,
          name: true,
          status: true,
          startedAt: true,
          enrolledCount: true,
          sentCount: true,
          replyCount: true,
          bounceCount: true,
          failedCount: true,
          updatedAt: true,
        },
        orderBy: { updatedAt: "desc" },
        take: 25,
      }),
      this.prisma.db.import.findMany({
        where,
        select: {
          id: true,
          source: true,
          status: true,
          fileName: true,
          totalRows: true,
          processedRows: true,
          createdCount: true,
          updatedCount: true,
          skippedCount: true,
          failedCount: true,
          errors: true,
          createdAt: true,
          finishedAt: true,
        },
        orderBy: { createdAt: "desc" },
        take: 10,
      }),
      this.prisma.db.user.findUnique({ where: { id: grant.grantedById }, select: { id: true, email: true, name: true } }),
    ]);
    await this.viewed(ctx, workspaceId, grant.id, "summary");
    return {
      workspace,
      grant: { id: grant.id, reason: grant.reason, createdAt: grant.createdAt, expiresAt: grant.expiresAt, grantedBy },
      counts: { contacts, deals, conversations },
      mailboxes,
      integrations,
      campaigns,
      imports: imports.map((i) => ({ ...i, errors: Array.isArray(i.errors) ? i.errors.slice(0, 5) : [] })),
    };
  }

  async supportContacts(ctx: RequestContext, workspaceId: string, q: { page: number; pageSize: number; q?: string }) {
    const { grant } = await this.requireGrant(workspaceId);
    const where: Prisma.ContactWhereInput = { workspaceId, deletedAt: null };
    if (q.q) where.OR = [{ fullName: insensitive(q.q) }, { email: insensitive(q.q) }, { phone: { contains: q.q } }];
    const [rows, total] = await Promise.all([
      this.prisma.db.contact.findMany({
        where,
        select: {
          id: true,
          fullName: true,
          email: true,
          phone: true,
          status: true,
          doNotContact: true,
          unsubscribedAt: true,
          bouncedAt: true,
          lastContactedAt: true,
          lastRepliedAt: true,
          createdAt: true,
          company: { select: { name: true } },
        },
        orderBy: { createdAt: "desc" },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      this.prisma.db.contact.count({ where }),
    ]);
    await this.viewed(ctx, workspaceId, grant.id, "contacts", q.q ? { search: q.q } : {});
    return paged(rows, total, q.page, q.pageSize);
  }

  async supportConversations(ctx: RequestContext, workspaceId: string, q: { page: number; pageSize: number; q?: string }) {
    const { grant } = await this.requireGrant(workspaceId);
    const where: Prisma.ConversationWhereInput = { workspaceId };
    if (q.q) where.OR = [{ subject: insensitive(q.q) }, { handle: insensitive(q.q) }, { displayName: insensitive(q.q) }];
    const [rows, total] = await Promise.all([
      this.prisma.db.conversation.findMany({
        where,
        select: {
          id: true,
          channel: true,
          subject: true,
          handle: true,
          displayName: true,
          status: true,
          lastMessageAt: true,
          mailbox: { select: { email: true } },
          _count: { select: { messages: true } },
        },
        orderBy: { lastMessageAt: { sort: "desc", nulls: "last" } },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      this.prisma.db.conversation.count({ where }),
    ]);
    await this.viewed(ctx, workspaceId, grant.id, "conversations", q.q ? { search: q.q } : {});
    return paged(
      rows.map(({ _count, ...r }) => ({ ...r, messages: _count.messages })),
      total,
      q.page,
      q.pageSize,
    );
  }

  async supportConversation(ctx: RequestContext, workspaceId: string, conversationId: string) {
    const { grant } = await this.requireGrant(workspaceId);
    if (!UUID.test(conversationId)) throw notFound("That conversation");
    const convo = await this.prisma.db.conversation.findFirst({
      where: { id: conversationId, workspaceId },
      select: { id: true, channel: true, subject: true, handle: true, displayName: true, status: true, lastMessageAt: true, mailbox: { select: { email: true } } },
    });
    if (!convo) throw notFound("That conversation");
    const messages = await this.prisma.db.message.findMany({
      where: { workspaceId, conversationId },
      select: {
        id: true,
        direction: true,
        status: true,
        fromAddress: true,
        toAddress: true,
        subject: true,
        bodyText: true,
        error: true,
        isAutoReply: true,
        sentAt: true,
        receivedAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
      take: 200,
    });
    await this.viewed(ctx, workspaceId, grant.id, "conversation", { conversationId });
    return { ...convo, messages };
  }
}
