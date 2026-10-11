import { BUSINESS_TYPES, labelOf, ROLE_RANK, type WorkspaceRole } from "@growthdesk/shared";
import type { EditableRole } from "@/lib/types/admin";

/*
 * Words and small rules the workspace-administration screens share.
 */

export const BUSINESS_LABELS: Record<(typeof BUSINESS_TYPES)[number], string> = {
  agency: "Agency",
  saas: "SaaS",
  consulting: "Consulting",
  freelancer: "Freelancer",
  ecommerce: "E-commerce",
  services: "Services",
  recruiting: "Recruiting",
  other: "Other",
};

export const EDITABLE_ROLES: readonly EditableRole[] = ["admin", "manager", "member", "viewer"];

/** What each role can do with the default permission set (a workspace may customise all but the owner). */
export const ROLE_DESCRIPTIONS: Record<WorkspaceRole, string> = {
  owner: "Everything, including billing. There is one owner.",
  admin: "Everything except changing the plan and payment details.",
  manager: "Works contacts, deals, campaigns and the inbox, and sees team performance.",
  member: "Works contacts, deals, campaigns and the inbox.",
  viewer: "Can look at records and reports but not change them.",
};

/** Roles the current role may give someone: strictly below its own rank, never owner (mirrors the API's assertCanAssign). */
export function assignableRoles(mine: WorkspaceRole): EditableRole[] {
  return EDITABLE_ROLES.filter((r) => ROLE_RANK[r] < ROLE_RANK[mine]);
}

/** True when `mine` outranks `theirs` — the API refuses to manage anyone at or above your own level. */
export function outranks(mine: WorkspaceRole, theirs: WorkspaceRole): boolean {
  return ROLE_RANK[theirs] < ROLE_RANK[mine];
}

/** "member.role_changed" → "Member · Role changed". Actions are free-form strings recorded across the API. */
export function describeAction(action: string): string {
  return action
    .split(".")
    .map((part) => labelOf(part))
    .join(" · ");
}

let regionNames: Intl.DisplayNames | null | undefined;

/** "DE" → "Germany"; null when the code is not a known region. */
export function countryName(code: string): string | null {
  const c = code.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return null;
  if (regionNames === undefined) {
    try {
      regionNames = new Intl.DisplayNames(["en"], { type: "region", fallback: "none" });
    } catch {
      regionNames = null;
    }
  }
  const name = regionNames?.of(c);
  return name && name !== c ? name : null;
}

/** Classes for the plain data tables on the admin screens (inside a Card, wrapped in overflow-x-auto). */
export const table = {
  wrap: "overflow-x-auto",
  table: "w-full border-collapse text-sm",
  th: "h-8 border-b border-line bg-well px-3 text-left text-xs font-medium whitespace-nowrap text-text-3 first:pl-4 last:pr-4",
  td: "border-b border-line px-3 py-2.5 align-middle text-text first:pl-4 last:pr-4 [tr:last-child>&]:border-b-0",
} as const;
