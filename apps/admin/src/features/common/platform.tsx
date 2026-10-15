"use client";

import Link from "next/link";
import { createContext, useContext, type ReactNode } from "react";
import { Building2, LayoutDashboard, MailCheck, Package, Palette, Users, type LucideIcon } from "lucide-react";
import { labelOf, type PlatformRole } from "@growthdesk/shared";
import { describeAction, table } from "./labels";
import { Badge, type Tone } from "@/components/ui/Badge";
import { IconTile, type Tint } from "@/components/ui/IconTile";
import { ENTITY } from "@/components/ui/icons";
import { cn } from "@/lib/cn";
import { useFormat } from "@/lib/session";
import type { AdminAuditRow, Person } from "@/features/common/types";

/*
 * Pieces every platform-admin screen shares: the viewer's platform role,
 * role chips, a person cell and the audit table. The table classes and the
 * action wording are the workspace admin's own (components/admin/labels.ts),
 * so both audit logs read the same.
 */

export { table, describeAction };

/*
 * One glyph and one colour per platform-admin screen, used by the sidebar,
 * the page headers and the main empty states. Concepts the customer app
 * already has (billing, support access, audit, settings) keep their ENTITY
 * look; the rest are the admin area's own.
 */
export const PLATFORM = {
  overview: { icon: LayoutDashboard, tint: "blue" },
  users: { icon: Users, tint: "indigo" },
  workspaces: { icon: Building2, tint: "teal" },
  billing: ENTITY.billing,
  plans: { icon: Package, tint: "orange" },
  support: ENTITY.supportAccess,
  audit: ENTITY.audit,
  email: { icon: MailCheck, tint: "cyan" },
  library: { icon: Palette, tint: "purple" },
  settings: ENTITY.settings,
} as const satisfies Record<string, { icon: LucideIcon; tint: Tint }>;

export type PlatformSection = keyof typeof PLATFORM;

/** The section's coloured tile, e.g. <PlatformTile of="users" /> on a page header. */
export function PlatformTile({ of, size = "lg", className }: { of: PlatformSection; size?: "sm" | "md" | "lg" | "xl"; className?: string }) {
  const { icon: Icon, tint } = PLATFORM[of];
  return <IconTile icon={<Icon />} tint={tint} size={size} className={className} />;
}

/** Props for a screen's main empty state: the section's glyph on its tile. */
export function platformEmpty(of: PlatformSection) {
  const { icon: Icon, tint } = PLATFORM[of];
  return { icon: <Icon />, tint };
}

/** Query keys for platform-admin data: ["platform", …]. */
export const platformKey = (...parts: unknown[]) => ["platform", ...parts];

export const PLATFORM_RANK: Record<PlatformRole, number> = { none: 0, support: 1, admin: 2, owner: 3 };

const PlatformRoleContext = createContext<PlatformRole>("none");

export function PlatformRoleProvider({ role, children }: { role: PlatformRole; children: ReactNode }) {
  return <PlatformRoleContext.Provider value={role}>{children}</PlatformRoleContext.Provider>;
}

/** The signed-in staff member's platform role, and what it allows (the API enforces the same ranks). */
export function usePlatform() {
  const role = useContext(PlatformRoleContext);
  return {
    role,
    /** Support reads; admins and owners change things. */
    canChange: PLATFORM_RANK[role] >= PLATFORM_RANK.admin,
    isOwner: role === "owner",
  };
}

export const PLATFORM_ROLE_LABELS: Record<PlatformRole, string> = {
  none: "Customer",
  support: "Support",
  admin: "Admin",
  owner: "Owner",
};

export const PLATFORM_ROLE_HELP: Record<PlatformRole, string> = {
  none: "No platform access — a customer account.",
  support: "Reads everything in platform admin, works support cases, and opens the support view of workspaces that granted access.",
  admin: "Support, plus suspending workspaces, disabling accounts, assigning plans and changing platform settings.",
  owner: "Everything, including appointing admins and owners.",
};

export function PlatformRoleBadge({ role }: { role: PlatformRole }) {
  if (role === "none") return <span className="text-text-3">—</span>;
  const tone: Tone = role === "owner" ? "info" : role === "admin" ? "live" : "mute";
  return (
    <Badge tone={tone} quiet>
      {PLATFORM_ROLE_LABELS[role]}
    </Badge>
  );
}

/** Name over email, linking to the user's admin page. */
export function PersonCell({ person, link = true }: { person: Person | null | undefined; link?: boolean }) {
  if (!person) return <span className="text-text-3">—</span>;
  const body = (
    <>
      <div className="truncate">{person.name || person.email}</div>
      {person.name && <div className="truncate text-xs text-text-3">{person.email}</div>}
    </>
  );
  return link ? (
    <Link href={`/users/${person.id}`} className="block min-w-0 hover:underline">
      {body}
    </Link>
  ) : (
    <div className="min-w-0">{body}</div>
  );
}

/** A short id with the full one on hover. */
export function ShortId({ id }: { id: string }) {
  return (
    <span className="font-mono text-xs text-text-3" title={id}>
      {id.length > 12 ? `${id.slice(0, 8)}…` : id}
    </span>
  );
}

const ACTOR_TYPES: Record<string, string> = {
  platform_admin: "Platform staff",
  api_key: "API key",
  system: "System",
  user: "Customer",
};

function show(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (Array.isArray(value)) return value.map(show).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function Metadata({ metadata }: { metadata: Record<string, unknown> }) {
  const entries = Object.entries(metadata ?? {});
  if (!entries.length) return <span className="text-text-3">—</span>;
  return (
    <dl className="flex flex-col gap-0.5 text-xs">
      {entries.slice(0, 5).map(([k, v]) => (
        <div key={k} className="flex min-w-0 gap-1.5">
          <dt className="shrink-0 text-text-3">{labelOf(k)}</dt>
          <dd className="min-w-0 truncate text-text-2" title={show(v)}>
            {show(v)}
          </dd>
        </div>
      ))}
      {entries.length > 5 && <div className="text-text-3">+{entries.length - 5} more</div>}
    </dl>
  );
}

/** Audit events, newest first. `showWorkspace` adds the workspace column (the platform-wide log). */
export function AuditTable({ rows, showWorkspace }: { rows: AdminAuditRow[]; showWorkspace?: boolean }) {
  const f = useFormat();
  return (
    <div className={table.wrap}>
      <table className={table.table}>
        <thead>
          <tr>
            <th className={table.th}>When</th>
            <th className={table.th}>Who</th>
            <th className={table.th}>What</th>
            {showWorkspace && <th className={table.th}>Workspace</th>}
            <th className={table.th}>Details</th>
            <th className={table.th}>IP address</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => (
            <tr key={e.id} className="align-top">
              <td className={cn(table.td, "align-top whitespace-nowrap text-text-2")}>{f.dateTime(e.createdAt)}</td>
              <td className={cn(table.td, "max-w-56 align-top")}>
                {e.actor ? <PersonCell person={e.actor} /> : <span className="text-text-2">{ACTOR_TYPES[e.actorType] ?? labelOf(e.actorType || "unknown")}</span>}
                {e.actor && e.actorType === "platform_admin" && <div className="text-2xs text-text-3">Platform staff</div>}
              </td>
              <td className={cn(table.td, "align-top")}>
                <div className="font-medium whitespace-nowrap" title={e.action}>
                  {describeAction(e.action)}
                </div>
                {e.targetType && (
                  <div className="text-xs text-text-3">
                    {labelOf(e.targetType)} {e.targetId && <ShortId id={e.targetId} />}
                  </div>
                )}
              </td>
              {showWorkspace && (
                <td className={cn(table.td, "max-w-48 align-top")}>
                  {e.workspace ? (
                    <Link href={`/workspaces/${e.workspace.id}`} className="block truncate hover:underline">
                      {e.workspace.name}
                    </Link>
                  ) : (
                    <span className="text-text-3">Platform</span>
                  )}
                </td>
              )}
              <td className={cn(table.td, "max-w-72 align-top")}>
                <Metadata metadata={e.metadata} />
              </td>
              <td className={cn(table.td, "align-top font-mono text-xs leading-5 whitespace-nowrap text-text-3")}>{e.ip || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The row of filters above a table. */
export function FilterBar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("mb-3 flex flex-wrap items-center gap-2 [&>*]:min-w-0", className)}>{children}</div>;
}

/** The pagination row along the bottom of a table's card. */
export function TableFooter({ children }: { children: ReactNode }) {
  return <div className="border-t border-line px-4 py-2">{children}</div>;
}

export const providerLabel = (provider: string) =>
  provider === "none" ? "None" : provider === "manual" ? "Manual (invoiced)" : provider.charAt(0).toUpperCase() + provider.slice(1);
