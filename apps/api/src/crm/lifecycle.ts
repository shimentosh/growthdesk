import type { LifecycleStage } from "@growthdesk/shared";
import type { Tx } from "../prisma/prisma.service.js";

const RANK: Record<LifecycleStage, number> = { lead: 0, sales: 1, contact: 2 };

/**
 * Moves people forward through lead → sales → contact. Never moves anyone
 * back: an automatic step (a deal opened, a meeting held) must not undo a
 * later manual one. Returns how many rows changed.
 */
export async function advanceStage(tx: Tx, workspaceId: string, contactIds: (string | null | undefined)[], to: LifecycleStage): Promise<number> {
  const ids = [...new Set(contactIds.filter((id): id is string => Boolean(id)))];
  if (!ids.length) return 0;
  const below = (Object.keys(RANK) as LifecycleStage[]).filter((s) => RANK[s] < RANK[to]);
  if (!below.length) return 0;
  const res = await tx.contact.updateMany({
    where: { workspaceId, id: { in: ids }, lifecycleStage: { in: below } },
    data: { lifecycleStage: to, stageChangedAt: new Date() },
  });
  return res.count;
}
