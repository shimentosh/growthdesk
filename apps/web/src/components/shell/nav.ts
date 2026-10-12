import {
  BarChart3,
  Building2,
  CalendarDays,
  CheckSquare,
  FileText,
  Handshake,
  Home,
  Inbox,
  ListChecks,
  ListOrdered,
  Palette,
  Phone,
  Send,
  Settings,
  Upload,
  UserPlus,
  Users,
  Workflow,
  type LucideIcon,
} from "lucide-react";

/*
 * The workspace sidebar. Every link points at a screen that exists and whose
 * API is live; an area without a backend is left out rather than shown as a
 * dead end.
 *
 * `permission` hides the link from roles that cannot use it (any-of for an
 * array). The page itself still gates with <RequirePermission>, and the API
 * refuses regardless.
 */

export type NavItem = {
  /** Path under /w/:id ("" is the workspace home). */
  href: string;
  label: string;
  icon: LucideIcon;
  permission?: string | readonly string[];
  /** Active only on an exact match. */
  exact?: boolean;
  /** Other paths under /w/:id that also light this link (screens reached from it). */
  also?: string[];
};

/**
 * A labelled group can be collapsed from its header (remembered per browser
 * under its `id`); the group holding the current page always stays open.
 */
export type NavGroup = { id: string; label?: string; items: NavItem[] };

export const NAV: NavGroup[] = [
  {
    id: "main",
    items: [
      { href: "", label: "Home", icon: Home, exact: true },
      { href: "/inbox", label: "Inbox", icon: Inbox, permission: "inbox.read" },
      { href: "/tasks", label: "Tasks", icon: CheckSquare, permission: "tasks.read" },
    ],
  },
  {
    id: "crm",
    label: "CRM",
    items: [
      { href: "/leads", label: "Leads", icon: UserPlus, permission: "contacts.read" },
      { href: "/contacts", label: "Contacts", icon: Users, permission: "contacts.read" },
      { href: "/companies", label: "Companies", icon: Building2, permission: "contacts.read" },
      { href: "/imports", label: "Imports", icon: Upload, permission: "contacts.import" },
    ],
  },
  {
    // Outreach (1:1 sequences) and marketing (one-to-many email) are two engines behind one list.
    id: "campaigns",
    label: "Campaigns",
    items: [
      { href: "/campaigns", label: "Campaigns", icon: Send, permission: ["campaigns.read", "marketing.read"], also: ["/marketing/campaigns"] },
      { href: "/marketing/lists", label: "Lead lists", icon: ListChecks, permission: ["marketing.read", "contacts.read"] },
      { href: "/sequences", label: "Sequences", icon: ListOrdered, permission: "campaigns.read" },
      { href: "/templates", label: "Templates", icon: FileText, permission: "templates.read" },
      { href: "/marketing/designs", label: "Email designs", icon: Palette, permission: "marketing.read" },
    ],
  },
  {
    id: "sales",
    label: "Sales",
    items: [
      { href: "/deals", label: "Deals", icon: Handshake, permission: "deals.read" },
      { href: "/meetings", label: "Meetings", icon: CalendarDays, permission: ["deals.read", "contacts.read"] },
      { href: "/calls", label: "Calls", icon: Phone, permission: "calls.read" },
    ],
  },
  {
    id: "automate",
    label: "Automate",
    items: [{ href: "/automation", label: "Workflows", icon: Workflow, permission: "automation.read" }],
  },
  {
    id: "insights",
    label: "Insights",
    items: [{ href: "/reports", label: "Reports", icon: BarChart3, permission: "analytics.read" }],
  },
];

/** Pinned to the bottom of the sidebar, below the scrolling groups. */
export const NAV_FOOTER: NavItem[] = [{ href: "/settings", label: "Settings", icon: Settings }];

/** The settings sub-navigation (left column inside /settings). */
export type SettingsItem = { href: string; label: string; permission?: string | readonly string[] };
export type SettingsGroup = { label: string; items: SettingsItem[] };

export const SETTINGS_NAV: SettingsGroup[] = [
  {
    label: "Workspace",
    items: [
      { href: "/settings/general", label: "General" },
      { href: "/settings/company", label: "Company profile", permission: "settings.manage" },
      { href: "/settings/members", label: "Members", permission: "members.read" },
      { href: "/settings/roles", label: "Roles & permissions", permission: "members.read" },
      { href: "/settings/billing", label: "Plan & billing", permission: "billing.read" },
    ],
  },
  {
    label: "Outreach",
    items: [
      { href: "/settings/mailboxes", label: "Mailboxes", permission: "integrations.read" },
      { href: "/settings/channels", label: "WhatsApp & Telegram", permission: "integrations.read" },
      { href: "/settings/calling", label: "Calling", permission: "integrations.read" },
    ],
  },
  {
    label: "Marketing",
    items: [{ href: "/settings/sending-domains", label: "Sending domains", permission: "marketing.read" }],
  },
  {
    label: "Data",
    items: [
      { href: "/settings/pipelines", label: "Pipelines", permission: "deals.read" },
      { href: "/settings/tags", label: "Tags", permission: "contacts.read" },
      { href: "/settings/fields", label: "Custom fields", permission: "contacts.read" },
      { href: "/settings/suppressions", label: "Suppression list", permission: "contacts.read" },
    ],
  },
  {
    label: "Developers",
    items: [
      { href: "/settings/api-keys", label: "API keys", permission: "apikeys.manage" },
      { href: "/settings/webhooks", label: "Webhooks", permission: "webhooks.manage" },
    ],
  },
  {
    label: "Security",
    items: [
      { href: "/settings/audit", label: "Audit log", permission: "audit.read" },
      { href: "/settings/support-access", label: "Support access", permission: "settings.manage" },
      { href: "/settings/data", label: "Data & privacy", permission: "data.export" },
    ],
  },
];
