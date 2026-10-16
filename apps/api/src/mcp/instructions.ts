import { MCP_ACCESS_INFO, MCP_CONFIRMATION_MINUTES } from "@growthdesk/shared";
import type { McpCtx } from "./tool.js";

/*
 * What the MCP client is told about this server (the `instructions` of the
 * initialize result, which Claude reads before using any tool), and the same
 * guide as a resource.
 */

const CONFIRMATION_RULE = `Important actions — sending or scheduling email, launching, pausing or stopping campaigns, deleting records, anything that reaches people outside the workspace or spends the plan's allowances — never happen when you call their tool. The tool answers with a summary and a confirmationId instead. Show that summary to the user, ask them plainly whether to go ahead, and only after they say yes call confirm_action with the confirmationId. Never confirm on the user's behalf or something they have not seen; if they decline, call cancel_action. Confirmations expire after ${MCP_CONFIRMATION_MINUTES} minutes.`;

export const MCP_GUIDE = `# Growthdesk over MCP

Growthdesk is a CRM with email marketing, multichannel outreach campaigns, an inbox, a deal pipeline, tasks and workflows.

## Where to start
Call **workspace_overview** for counts across the workspace, and **whoami** to see who this connection acts as and what its token may do.

## Access levels
- **${MCP_ACCESS_INFO.read.label}** — ${MCP_ACCESS_INFO.read.description}
- **${MCP_ACCESS_INFO.build.label}** — ${MCP_ACCESS_INFO.build.description}
- **${MCP_ACCESS_INFO.send.label}** — ${MCP_ACCESS_INFO.send.description}

A token never does more than its person's role in the workspace allows.

## The confirmation rule
${CONFIRMATION_RULE}

## Lists
List tools are paginated (at most 50 per page). Ask for the next page only when you need it, and prefer search and filters.
`;

export function serverInstructions(ctx: McpCtx): string {
  return [
    `Growthdesk: a CRM with email marketing, outreach campaigns, an inbox, a deal pipeline, tasks and workflows. This connection acts as ${ctx.identity.name || ctx.identity.email} in the workspace "${ctx.workspace.name}" (role: ${ctx.workspace.role}) with ${MCP_ACCESS_INFO[ctx.mcp.access].label} access.`,
    "Start by calling workspace_overview; whoami says what this token may do.",
    `THE CONFIRMATION RULE: ${CONFIRMATION_RULE}`,
    "List tools are paginated (at most 50 per page); prefer search and filters to paging through everything.",
  ].join("\n\n");
}
