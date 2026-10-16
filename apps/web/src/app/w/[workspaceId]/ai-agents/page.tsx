"use client";

import Link from "next/link";
import { useState } from "react";
import { Archive, AudioLines, CalendarCheck, CircleAlert, History, MessagesSquare, PhoneOutgoing, Plus, Settings2 } from "lucide-react";
import { AI_AGENT_GOAL_LABELS, AI_AGENT_LANGUAGES } from "@growthdesk/shared";
import { useAiAgents, useAiCallingSetup, type ArchivedFilter } from "@/components/ai-calling/hooks";
import { NewAgentModal } from "@/components/ai-calling/NewAgentModal";
import { SyncBadge } from "@/components/ai-calling/SyncBadge";
import { Segmented } from "@/components/pipeline/controls";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { QueryState } from "@/components/ui/ErrorState";
import { ENTITY, EntityTile } from "@/components/ui/icons";
import { IconTile } from "@/components/ui/IconTile";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { RequirePermission } from "@/components/ui/RequirePermission";
import { Skeleton } from "@/components/ui/Skeleton";
import { cn } from "@/lib/cn";
import { formatNumber } from "@/lib/format";
import { useFormat, useWorkspace } from "@/lib/session";
import type { AiAgent } from "@/lib/types/ai-calling";

export default function AiAgentsPage() {
  return (
    <Page width="capped">
      <RequirePermission permission="calls.read">
        <Agents />
      </RequirePermission>
    </Page>
  );
}

const languageLabel = (code: string) => AI_AGENT_LANGUAGES.find((l) => l.code === code)?.label ?? code;

function Agents() {
  const ws = useWorkspace();
  const setup = useAiCallingSetup();
  const canEdit = ws.can("calls.agents");
  const [archived, setArchived] = useState<Extract<ArchivedFilter, "exclude" | "only">>("exclude");
  const [creating, setCreating] = useState(false);
  const list = useAiAgents(archived);
  const create = canEdit ? (
    <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>
      New agent
    </Button>
  ) : undefined;
  const noPlan = !ws.hasFeature("calling");

  return (
    <>
      <PageHeader
        icon={<EntityTile of="aiAgents" />}
        title="AI agents"
        description="Voice agents that phone contacts from a script you write, say they are an AI, and record how each call went. Use them as AI call steps in campaigns."
        actions={create}
      />

      {setup.data && !setup.data.ready && (
        <Callout
          tone="warn"
          className="mb-4"
          title="AI calls cannot be placed yet"
          action={
            noPlan && ws.can("billing.read") ? (
              <Button size="sm" variant="ghost" href={ws.href("/settings/billing")}>
                See plans
              </Button>
            ) : !noPlan && ws.can("integrations.manage") ? (
              <Button size="sm" variant="ghost" icon={<Settings2 />} href={ws.href("/settings/calling")}>
                Calling settings
              </Button>
            ) : undefined
          }
        >
          {setup.data.reason}
        </Callout>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Segmented
          aria-label="Show"
          value={archived}
          onChange={setArchived}
          options={[
            { value: "exclude", label: "Active", icon: <AudioLines /> },
            { value: "only", label: "Archived", icon: <Archive /> },
          ]}
        />
        <span className="text-xs text-text-3">Agents only call contacts whose consent to be called is recorded, within your calling hours in their time zone.</span>
      </div>

      <QueryState
        query={list}
        loading={
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" aria-busy>
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-40 rounded-xl" />
            ))}
          </div>
        }
        isEmpty={(d) => d.length === 0}
        empty={
          <Card>
            {archived === "only" ? (
              <EmptyState icon={<Archive />} title="No archived agents" description="Archived agents keep their call history and can be restored at any time." />
            ) : (
              <EmptyState
                icon={<AudioLines />}
                tint={ENTITY.aiAgents.tint}
                title="No AI agents yet"
                description="An AI agent is a voice and a script: it calls contacts for you, books meetings or qualifies leads, and logs the result. It only calls contacts whose consent to be called is recorded."
                action={create}
              />
            )}
          </Card>
        }
      >
        {(rows) => (
          <div className={cn("grid gap-3 transition-opacity md:grid-cols-2 xl:grid-cols-3", list.isFetching && list.isPlaceholderData && "opacity-60")}>
            {rows.map((a) => (
              <AgentCard key={a.id} agent={a} />
            ))}
          </div>
        )}
      </QueryState>

      {canEdit && <NewAgentModal open={creating} onOpenChange={setCreating} />}
    </>
  );
}

function AgentCard({ agent: a }: { agent: AiAgent }) {
  const ws = useWorkspace();
  const f = useFormat();
  const Glyph = ENTITY.aiAgents.icon;
  const stats = [
    { icon: <PhoneOutgoing />, label: "Calls", value: a.stats.calls },
    { icon: <MessagesSquare />, label: "Conversations", value: a.stats.connected },
    { icon: <CalendarCheck />, label: "Meetings", value: a.stats.meetings },
  ];

  return (
    <Card className="flex flex-col">
      <Link href={ws.href(`/ai-agents/${a.id}`)} className="group flex flex-1 flex-col gap-3 p-4">
        <div className="flex items-start gap-3">
          <IconTile icon={<Glyph />} tint={ENTITY.aiAgents.tint} size="md" className={cn(a.archivedAt && "opacity-50")} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate text-sm font-semibold text-text-hi group-hover:text-accent-hi">{a.name}</span>
              {a.archivedAt ? <Badge>Archived</Badge> : <SyncBadge sync={a.sync} />}
            </div>
            <p className="mt-0.5 truncate text-xs text-text-3">
              {a.personaName}
              {a.voiceName ? ` · ${a.voiceName} voice` : ""} · {languageLabel(a.language)}
            </p>
          </div>
        </div>
        <Badge quiet className="w-fit">
          {AI_AGENT_GOAL_LABELS[a.goal]}
        </Badge>
        {!a.archivedAt && !a.sync.saved && a.sync.error && (
          <p className="flex items-start gap-1.5 text-xs text-warn-ink">
            <CircleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
            <span className="line-clamp-2 min-w-0 break-words">{a.sync.error}</span>
          </p>
        )}
      </Link>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line px-4 py-2.5 text-xs text-text-3">
        {stats.map((s) => (
          <span key={s.label} className="inline-flex items-center gap-1 [&_svg]:size-3">
            {s.icon}
            <span className="font-medium text-text-2 tabular-nums">{formatNumber(s.value)}</span>
            {s.label.toLowerCase()}
          </span>
        ))}
        <span className="inline-flex items-center gap-1 [&_svg]:size-3" title={a.stats.lastCallAt ? f.dateTime(a.stats.lastCallAt) : undefined}>
          <History />
          {a.stats.lastCallAt ? `Last call ${f.relative(a.stats.lastCallAt)}` : "No calls yet"}
        </span>
      </div>
    </Card>
  );
}
