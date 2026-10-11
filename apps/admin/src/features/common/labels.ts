import { labelOf } from "@growthdesk/shared";

/*
 * The two pieces of apps/web/src/components/admin/labels.ts the operator
 * console uses, copied verbatim so both audit logs read the same. To be
 * unified with the web copy when packages/ui exists (see the README).
 */

/** "member.role_changed" → "Member · Role changed". Actions are free-form strings recorded across the API. */
export function describeAction(action: string): string {
  return action
    .split(".")
    .map((part) => labelOf(part))
    .join(" · ");
}

/** Classes for the plain data tables on the admin screens (inside a Card, wrapped in overflow-x-auto). */
export const table = {
  wrap: "overflow-x-auto",
  table: "w-full border-collapse text-sm",
  th: "h-8 border-b border-line bg-well px-3 text-left text-xs font-medium whitespace-nowrap text-text-3 first:pl-4 last:pr-4",
  td: "border-b border-line px-3 py-2.5 align-middle text-text first:pl-4 last:pr-4 [tr:last-child>&]:border-b-0",
} as const;
