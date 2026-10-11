"use client";

import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  BarChart3,
  CircleAlert,
  CircleSlash,
  Copy,
  Eye,
  FileText,
  Flag,
  MailOpen,
  MailX,
  MousePointerClick,
  Pause,
  Play,
  Send,
  Square,
  UserMinus,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { EntityTile } from "@/components/ui/icons";
import { KeyValueList } from "@/components/ui/KeyValue";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatCard } from "@/components/ui/StatCard";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { fill } from "@growthdesk/shared";
import { CampaignStatusBadge, PREVIEW_VARS, useMarketing, useMarketingLists } from "@/components/marketing/common";
import { DesignPreview } from "@/components/marketing/designs/DesignPreview";
import { cn } from "@/lib/cn";
import { formatNumber, formatPercent } from "@/lib/format";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import type { SavedView } from "@/lib/types/crm";
import type { MarketingCampaign } from "@/lib/types/marketing";
import { GUARDRAIL_TEXT, audienceSummary, isGuardrailPause, plural, rateOf } from "./common";
import { RecipientsTable } from "./RecipientsTable";

const TABS = [
  { value: "report", label: "Report", icon: BarChart3 },
  { value: "recipients", label: "Recipients", icon: Users },
  { value: "email", label: "Email", icon: Eye },
] as const;
type Tab = (typeof TABS)[number]["value"];

/** Scheduled, sending, paused, sent or canceled: the numbers, who got it, and what it said. */
export function CampaignReport({ campaign: c }: { campaign: MarketingCampaign }) {
  const ws = useWorkspace();
  const mk = useMarketing();
  const f = useFormat();
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const raw = sp.get("tab");
  const tab: Tab = TABS.some((t) => t.value === raw) ? (raw as Tab) : "report";
  const setTab = (next: string) => {
    const p = new URLSearchParams();
    if (next !== "report") p.set("tab", next);
    router.replace(p.size ? `${pathname}?${p}` : pathname, { scroll: false });
  };

  const when =
    c.status === "scheduled" && c.scheduledAt
      ? `Sends ${f.dateTime(c.scheduledAt)}`
      : c.status === "sent" && c.completedAt
        ? `Sent ${f.dateTime(c.completedAt)}`
        : c.status === "canceled" && c.canceledAt
          ? `Canceled ${f.dateTime(c.canceledAt)}`
          : c.startedAt
            ? `Started ${f.dateTime(c.startedAt)}`
            : `Updated ${f.relative(c.updatedAt)}`;

  return (
    <>
      <PageHeader
        back={{ href: mk.href("/campaigns"), label: "Email campaigns" }}
        icon={<EntityTile of="marketingCampaigns" />}
        title={c.name}
        meta={<CampaignStatusBadge status={c.status} />}
        description={`${when}${c.subject ? ` · “${c.subject}”` : ""}`}
        actions={<ReportActions campaign={c} />}
      />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          {TABS.map((t) => (
            <TabsTrigger key={t.value} value={t.value}>
              <t.icon aria-hidden />
              {t.label}
              {t.value === "recipients" && c.stats.recipients > 0 ? (
                <span className="rounded-xs bg-mute-chip px-1.5 text-2xs text-text-2 tabular-nums">{formatNumber(c.stats.recipients)}</span>
              ) : null}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="report">
          <Overview campaign={c} />
        </TabsContent>
        <TabsContent value="recipients">
          <RecipientsTable campaign={c} />
        </TabsContent>
        <TabsContent value="email">
          <ContentPreview campaign={c} />
        </TabsContent>
      </Tabs>
    </>
  );
}

function Overview({ campaign: c }: { campaign: MarketingCampaign }) {
  const ws = useWorkspace();
  const f = useFormat();
  const s = c.stats;
  const lists = useMarketingLists(true);
  const views = useApiQuery<SavedView[]>(ws.key("views", "contact"), ws.path("/views"), { query: { entity: "contact" } });
  const processed = s.sent + s.failed + s.skipped;
  const showProgress = (c.status === "sending" || c.status === "paused") && s.recipients > 0;
  const guardrail = isGuardrailPause(c.pausedReason);
  const pct = (n: number) => (s.sent > 0 ? `${rateOf(n, s.sent)} of sent` : undefined);

  return (
    <div className="flex flex-col gap-4">
      {c.status === "paused" && (
        <Callout
          tone="warn"
          title={guardrail ? "Paused by the deliverability guardrail" : "Sending is paused"}
          action={
            guardrail || /domain|email service/i.test(c.pausedReason) ? (
              <Button size="sm" iconRight={<ArrowRight />} href={ws.href("/settings/sending-domains")}>
                Sending domains
              </Button>
            ) : undefined
          }
        >
          <p>{c.pausedReason || "Nothing more is sent until it is resumed."}</p>
          {guardrail && <p className="mt-1">{GUARDRAIL_TEXT}</p>}
          {c.pausedAt && <p className="mt-1 text-text-3">Paused {f.dateTime(c.pausedAt)}.</p>}
        </Callout>
      )}
      {c.status === "scheduled" && c.scheduledAt && (
        <Callout tone="info" title={`Scheduled for ${f.dateTime(c.scheduledAt)}`}>
          The recipients are chosen from the lists when sending starts. Pause or cancel it before then to stop it.
        </Callout>
      )}
      {c.status === "canceled" && (
        <Callout tone="info" title="This campaign was canceled">
          {s.sent > 0 ? `${plural(s.sent, "email")} went out before it was canceled; the rest were skipped.` : "Nothing was sent."} Duplicate it to send it again.
        </Callout>
      )}
      {showProgress && (
        <Card className="px-4 py-3.5">
          <div className="flex items-baseline justify-between gap-2 text-sm">
            <span className="font-medium text-text">{c.status === "sending" ? "Sending…" : "Paused"}</span>
            <span className="text-text-3 tabular-nums">
              {formatNumber(processed)} of {formatNumber(s.recipients)} · {formatPercent(processed / s.recipients, 0)}
            </span>
          </div>
          <div
            role="progressbar"
            aria-label="Sending progress"
            aria-valuemin={0}
            aria-valuemax={s.recipients}
            aria-valuenow={processed}
            className="mt-2 h-2 overflow-hidden rounded-full bg-well"
          >
            <div
              className={cn("h-full rounded-full transition-[width] duration-700", c.status === "paused" ? "bg-warn" : "bg-accent")}
              style={{ width: `${Math.min(100, (processed / s.recipients) * 100)}%` }}
            />
          </div>
          {c.status === "sending" && <p className="mt-2 text-xs text-text-3">Updates every few seconds. You can leave this page; sending carries on.</p>}
        </Card>
      )}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <StatCard label="Recipients" icon={<Users />} tint="indigo" value={formatNumber(s.recipients)} />
        <StatCard label="Sent" icon={<Send />} tint="blue" value={formatNumber(s.sent)} hint={s.recipients ? `${formatPercent(s.sent / s.recipients)} of recipients` : undefined} />
        <StatCard label="Failed" icon={<CircleAlert />} tint="red" value={formatNumber(s.failed)} tone={s.failed ? "bad" : undefined} hint="The email service refused them" />
        <StatCard
          label="Unique opens"
          icon={<MailOpen />}
          tint="teal"
          value={c.trackOpens ? formatNumber(s.uniqueOpens) : "—"}
          hint={c.trackOpens ? (pct(s.uniqueOpens) ?? "Open rate shows once sent") : "Open tracking was off"}
        />
        <StatCard
          label="Unique clicks"
          icon={<MousePointerClick />}
          tint="purple"
          value={c.trackClicks ? formatNumber(s.uniqueClicks) : "—"}
          hint={c.trackClicks ? (pct(s.uniqueClicks) ?? "Click rate shows once sent") : "Click tracking was off"}
        />
        <StatCard label="Unsubscribes" icon={<UserMinus />} tint="gray" value={formatNumber(s.unsubscribes)} hint={pct(s.unsubscribes)} />
        <StatCard label="Skipped" icon={<CircleSlash />} tint="gray" value={formatNumber(s.skipped)} hint="Unsubscribed, suppressed or canceled before their turn" />
        <StatCard label="Bounces" icon={<MailX />} tint="orange" value={formatNumber(s.bounces)} tone={s.bounces ? "warn" : undefined} hint={pct(s.bounces)} />
        <StatCard label="Spam complaints" icon={<Flag />} tint="red" value={formatNumber(s.complaints)} tone={s.complaints ? "bad" : undefined} hint={pct(s.complaints)} />
      </div>
      <Card>
        <CardHeader icon={<FileText />} title="Details" />
        <CardBody>
          <KeyValueList
            columns={2}
            items={[
              { label: "Subject", value: c.subject || "—" },
              { label: "From", value: c.fromEmail ? `${c.fromName} <${c.fromEmail}>` : c.fromName || "—" },
              { label: "Audience", value: audienceSummary(c.audience, lists.data, views.data?.find((v) => v.id === c.audience.viewId)?.name) },
              { label: "Reply-to", value: c.replyTo || "The From address" },
              { label: "Tracking", value: c.trackOpens && c.trackClicks ? "Opens and clicks" : c.trackOpens ? "Opens" : c.trackClicks ? "Clicks" : "Off" },
              ...(c.scheduledAt && (c.status === "scheduled" || c.status === "paused") ? [{ label: "Scheduled for", value: f.dateTime(c.scheduledAt) }] : []),
              ...(c.startedAt ? [{ label: "Started", value: f.dateTime(c.startedAt) }] : []),
              ...(c.completedAt ? [{ label: "Finished", value: f.dateTime(c.completedAt) }] : []),
              ...(c.canceledAt ? [{ label: "Canceled", value: f.dateTime(c.canceledAt) }] : []),
            ]}
          />
        </CardBody>
      </Card>
    </div>
  );
}

function ContentPreview({ campaign: c }: { campaign: MarketingCampaign }) {
  return (
    <div className="mx-auto flex max-w-[820px] flex-col gap-4">
      <Card className="px-4 py-3 text-sm">
        <p className="font-semibold text-text-hi">{c.subject ? fill(c.subject, PREVIEW_VARS) : "No subject"}</p>
        <p className="mt-0.5 text-xs text-text-3">
          {c.fromName} {c.fromEmail ? `<${c.fromEmail}>` : ""}
          {c.replyTo ? ` · reply-to ${c.replyTo}` : ""}
        </p>
        {c.preheader && <p className="mt-1 text-xs text-text-2">{fill(c.preheader, PREVIEW_VARS)}</p>}
      </Card>
      <DesignPreview blocks={c.blocks} preheader={c.preheader} className="h-[min(760px,calc(100dvh-8rem))] min-h-[480px]" />
    </div>
  );
}

/** Pause / resume / cancel (marketing.send) and duplicate (marketing.write). */
function ReportActions({ campaign: c }: { campaign: MarketingCampaign }) {
  const ws = useWorkspace();
  const mk = useMarketing();
  const qc = useQueryClient();
  const router = useRouter();
  const [canceling, setCanceling] = useState(false);
  const canSend = ws.can("marketing.send");
  const base = `/campaigns/${c.id}`;
  const accept = (next: MarketingCampaign) => {
    qc.setQueryData(mk.key("campaigns", c.id), next);
    void qc.invalidateQueries({ queryKey: mk.key("campaigns", "list") });
    void qc.invalidateQueries({ queryKey: mk.key("campaigns", c.id, "recipients") });
  };
  const pause = useApiMutation<MarketingCampaign, void>({ path: mk.path(`${base}/pause`), success: "Campaign paused", onSuccess: accept });
  const resume = useApiMutation<MarketingCampaign, void>({ path: mk.path(`${base}/resume`), success: "Campaign resumed", onSuccess: accept });
  const cancel = useApiMutation<MarketingCampaign, void>({ path: mk.path(`${base}/cancel`), success: "Campaign canceled", errorToast: false, onSuccess: accept });
  const duplicate = useApiMutation<MarketingCampaign, void>({
    path: mk.path(`${base}/duplicate`),
    invalidate: [mk.key("campaigns", "list")],
    success: "Campaign duplicated as a draft",
    onSuccess: (copy) => router.push(mk.href(`/campaigns/${copy.id}`)),
  });
  const live = c.status === "sending" || c.status === "scheduled";
  const stoppable = live || c.status === "paused";
  return (
    <>
      {canSend && live && (
        <Button icon={<Pause />} loading={pause.isPending} onClick={() => pause.mutate()}>
          Pause
        </Button>
      )}
      {canSend && c.status === "paused" && (
        <Button variant="primary" icon={<Play />} loading={resume.isPending} onClick={() => resume.mutate()}>
          Resume
        </Button>
      )}
      {canSend && stoppable && (
        <Button variant="danger" icon={<Square />} onClick={() => setCanceling(true)}>
          Cancel campaign
        </Button>
      )}
      {ws.can("marketing.write") && (
        <Button icon={<Copy />} loading={duplicate.isPending} onClick={() => duplicate.mutate()}>
          Duplicate
        </Button>
      )}
      <ConfirmDialog
        open={canceling}
        onOpenChange={setCanceling}
        title={`Cancel “${c.name}”?`}
        confirmLabel="Cancel campaign"
        cancelLabel="Keep it"
        description={
          c.status === "scheduled"
            ? "It will not be sent. A canceled campaign cannot be restarted; duplicate it to send it later."
            : `Emails already sent stay sent (${formatNumber(c.stats.sent)} so far). Everyone still waiting is skipped. A canceled campaign cannot be restarted.`
        }
        onConfirm={() => cancel.mutateAsync()}
      />
    </>
  );
}
