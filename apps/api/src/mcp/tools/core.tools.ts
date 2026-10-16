import { z } from "zod";
import { MCP_ACCESS_INFO } from "@growthdesk/shared";
import { EntitlementsService } from "../../billing/entitlements.service.js";
import { InboxService } from "../../inbox/inbox.service.js";
import { holds, ownershipScope } from "../../common/context.js";
import { defineTool, definePrompt, defineResource } from "../tool.js";
import { MCP_GUIDE } from "../instructions.js";

/*
 * Core tools: who this connection is, and what is in the workspace. The
 * starting point for every conversation (the server instructions say so).
 */

const countBy = (rows: { status: string; _count: { _all: number } }[]) => {
  const out: Record<string, number> = {};
  for (const r of rows) out[r.status] = r._count._all;
  return out;
};

export const CORE_TOOLS = [
  defineTool({
    name: "whoami",
    title: "Who am I connected as",
    description:
      "The person this connection acts as, the workspace it is bound to, their role, this token's access level (read / build / send), the plan, and the permissions the token holds. Call it when unsure what you are allowed to do.",
    input: z.object({}),
    permission: null,
    risk: "read",
    handler: async (ctx, _args, deps) => {
      const ent = await deps.get(EntitlementsService).forAccount(ctx.workspace.billingAccountId);
      return {
        user: { id: ctx.identity.userId, name: ctx.identity.name, email: ctx.identity.email },
        workspace: { id: ctx.workspace.id, name: ctx.workspace.name, timezone: ctx.workspace.timezone, currency: ctx.workspace.currency },
        role: ctx.workspace.role,
        token: {
          name: ctx.mcp.tokenName,
          access: ctx.mcp.access,
          accessLabel: MCP_ACCESS_INFO[ctx.mcp.access].label,
          canConfirmImportantActions: ctx.mcp.access === "send",
          client: ctx.mcp.clientName,
        },
        plan: { name: ent.effectivePlan.name, state: ent.state, access: ent.access, ...(ent.reason ? { note: ent.reason } : {}) },
        permissions: ctx.workspace.permissions,
      };
    },
  }),

  defineTool({
    name: "workspace_overview",
    title: "Workspace overview",
    description:
      "Counts across the workspace — contacts and leads, open deals, marketing lists, marketing (newsletter) campaigns by status, outreach campaigns by status, open and overdue tasks, unread inbox conversations. Start here. Sections the person's role cannot see are left out.",
    input: z.object({}),
    permission: null,
    risk: "read",
    handler: async (ctx, _args, deps) => {
      const db = deps.prisma.db;
      const workspaceId = ctx.workspace.id;
      const now = new Date();
      const out: Record<string, unknown> = { workspace: ctx.workspace.name };

      if (holds(ctx, "contacts.read")) {
        const where = { workspaceId, deletedAt: null, AND: [ownershipScope(ctx)] };
        const [total, leads] = await Promise.all([db.contact.count({ where }), db.contact.count({ where: { ...where, lifecycleStage: "lead" } })]);
        out.contacts = { total, leads };
      }
      if (holds(ctx, "deals.read")) {
        out.openDeals = await db.deal.count({ where: { workspaceId, status: "open", deletedAt: null, AND: [ownershipScope(ctx)] } });
      }
      if (holds(ctx, "marketing.read")) {
        const [lists, campaigns] = await Promise.all([
          db.marketingList.count({ where: { workspaceId, archivedAt: null } }),
          db.marketingCampaign.groupBy({ by: ["status"], where: { workspaceId, deletedAt: null }, _count: { _all: true } }),
        ]);
        out.marketing = { lists, campaignsByStatus: countBy(campaigns) };
      }
      if (holds(ctx, "campaigns.read")) {
        const rows = await db.campaign.groupBy({ by: ["status"], where: { workspaceId, deletedAt: null }, _count: { _all: true } });
        out.outreachCampaignsByStatus = countBy(rows);
      }
      if (holds(ctx, "tasks.read")) {
        const where = { workspaceId, status: "open" as const, AND: [ownershipScope(ctx, "assigneeId")] };
        const [open, overdue] = await Promise.all([db.task.count({ where }), db.task.count({ where: { ...where, dueAt: { lt: now } } })]);
        out.tasks = { open, overdue };
      }
      if (holds(ctx, "inbox.read")) {
        const unread = await deps.get(InboxService).unreadCount(ctx);
        out.inbox = { unread: unread.total, unreadByChannel: unread.byChannel };
      }
      return out;
    },
  }),

  defineTool({
    name: "list_workspaces",
    title: "List my workspaces",
    description:
      "Every workspace the person belongs to, with their role in each. Informational: this connection stays bound to its own workspace (marked current). To work in another one, the person creates a token there.",
    input: z.object({}),
    permission: null,
    risk: "read",
    handler: async (ctx, _args, deps) => {
      const rows = await deps.prisma.db.membership.findMany({
        where: { userId: ctx.identity.userId, workspace: { deletedAt: null } },
        include: { workspace: { select: { id: true, name: true, status: true } } },
        orderBy: { createdAt: "asc" },
        take: 100,
      });
      return {
        items: rows.map((m) => ({ id: m.workspace.id, name: m.workspace.name, role: m.role, status: m.workspace.status, current: m.workspace.id === ctx.workspace.id })),
        note: `This connection works in "${ctx.workspace.name}" only.`,
      };
    },
  }),
];

export const CORE_PROMPTS = [
  definePrompt({
    name: "growthdesk_status",
    title: "Growthdesk status",
    description: "Summarise what is happening in the workspace and suggest what to do next.",
    render: (_args, ctx) =>
      `Call workspace_overview for "${ctx.workspace.name}", then give me a short status: what needs attention today (unread conversations, overdue tasks, campaigns that are sending or paused) and three concrete next steps.`,
  }),
];

export const CORE_RESOURCES = [
  defineResource({
    uri: "growthdesk://guide",
    name: "guide",
    title: "How to work with Growthdesk",
    description: "How this connection works: access levels, the confirmation rule for important actions, and where to start.",
    mimeType: "text/markdown",
    read: () => MCP_GUIDE,
  }),
];
