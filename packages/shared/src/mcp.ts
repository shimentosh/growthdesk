import { z } from "zod";
import { isoDate, requiredText } from "./schemas.js";

/*
 * MCP (Model Context Protocol): Claude and other AI clients driving a
 * workspace through apps/api/src/mcp (docs/MCP.md).
 *
 * An MCP token is personal: it acts as the person who created it, in one
 * workspace, and never beyond that person's role. Its access level narrows the
 * role further (mcpPermissions). Separately from the level, every tool marked
 * "important" only ever prepares its action; the person approves it in the
 * chat and the client calls confirm_action, which only a Send token may do.
 */

export const MCP_ACCESS_LEVELS = ["read", "build", "send"] as const;
export type McpAccess = (typeof MCP_ACCESS_LEVELS)[number];

export const MCP_ACCESS_INFO: Record<McpAccess, { label: string; description: string }> = {
  read: {
    label: "Read only",
    description: "Claude can look things up — contacts, lists, campaigns, reports — but cannot change anything.",
  },
  build: {
    label: "Build (drafts, no sending)",
    description:
      "Claude can create and edit contacts, lists, templates, campaign drafts and workflows. It can prepare a send or a launch for you to review, but can never carry it out.",
  },
  send: {
    label: "Build + Send",
    description:
      "Everything Build can do, and Claude can send, launch and delete — but every important action waits until you approve it in the chat.",
  },
};

/**
 * Permissions only a Send token carries: actions that reach people outside the
 * workspace, spend allowances, destroy or export data, or change who can do
 * what. A Build token holds the rest of its creator's role; a Read token only
 * the `.read` permissions (plus records.view_all, which widens what can be seen,
 * never what can be done).
 */
export const MCP_SEND_PERMISSIONS: readonly string[] = [
  "campaigns.launch",
  "marketing.send",
  "marketing.manage",
  "inbox.reply",
  "calls.make",
  "contacts.delete",
  "contacts.erase",
  "contacts.export",
  "deals.delete",
  "data.export",
  "integrations.manage",
  "members.manage",
  "settings.manage",
  "billing.manage",
  "apikeys.manage",
  "webhooks.manage",
];

/** What a token at `access` may do, given the permissions its creator's role holds. Never more than `held`. */
export function mcpPermissions(held: readonly string[], access: McpAccess): string[] {
  if (access === "send") return [...held];
  if (access === "read") return held.filter((p) => p.endsWith(".read") || p === "records.view_all");
  return held.filter((p) => !MCP_SEND_PERMISSIONS.includes(p));
}

/** Personal MCP tokens start with this, so a leaked one is recognisable (secret scanners, logs). */
export const MCP_TOKEN_PREFIX = "gdm_";

/** Active tokens one person may hold in one workspace. */
export const MAX_MCP_TOKENS = 20;

/** How long an important action waits for confirm_action before it lapses. */
export const MCP_CONFIRMATION_MINUTES = 10;

export const McpTokenInput = z.object({
  name: requiredText(80),
  access: z.enum(MCP_ACCESS_LEVELS),
  expiresAt: isoDate.nullable().optional(),
});
