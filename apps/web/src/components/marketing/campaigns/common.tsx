"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Copy, MoreHorizontal, Trash2 } from "lucide-react";
import { GUARDRAIL } from "@growthdesk/shared";
import { IconButton } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/DropdownMenu";
import { useMarketing } from "@/components/marketing/common";
import { formatPercent } from "@/lib/format";
import { useApiMutation } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import type { MarketingCampaign, MarketingList } from "@/lib/types/marketing";

/*
 * Small pieces shared by the marketing campaign list, editor and report.
 */

export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** "Monthly newsletter, Customers · minus Beta programme · segment Hot leads". */
export function audienceSummary(a: MarketingCampaign["audience"], lists: MarketingList[] | undefined, viewName?: string): string {
  if (!a.listIds.length) return "No lists chosen";
  const name = (id: string) => lists?.find((l) => l.id === id)?.name ?? "A removed list";
  const parts = [a.listIds.map(name).join(", ")];
  if (a.excludeListIds.length) parts.push(`minus ${a.excludeListIds.map(name).join(", ")}`);
  if (a.viewId) parts.push(viewName ? `segment ${viewName}` : "a segment");
  return parts.join(" · ");
}

/** A share of what was sent ("12.5%"), or an em dash before anything went out. */
export const rateOf = (n: number, sent: number) => (sent > 0 ? formatPercent(n / sent) : "—");

/** The API words a guardrail pause this way (sender.service `guardrail`). */
export const isGuardrailPause = (reason: string) => /bounce rate|complaint rate/i.test(reason);

/** The deliverability guardrail in words, for the paused callout. */
export const GUARDRAIL_TEXT = `Sending pauses on its own once at least ${GUARDRAIL.minSample} emails went out and more than ${formatPercent(GUARDRAIL.maxBounceRate, 0)} bounced or more than ${formatPercent(GUARDRAIL.maxComplaintRate, 1)} were marked as spam. The sending domain is paused too, so other campaigns from it wait until the list is cleaned.`;

/**
 * Duplicate (opens the copy) and Delete (drafts only; the API also refuses
 * anything sending, scheduled or paused), as a "more" menu.
 */
export function CampaignMenu({ campaign, afterDelete, size = "md" }: { campaign: MarketingCampaign; afterDelete?: () => void; size?: "sm" | "md" }) {
  const ws = useWorkspace();
  const mk = useMarketing();
  const router = useRouter();
  const [confirm, setConfirm] = useState(false);
  const duplicate = useApiMutation<MarketingCampaign, void>({
    path: mk.path(`/campaigns/${campaign.id}/duplicate`),
    invalidate: [mk.key("campaigns")],
    success: "Campaign duplicated",
    onSuccess: (c) => router.push(mk.href(`/campaigns/${c.id}`)),
  });
  const remove = useApiMutation<{ deleted: boolean }, void>({
    method: "DELETE",
    path: mk.path(`/campaigns/${campaign.id}`),
    invalidate: [mk.key("campaigns")],
    success: "Campaign deleted",
    errorToast: false,
    onSuccess: () => afterDelete?.(),
  });
  if (!ws.can("marketing.write")) return null;
  const canDelete = campaign.status === "draft";
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton variant={size === "sm" ? "ghost" : "secondary"} size={size} label={`More actions for ${campaign.name}`} icon={<MoreHorizontal />} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem icon={<Copy />} onSelect={() => duplicate.mutate()}>
            Duplicate
          </DropdownMenuItem>
          {canDelete && (
            <DropdownMenuItem icon={<Trash2 />} danger onSelect={() => setConfirm(true)}>
              Delete
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Delete “${campaign.name}”?`}
        description="The draft and its content are removed. This cannot be undone."
        onConfirm={() => remove.mutateAsync()}
      />
    </>
  );
}
