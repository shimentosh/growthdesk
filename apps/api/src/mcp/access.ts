import { MCP_ACCESS_INFO, type McpAccess } from "@growthdesk/shared";
import type { McpCtx, McpTool } from "./tool.js";

/*
 * Who may call what through MCP. Pure, so the rules are unit-tested
 * (access.spec.ts). Three layers, all of which must agree:
 *
 *   1. the person's role in the workspace (permissionsFor, with the
 *      workspace's overrides) — a token is never more than its person;
 *   2. the token's access level (mcpPermissions in @growthdesk/shared):
 *      read → only *.read; build → all but MCP_SEND_PERMISSIONS; send → all;
 *   3. the tool's risk: a Read token calls only read tools; an important tool
 *      only prepares (any Build or Send token whose person's role could do it)
 *      and confirm_action carries it out — Send tokens only.
 */

export const SETTINGS_PATH = "Settings → MCP / Claude";

const needs = (tool: McpTool): string[] => (tool.permission === null ? [] : typeof tool.permission === "string" ? [tool.permission] : [...tool.permission]);

const holdsAny = (held: readonly string[], wanted: string[]) => !wanted.length || wanted.some((p) => held.includes(p));

/** Why this token may not call (or, for an important tool, prepare) this tool — or null when it may. */
export function toolRefusal(tool: McpTool, ctx: Pick<McpCtx, "mcp" | "workspace">): string | null {
  const access = ctx.mcp.access;
  if (access === "read" && tool.risk !== "read") {
    return `This token is read-only, so "${tool.name}" is not available. Create a Build or Send token in ${SETTINGS_PATH} to make changes.`;
  }
  const wanted = needs(tool);
  // Preparing an important action is judged against the role, so a Build token can line one up for review.
  const held = tool.risk === "important" ? ctx.mcp.rolePermissions : ctx.workspace.permissions;
  if (holdsAny(held, wanted)) return null;
  if (holdsAny(ctx.mcp.rolePermissions, wanted)) {
    return `This token's access level (${MCP_ACCESS_INFO[access].label}) does not include ${wanted.join(" or ")}. Create a token with more access in ${SETTINGS_PATH}.`;
  }
  return `Your role (${ctx.workspace.role}) cannot do that — it needs ${wanted.join(" or ")}. A workspace admin can change role permissions.`;
}

/** Why this token may not confirm an important action now — or null when it may. */
export function confirmRefusal(access: McpAccess): string | null {
  if (access === "send") return null;
  return `This token can't send — it is a ${MCP_ACCESS_INFO[access].label} token. Create a Send token ("Build + Send") in ${SETTINGS_PATH}, connect with it, and ask again.`;
}

/** Whether tools/list shows the tool to this token: only what it could call (or prepare). */
export const toolVisible = (tool: McpTool, ctx: Pick<McpCtx, "mcp" | "workspace">) => toolRefusal(tool, ctx) === null;

/** The MCP annotations for a tool: derived from its risk, then the tool's own overrides. */
export function annotationsFor(tool: McpTool) {
  return {
    title: tool.title,
    readOnlyHint: tool.risk === "read",
    destructiveHint: tool.risk === "important",
    idempotentHint: tool.idempotent ?? tool.risk === "read",
    openWorldHint: false,
    ...tool.annotations,
  };
}
