"use client";

import type { CampaignStatus } from "@growthdesk/shared";
import { formatNumber } from "@/lib/format";
import { useApiMutation } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import { EDITABLE_STATUSES, type CampaignDetail, type CampaignPatchBody, type SkipItem } from "@/lib/types/campaigns";

/** PATCH /campaigns/:id — every tab saves its own fields through this. Errors are shown inline (`error.fields`). */
export function useCampaignPatch(campaignId: string, success = "Campaign saved") {
  const ws = useWorkspace();
  return useApiMutation<CampaignDetail, CampaignPatchBody>({
    method: "PATCH",
    path: ws.path(`/campaigns/${campaignId}`),
    invalidate: [ws.key("campaigns")],
    success,
    errorToast: false,
  });
}

export const isEditable = (status: CampaignStatus) => EDITABLE_STATUSES.includes(status);

/** Why a structural tab is read-only right now, or null when it can be edited. */
export function lockedReason(status: CampaignStatus): string | null {
  if (isEditable(status)) return null;
  if (status === "running" || status === "scheduled") return "Pause the campaign to change this. Contacts already enrolled keep their place.";
  return `This campaign is ${status}, so this can no longer change. Duplicate it to run it again.`;
}

/** "3 unsubscribed · 1 no email address" — the API's skip reasons with their labels. */
export function SkippedList({ items, className }: { items: SkipItem[]; className?: string }) {
  if (!items.length) return null;
  return (
    <ul className={className ?? "flex flex-col gap-1 text-sm"}>
      {items.map((s) => (
        <li key={s.reason} className="flex items-baseline justify-between gap-3">
          <span className="text-text-2">{s.label.charAt(0).toUpperCase() + s.label.slice(1)}</span>
          <span className="text-text tabular-nums">{formatNumber(s.count)}</span>
        </li>
      ))}
    </ul>
  );
}

export const skippedTotal = (items: SkipItem[]) => items.reduce((n, s) => n + s.count, 0);

export const plural = (n: number, word: string, many = `${word}s`) => `${formatNumber(n)} ${n === 1 ? word : many}`;
