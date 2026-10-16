import { dealStaleness, latestOf, type Staleness } from "@growthdesk/shared";
import type { Db, Tx } from "../prisma/prisma.service.js";

/*
 * A deal's "last progress": the latest of entering its stage, an entry on its
 * timeline (a note, an email, an edit — anything but the stale notice itself),
 * a task on it completed, a meeting on it held, a call on it connected. A deal
 * with no progress for longer than its stage's rotDays is stale
 * (dealStaleness in packages/shared/src/forecast.ts).
 *
 * Every query is grouped by deal and scoped to one workspace, so a page of
 * deals costs four round trips whatever its size.
 */

/** Timeline entries that are not progress: the stale notice must not end the spell it announces. */
export const IDLE_ACTIVITY_TYPES = ["deal.stale"];

const DAY_MS = 86_400_000;

type DealRef = { id: string; stageEnteredAt: Date };
type StaleCandidate = DealRef & { status: string; stage: { rotDays: number | null } };

/** The last progress of each deal, by id. */
export async function lastProgress(db: Db | Tx, workspaceId: string, deals: DealRef[], now: Date = new Date()): Promise<Map<string, Date>> {
  const out = new Map(deals.map((d) => [d.id, d.stageEnteredAt]));
  if (!deals.length) return out;
  const dealId = { in: deals.map((d) => d.id) };
  const [activity, tasks, meetings, calls] = await Promise.all([
    db.activity.groupBy({ by: ["dealId"], where: { workspaceId, dealId, type: { notIn: IDLE_ACTIVITY_TYPES }, occurredAt: { lte: now } }, _max: { occurredAt: true } }),
    db.task.groupBy({ by: ["dealId"], where: { workspaceId, dealId, status: "done" }, _max: { completedAt: true } }),
    db.meeting.groupBy({ by: ["dealId"], where: { workspaceId, dealId, status: "completed", startsAt: { lte: now } }, _max: { startsAt: true } }),
    db.call.groupBy({ by: ["dealId"], where: { workspaceId, dealId, status: "completed" }, _max: { createdAt: true } }),
  ]);
  const bump = (id: string | null, at: Date | null | undefined) => {
    if (!id || !at) return;
    out.set(id, latestOf(out.get(id), at) ?? at);
  };
  for (const r of activity) bump(r.dealId, r._max.occurredAt);
  for (const r of tasks) bump(r.dealId, r._max.completedAt);
  for (const r of meetings) bump(r.dealId, r._max.startsAt);
  for (const r of calls) bump(r.dealId, r._max.createdAt);
  return out;
}

/**
 * Which of these deals are stale now. Only deals whose stage has a "stale
 * after" and that entered it longer ago than that can be, so the others cost
 * nothing.
 */
export async function staleness(db: Db | Tx, workspaceId: string, deals: StaleCandidate[], now: Date = new Date()): Promise<Map<string, Staleness>> {
  const out = new Map<string, Staleness>();
  const candidates = deals.filter((d) => d.status === "open" && d.stage.rotDays && now.getTime() - d.stageEnteredAt.getTime() > d.stage.rotDays * DAY_MS);
  if (!candidates.length) return out;
  const progress = await lastProgress(db, workspaceId, candidates, now);
  for (const d of candidates) {
    const s = dealStaleness({ status: d.status, rotDays: d.stage.rotDays, lastProgress: progress.get(d.id) ?? d.stageEnteredAt }, now);
    if (s) out.set(d.id, s);
  }
  return out;
}
