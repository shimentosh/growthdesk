import { Injectable } from "@nestjs/common";
import { MCP_CONFIRMATION_MINUTES } from "@growthdesk/shared";
import { PrismaService } from "../prisma/prisma.service.js";
import { conflict, notFound } from "../common/errors.js";
import type { McpCtx, McpPreview } from "./tool.js";

/*
 * The two-step confirmation behind every "important" MCP tool (docs/MCP.md).
 *
 * Calling an important tool stores what it would do — tool, validated
 * arguments, the preview the person is shown — as a McpPendingAction and
 * changes nothing else. confirm_action (McpRuntime.confirm) then runs it:
 *   - only through the same token that prepared it,
 *   - only within MCP_CONFIRMATION_MINUTES,
 *   - only once: claim() is a conditional update, so two concurrent
 *     confirmations cannot both win,
 *   - and only for a Send token (access.ts confirmRefusal), checked by the runtime.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PendingState = { tokenId: string; expiresAt: Date; confirmedAt: Date | null; canceledAt: Date | null };

/** Why a pending action cannot be confirmed (or canceled) by this token now — or null when it can. */
export function pendingTrouble(row: PendingState, tokenId: string, now: Date): string | null {
  if (row.tokenId !== tokenId) return "That confirmation was prepared through a different connection. Prepare the action again through this one.";
  if (row.confirmedAt) return "That action was already confirmed — an action runs only once. Call the tool again to prepare a new one.";
  if (row.canceledAt) return "That action was canceled. Call the tool again to prepare a new one.";
  if (row.expiresAt.getTime() <= now.getTime()) {
    return `That confirmation expired (they last ${MCP_CONFIRMATION_MINUTES} minutes). Call the tool again to prepare a fresh one, show it to the user, then confirm.`;
  }
  return null;
}

@Injectable()
export class McpConfirmationsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(ctx: McpCtx, tool: string, args: unknown, preview: McpPreview, now = new Date()) {
    return this.prisma.db.mcpPendingAction.create({
      data: {
        workspaceId: ctx.workspace.id,
        tokenId: ctx.mcp.tokenId,
        userId: ctx.identity.userId,
        tool,
        args: (args ?? {}) as never,
        summary: preview.summary.slice(0, 4000),
        preview: (preview.details ?? {}) as never,
        expiresAt: new Date(now.getTime() + MCP_CONFIRMATION_MINUTES * 60_000),
      },
    });
  }

  /** The pending action, when this token may still act on it; otherwise an error saying why. */
  async open(ctx: McpCtx, id: string, now = new Date()) {
    if (!UUID.test(id)) throw notFound("That confirmation");
    const row = await this.prisma.db.mcpPendingAction.findFirst({ where: { id, workspaceId: ctx.workspace.id } });
    if (!row) throw notFound("That confirmation");
    const trouble = pendingTrouble(row, ctx.mcp.tokenId, now);
    if (trouble) throw conflict(trouble);
    return row;
  }

  /** Marks it confirmed. Conditional, so exactly one caller can claim a confirmation. */
  async claim(ctx: McpCtx, id: string, now = new Date()) {
    const { count } = await this.prisma.db.mcpPendingAction.updateMany({
      where: { id, workspaceId: ctx.workspace.id, tokenId: ctx.mcp.tokenId, confirmedAt: null, canceledAt: null, expiresAt: { gt: now } },
      data: { confirmedAt: now },
    });
    if (count !== 1) throw conflict("That action was already confirmed — an action runs only once. Call the tool again to prepare a new one.");
  }

  /** What running it produced (kept, trimmed, for the activity page). */
  async finish(ctx: McpCtx, id: string, result: Record<string, unknown>) {
    await this.prisma.db.mcpPendingAction.updateMany({ where: { id, workspaceId: ctx.workspace.id }, data: { result: result as never } });
  }

  async cancel(ctx: McpCtx, id: string, now = new Date()) {
    const row = await this.open(ctx, id, now);
    await this.prisma.db.mcpPendingAction.updateMany({
      where: { id: row.id, workspaceId: ctx.workspace.id, confirmedAt: null, canceledAt: null },
      data: { canceledAt: now },
    });
    return row;
  }

  /** Actions this token has prepared that still await confirmation. */
  async pending(ctx: McpCtx, now = new Date()) {
    return this.prisma.db.mcpPendingAction.findMany({
      where: { workspaceId: ctx.workspace.id, tokenId: ctx.mcp.tokenId, confirmedAt: null, canceledAt: null, expiresAt: { gt: now } },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
  }
}
