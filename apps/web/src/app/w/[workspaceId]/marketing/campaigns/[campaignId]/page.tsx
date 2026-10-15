"use client";

import { Suspense } from "react";
import { useParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/Card";
import { QueryState } from "@/components/ui/ErrorState";
import { Page } from "@/components/ui/PageHeader";
import { RequirePermission } from "@/components/ui/RequirePermission";
import { LoadingBlock, SkeletonText } from "@/components/ui/Skeleton";
import { useMarketing } from "@/components/marketing/common";
import { CampaignEditor } from "@/components/marketing/campaigns/CampaignEditor";
import { CampaignReport } from "@/components/marketing/campaigns/CampaignReport";
import { useApiQuery } from "@/lib/query";
import type { MarketingCampaign } from "@/lib/types/marketing";

export default function MarketingCampaignPage() {
  return (
    <Page>
      <RequirePermission permission="marketing.read">
        <Suspense fallback={<LoadingBlock />}>
          <CampaignLoader />
        </Suspense>
      </RequirePermission>
    </Page>
  );
}

/** A draft opens the editor; anything else opens the report. */
function CampaignLoader() {
  const mk = useMarketing();
  const qc = useQueryClient();
  const { campaignId } = useParams<{ campaignId: string }>();
  const key = mk.key("campaigns", campaignId);
  // The report polls while the campaign is sending (the worker moves the numbers),
  // and, more slowly, while it is scheduled so it flips to sending when due.
  const status = qc.getQueryData<MarketingCampaign>(key)?.status;
  const query = useApiQuery<MarketingCampaign>(key, mk.path(`/campaigns/${campaignId}`), { refetchInterval: status === "sending" ? 5_000 : status === "scheduled" ? 15_000 : false });
  return (
    <QueryState
      query={query}
      loading={
        <Card className="p-4">
          <SkeletonText lines={6} />
        </Card>
      }
    >
      {(c) => (c.status === "draft" ? <CampaignEditor key={c.id} campaign={c} /> : <CampaignReport campaign={c} />)}
    </QueryState>
  );
}
