import type { WorkspaceRole } from "@growthdesk/shared";
import type { Tx } from "../prisma/prisma.service.js";
import type { WorkspaceContext } from "./context.js";

/*
 * Record visibility, a workspace setting (settings.recordVisibility):
 *
 *   everyone  every role with records.view_all sees every record (the default)
 *   team      members and viewers see their own records, their teams' and
 *             unowned ones; managers, admins and the owner still see all
 *
 * Applied once per request (AccessGuard, MCP authentication) by narrowing
 * the request's permissions and listing the people whose records it may see;
 * ownershipScope() then filters every scoped query. Someone in no team sees
 * their own and unowned records.
 */

export const RECORD_VISIBILITY = ["everyone", "team"] as const;
export type RecordVisibility = (typeof RECORD_VISIBILITY)[number];

const NARROWED: WorkspaceRole[] = ["member", "viewer"];

export const visibilityOf = (settings: unknown): RecordVisibility =>
  (settings as { recordVisibility?: unknown } | null)?.recordVisibility === "team" ? "team" : "everyone";

/** Narrows `w` in place for team visibility. `db` is any client that can read TeamMember. */
export async function applyTeamVisibility(
  db: Pick<Tx, "teamMember">,
  w: WorkspaceContext,
  settings: unknown,
  role: WorkspaceRole,
  userId: string,
): Promise<void> {
  if (visibilityOf(settings) !== "team" || !NARROWED.includes(role)) return;
  const mine = await db.teamMember.findMany({ where: { workspaceId: w.id, userId }, select: { teamId: true } });
  const mates = mine.length
    ? await db.teamMember.findMany({ where: { workspaceId: w.id, teamId: { in: mine.map((m) => m.teamId) } }, select: { userId: true } })
    : [];
  w.visibleUserIds = [...new Set([userId, ...mates.map((m) => m.userId)])];
  w.permissions = w.permissions.filter((p) => p !== "records.view_all");
}
