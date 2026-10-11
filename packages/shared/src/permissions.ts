import type { WorkspaceRole } from "./enums.js";

/*
 * The workspace permission catalogue.
 *
 * Mechanism adapted from LinkDesk (packages/domain/src/auth/permissions.ts):
 * a role is a list of permission ids, the owner always holds everything, a
 * role cannot be given an action without the matching read, and nobody can
 * grant a permission they do not hold themselves. The catalogue itself is
 * Growthdesk's own.
 *
 * Enforced server-side by the WorkspaceGuard + @Permission() decorator; the
 * web app reads the same list only to hide what a role cannot do.
 */

export type PermissionGroup = {
  id: string;
  label: string;
  permissions: { id: string; label: string }[];
};

export const PERMISSION_GROUPS: PermissionGroup[] = [
  {
    id: "contacts",
    label: "Contacts & companies",
    permissions: [
      { id: "contacts.read", label: "View contacts and companies" },
      { id: "contacts.write", label: "Create and edit contacts and companies" },
      { id: "contacts.delete", label: "Delete and merge contacts" },
      { id: "contacts.import", label: "Import contacts" },
      { id: "contacts.export", label: "Export contacts" },
      { id: "records.view_all", label: "See records owned by other people" },
    ],
  },
  {
    id: "deals",
    label: "Pipeline",
    permissions: [
      { id: "deals.read", label: "View deals" },
      { id: "deals.write", label: "Create and move deals" },
      { id: "deals.delete", label: "Delete deals" },
      { id: "pipelines.manage", label: "Configure pipelines and stages" },
    ],
  },
  {
    id: "tasks",
    label: "Tasks",
    permissions: [
      { id: "tasks.read", label: "View tasks" },
      { id: "tasks.write", label: "Create and complete tasks" },
      { id: "tasks.assign", label: "Assign tasks to other people" },
    ],
  },
  {
    id: "campaigns",
    label: "Campaigns & sequences",
    permissions: [
      { id: "campaigns.read", label: "View campaigns and sequences" },
      { id: "campaigns.write", label: "Create and edit campaigns and sequences" },
      { id: "campaigns.launch", label: "Launch, pause and stop campaigns" },
      { id: "templates.read", label: "View templates" },
      { id: "templates.write", label: "Create and edit templates" },
    ],
  },
  {
    id: "marketing",
    label: "Email marketing",
    permissions: [
      { id: "marketing.read", label: "View lists, designs and marketing campaigns" },
      { id: "marketing.write", label: "Edit lists, designs and campaign drafts" },
      { id: "marketing.send", label: "Send, schedule and pause marketing campaigns" },
      { id: "marketing.manage", label: "Manage sending domains and the email service" },
    ],
  },
  {
    id: "inbox",
    label: "Inbox",
    permissions: [
      { id: "inbox.read", label: "Read conversations" },
      { id: "inbox.reply", label: "Reply and send messages" },
      { id: "inbox.assign", label: "Assign conversations" },
    ],
  },
  {
    id: "calls",
    label: "Calling",
    permissions: [
      { id: "calls.read", label: "View call history" },
      { id: "calls.make", label: "Place and log calls" },
    ],
  },
  {
    id: "automation",
    label: "Automation & AI",
    permissions: [
      { id: "automation.read", label: "View workflows" },
      { id: "automation.write", label: "Create and edit workflows" },
      { id: "ai.use", label: "Use the AI assistant" },
    ],
  },
  {
    id: "analytics",
    label: "Analytics",
    permissions: [
      { id: "analytics.read", label: "View reports" },
      { id: "analytics.team", label: "View team performance" },
    ],
  },
  {
    id: "workspace",
    label: "Workspace administration",
    permissions: [
      { id: "integrations.read", label: "View integrations and mailboxes" },
      { id: "integrations.manage", label: "Connect mailboxes and integrations" },
      { id: "members.read", label: "View team members" },
      { id: "members.manage", label: "Invite, remove and change roles" },
      { id: "settings.manage", label: "Change workspace settings" },
      { id: "billing.read", label: "View plan, usage and invoices" },
      { id: "billing.manage", label: "Change plan and payment details" },
      { id: "apikeys.manage", label: "Manage API keys" },
      { id: "webhooks.manage", label: "Manage webhooks" },
      { id: "data.export", label: "Export workspace data" },
      { id: "audit.read", label: "View the audit log" },
    ],
  },
];

export const ALL_PERMISSIONS: readonly string[] = PERMISSION_GROUPS.flatMap((g) => g.permissions.map((p) => p.id));

export type Permission = (typeof ALL_PERMISSIONS)[number];

/** Never grantable to anyone but the owner. */
export const OWNER_ONLY_PERMISSIONS: readonly string[] = ["billing.manage"];

const READS = ALL_PERMISSIONS.filter((p) => p.endsWith(".read"));
const all = (except: string[] = []) => ALL_PERMISSIONS.filter((p) => !except.includes(p));

export const DEFAULT_ROLE_PERMISSIONS: Record<WorkspaceRole, readonly string[]> = {
  owner: ALL_PERMISSIONS,
  admin: all(["billing.manage"]),
  manager: [
    "contacts.read",
    "contacts.write",
    "contacts.delete",
    "contacts.import",
    "contacts.export",
    "records.view_all",
    "deals.read",
    "deals.write",
    "deals.delete",
    "tasks.read",
    "tasks.write",
    "tasks.assign",
    "campaigns.read",
    "campaigns.write",
    "campaigns.launch",
    "templates.read",
    "templates.write",
    "marketing.read",
    "marketing.write",
    "marketing.send",
    "inbox.read",
    "inbox.reply",
    "inbox.assign",
    "calls.read",
    "calls.make",
    "automation.read",
    "ai.use",
    "analytics.read",
    "analytics.team",
    "integrations.read",
    "members.read",
  ],
  member: [
    "contacts.read",
    "contacts.write",
    "contacts.import",
    "records.view_all",
    "deals.read",
    "deals.write",
    "tasks.read",
    "tasks.write",
    "campaigns.read",
    "campaigns.write",
    "campaigns.launch",
    "templates.read",
    "templates.write",
    "marketing.read",
    "marketing.write",
    "inbox.read",
    "inbox.reply",
    "calls.read",
    "calls.make",
    "automation.read",
    "ai.use",
    "analytics.read",
    "integrations.read",
    "members.read",
  ],
  // Not billing, and not the audit log: it lists every member's IP address and browser.
  viewer: [...READS.filter((p) => p !== "billing.read" && p !== "audit.read"), "records.view_all"],
};

/** The rank used for "you cannot manage someone above you". */
export const ROLE_RANK: Record<WorkspaceRole, number> = { owner: 5, admin: 4, manager: 3, member: 2, viewer: 1 };

export type RolePermissionOverrides = Partial<Record<Exclude<WorkspaceRole, "owner">, string[]>>;

/** The permissions a role holds in a workspace, after that workspace's overrides. */
export function permissionsFor(role: WorkspaceRole, overrides?: RolePermissionOverrides | null): string[] {
  if (role === "owner") return [...ALL_PERMISSIONS];
  const custom = overrides?.[role];
  const list = custom ?? DEFAULT_ROLE_PERMISSIONS[role];
  return list.filter((p) => ALL_PERMISSIONS.includes(p) && !OWNER_ONLY_PERMISSIONS.includes(p));
}

/** Why a proposed permission list cannot be saved, or null when it can. */
export function rolePermissionTrouble(permissions: string[]): string | null {
  const unknown = permissions.filter((p) => !ALL_PERMISSIONS.includes(p));
  if (unknown.length) return `Unknown permission: ${unknown.join(", ")}`;
  const ownerOnly = permissions.filter((p) => OWNER_ONLY_PERMISSIONS.includes(p));
  if (ownerOnly.length) return `Only the owner can hold: ${ownerOnly.join(", ")}`;
  const held = new Set(permissions);
  for (const p of permissions) {
    const [group, action] = p.split(".");
    if (!group || action === "read" || action === "view_all") continue;
    const read = `${group}.read`;
    if (ALL_PERMISSIONS.includes(read) && !held.has(read)) {
      return `"${p}" needs "${read}" as well — a role cannot act on something it cannot see.`;
    }
  }
  return null;
}

export const can = (held: readonly string[], permission: string) => held.includes(permission);
