"use client";

import { Suspense, useState, type ReactNode } from "react";
import { CalendarClock, LayoutDashboard, ListOrdered, Mail, UserCheck, Users } from "lucide-react";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { StatusBadge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { QueryState } from "@/components/ui/ErrorState";
import { EntityTile } from "@/components/ui/icons";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { RequirePermission } from "@/components/ui/RequirePermission";
import { LoadingBlock, SkeletonText } from "@/components/ui/Skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { AudienceEditor } from "@/components/campaigns/AudienceEditor";
import { CampaignActions } from "@/components/campaigns/CampaignActions";
import { CampaignOverview } from "@/components/campaigns/CampaignOverview";
import { CampaignDetailsForm, CampaignScheduleForm } from "@/components/campaigns/CampaignSettingsForm";
import { CampaignSteps } from "@/components/campaigns/CampaignSteps";
import { EnrollmentsPanel } from "@/components/campaigns/EnrollmentsPanel";
import { MailboxesEditor } from "@/components/campaigns/MailboxesEditor";
import { formatNumber } from "@/lib/format";
import { useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import type { CampaignDetail } from "@/lib/types/campaigns";

const TABS = [
  { value: "overview", label: "Overview", icon: LayoutDashboard },
  { value: "steps", label: "Steps", icon: ListOrdered },
  { value: "audience", label: "Audience", icon: Users },
  { value: "schedule", label: "Schedule & settings", icon: CalendarClock },
  { value: "mailboxes", label: "Mailboxes", icon: Mail },
  { value: "enrollments", label: "Enrollments", icon: UserCheck },
] as const;
type Tab = (typeof TABS)[number]["value"];

export default function CampaignPage() {
  return (
    <Page>
      <RequirePermission permission="campaigns.read">
        <Suspense fallback={<LoadingBlock />}>
          <CampaignLoader />
        </Suspense>
      </RequirePermission>
    </Page>
  );
}

function CampaignLoader() {
  const ws = useWorkspace();
  const { campaignId } = useParams<{ campaignId: string }>();
  const query = useApiQuery<CampaignDetail>(ws.key("campaigns", campaignId), ws.path(`/campaigns/${campaignId}`), {
    // A live campaign's numbers move as the worker runs; refresh them while the page is open.
    refetchInterval: 30_000,
  });
  return (
    <QueryState
      query={query}
      loading={
        <Card className="p-4">
          <SkeletonText lines={6} />
        </Card>
      }
    >
      {(c) => <CampaignWorkspace campaign={c} />}
    </QueryState>
  );
}

function CampaignWorkspace({ campaign }: { campaign: CampaignDetail }) {
  const ws = useWorkspace();
  const f = useFormat();
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const raw = sp.get("tab");
  const tab: Tab = TABS.some((t) => t.value === raw) ? (raw as Tab) : "overview";
  // Tabs mount when first opened and then stay mounted (hidden), so unsaved edits in one tab survive a switch to another.
  const [visited, setVisited] = useState<ReadonlySet<Tab>>(() => new Set([tab]));
  if (!visited.has(tab)) setVisited(new Set([...visited, tab]));
  const panel = (value: Tab, children: ReactNode) => (
    <TabsContent value={value} keepMounted>
      {visited.has(value) ? children : null}
    </TabsContent>
  );
  const setTab = (next: string) => {
    const p = new URLSearchParams();
    if (next !== "overview") p.set("tab", next);
    router.replace(p.size ? `${pathname}?${p}` : pathname, { scroll: false });
  };
  const c = campaign;
  const when =
    c.status === "scheduled" && c.startAt
      ? `Starts ${f.dateTime(c.startAt)}`
      : c.status === "running" && c.startedAt
        ? `Running since ${f.date(c.startedAt)}`
        : c.status === "completed" && c.completedAt
          ? `Finished ${f.date(c.completedAt)}`
          : `Updated ${f.relative(c.updatedAt)}`;

  return (
    <>
      <PageHeader
        back={{ href: ws.href("/campaigns"), label: "Campaigns" }}
        icon={<EntityTile of="campaigns" />}
        title={c.name}
        meta={<StatusBadge value={c.status} />}
        description={`${when} · ${formatNumber(c.stats.enrolled)} enrolled · ${c.stepCount} step${c.stepCount === 1 ? "" : "s"}${c.description ? ` · ${c.description}` : ""}`}
        actions={<CampaignActions campaign={c} />}
      />
      <Tabs value={tab} onValueChange={setTab}>
        <div className="-mx-1 overflow-x-auto px-1">
          <TabsList>
            {TABS.map((t) => (
              <TabsTrigger key={t.value} value={t.value}>
                <t.icon aria-hidden />
                {t.label}
                {t.value === "enrollments" && c.stats.enrolled > 0 ? (
                  <span className="rounded-xs bg-mute-chip px-1.5 text-2xs text-text-2 tabular-nums">{formatNumber(c.stats.enrolled)}</span>
                ) : null}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        {/* Each form is keyed by the saved values it edits, so it restarts from the stored version after a save or a status change. */}
        {panel("overview", <CampaignOverview campaign={c} />)}
        {panel("steps", <CampaignSteps key={`${c.id}-${c.status}`} campaign={c} />)}
        {panel("audience", <AudienceEditor key={`${c.id}-${c.status}-${JSON.stringify(c.audience)}`} campaign={c} />)}
        {panel(
          "schedule",
          <div className="flex flex-col gap-4">
            <CampaignDetailsForm key={`${c.name}-${c.description}-${c.ownerId}`} campaign={c} />
            <CampaignScheduleForm key={`${c.status}-${JSON.stringify([c.schedule, c.settings, c.startAt])}`} campaign={c} />
          </div>,
        )}
        {panel("mailboxes", <MailboxesEditor key={`${c.status}-${c.mailboxes.map((m) => m.id).join()}`} campaign={c} />)}
        {panel("enrollments", <EnrollmentsPanel campaign={c} initialStatus={sp.get("status") ?? undefined} />)}
      </Tabs>
    </>
  );
}
