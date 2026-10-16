"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Handshake, Megaphone, Plus } from "lucide-react";
import { WORKFLOW_TEMPLATES, workflowKind, type WorkflowKind } from "@growthdesk/shared";
import { Segments } from "@/components/crm/ContactListView";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { QueryState } from "@/components/ui/ErrorState";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { RequirePermission } from "@/components/ui/RequirePermission";
import { LoadingBlock, SkeletonText } from "@/components/ui/Skeleton";
import { Switch } from "@/components/ui/Switch";
import { ENTITY, EntityTile } from "@/components/ui/icons";
import { AutomationTabs } from "@/components/automation/AutomationTabs";
import { ActionGlyph, TriggerTile } from "@/components/automation/glyphs";
import { KIND_META, TemplateCard } from "@/components/automation/WorkflowStarter";
import { formatNumber } from "@/lib/format";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import { ACTION_LABELS, triggerLabel, type Workflow, type WorkflowListItem } from "@/lib/types/automation";

const WorkflowIcon = ENTITY.workflows.icon;

function WorkflowRow({ wf }: { wf: WorkflowListItem }) {
  const ws = useWorkspace();
  const f = useFormat();
  const toggle = useApiMutation<Workflow, { enabled: boolean }>({
    method: "PATCH",
    path: ws.path(`/workflows/${wf.id}`),
    invalidate: [ws.key("workflows")],
    success: (r) => (r.enabled ? `“${r.name}” is on` : `“${r.name}” is off`),
  });
  const href = ws.href(`/automation/${wf.id}`);

  return (
    <li className="flex items-start gap-3 px-4 py-3.5 sm:items-center">
      <TriggerTile trigger={wf.trigger} className={wf.enabled ? undefined : "opacity-60 grayscale"} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link href={href} className="truncate text-sm font-medium text-text-hi hover:underline">
            {wf.name}
          </Link>
          <Badge quiet>{KIND_META[workflowKind(wf.trigger)].short}</Badge>
          {wf.requiresApproval && <Badge quiet>Needs approval</Badge>}
          {wf.awaitingApproval > 0 && (
            <Link href={ws.href(`/automation/runs?status=waiting_approval&workflowId=${wf.id}`)}>
              <Badge tone="warn" dot>
                {wf.awaitingApproval} awaiting approval
              </Badge>
            </Link>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-text-3">
          <span>When: {triggerLabel(wf.trigger)}</span>
          <span className="inline-flex items-center gap-1.5">
            {wf.actions.length > 0 && (
              <span className="inline-flex items-center gap-1 text-text-2">
                {wf.actions.slice(0, 6).map((a, i) => (
                  <span key={i} title={ACTION_LABELS[a.type]?.label ?? a.type} className="inline-flex">
                    <ActionGlyph type={a.type} className="size-3.5" />
                  </span>
                ))}
              </span>
            )}
            {wf.actions.length} action{wf.actions.length === 1 ? "" : "s"}
            {wf.conditions.length ? ` · ${wf.conditions.length} condition${wf.conditions.length === 1 ? "" : "s"}` : ""}
          </span>
          <span>
            {formatNumber(wf.runCount)} run{wf.runCount === 1 ? "" : "s"}
            {wf.lastRunAt ? ` · last ${f.relative(wf.lastRunAt)}` : ""}
          </span>
        </div>
        {wf.description && <p className="mt-1 line-clamp-1 text-xs text-text-2">{wf.description}</p>}
      </div>
      <Switch
        checked={wf.enabled}
        disabled={!ws.can("automation.write") || toggle.isPending}
        onCheckedChange={(enabled) => toggle.mutate({ enabled })}
        aria-label={wf.enabled ? `Turn off ${wf.name}` : `Turn on ${wf.name}`}
      />
    </li>
  );
}

type View = "sales" | "marketing" | "mine";

/** Ready-made workflows of one kind: one click opens the builder filled in, to adjust and save. */
function TemplateGrid({ kind, existing }: { kind: WorkflowKind; existing: Set<string> }) {
  const ws = useWorkspace();
  const router = useRouter();
  const canWrite = ws.can("automation.write");
  const m = KIND_META[kind];
  const templates = WORKFLOW_TEMPLATES.filter((t) => t.kind === kind);
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-text-2">
        {m.description} Pick one: it opens filled in, you check it and switch it on.
      </p>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {templates.map((t) => (
          <TemplateCard
            key={t.id}
            template={t}
            inUse={existing.has(t.name.toLowerCase())}
            onPick={() => (canWrite ? router.push(ws.href(`/automation/new?kind=${kind}&template=${t.id}`)) : undefined)}
          />
        ))}
      </div>
      {canWrite && (
        <div>
          <Button size="sm" icon={<Plus />} href={ws.href(`/automation/new?kind=${kind}&template=blank`)}>
            Start a {m.short.toLowerCase()} workflow from scratch
          </Button>
        </div>
      )}
    </div>
  );
}

export default function AutomationPage() {
  return (
    <Suspense fallback={<LoadingBlock />}>
      <Automation />
    </Suspense>
  );
}

function Automation() {
  const ws = useWorkspace();
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const list = useApiQuery<WorkflowListItem[]>(ws.key("workflows", "list"), ws.path("/workflows"));
  const canWrite = ws.can("automation.write");
  const awaiting = (list.data ?? []).reduce((n, w) => n + w.awaitingApproval, 0);
  const raw = sp.get("view");
  // Templates first; the team's own workflows (and their on/off switches) have their own tab.
  const view: View = raw === "marketing" || raw === "mine" ? raw : "sales";
  const setView = (v: View) => router.replace(v === "sales" ? pathname : `${pathname}?view=${v}`, { scroll: false });
  const [kind, setKind] = useState<"" | WorkflowKind>("");
  const rows = list.data ?? [];
  const count = (k: WorkflowKind) => rows.filter((w) => workflowKind(w.trigger) === k).length;
  const existing = new Set(rows.map((w) => w.name.toLowerCase()));
  const templateCount = (k: WorkflowKind) => WORKFLOW_TEMPLATES.filter((t) => t.kind === k).length;

  return (
    <Page>
      <RequirePermission permission="automation.read">
        <PageHeader
          title="Workflows"
          icon={<EntityTile of="workflows" />}
          description="When something happens — a new lead, a reply, a deal moving — check a few conditions and act: assign, tag, create a task, notify the team."
          actions={
            canWrite ? (
              <Button variant="primary" icon={<Plus />} href={ws.href("/automation/new")}>
                New workflow
              </Button>
            ) : undefined
          }
        />
        <AutomationTabs awaiting={awaiting} />
        {!ws.hasFeature("automation") && (
          <Callout tone="warn" title="Your plan does not include workflow automation" className="mb-4">
            Existing workflows do not run, and new ones cannot be created, until the plan is upgraded.
          </Callout>
        )}
        <div className="mb-4">
          <Segments
            label="Show"
            value={view}
            onChange={setView}
            options={[
              { value: "sales", label: `Sales templates · ${templateCount("sales")}`, icon: Handshake },
              { value: "marketing", label: `Email marketing templates · ${templateCount("marketing")}`, icon: Megaphone },
              { value: "mine", label: `My workflows${list.data ? ` · ${rows.length}` : ""}`, icon: WorkflowIcon },
            ]}
          />
        </div>
        {view !== "mine" ? (
          <TemplateGrid kind={view} existing={existing} />
        ) : (
          <QueryState
            query={list}
            loading={
              <Card className="p-4">
                <SkeletonText lines={4} />
              </Card>
            }
            isEmpty={(d) => d.length === 0}
            empty={
              <Card>
                <EmptyState
                  icon={<WorkflowIcon />}
                  tint={ENTITY.workflows.tint}
                  title="No workflows yet"
                  description={canWrite ? "Start from a ready-made template in the Sales or Email marketing tab." : "Nobody has built a workflow yet."}
                  action={
                    canWrite ? (
                      <Button size="sm" variant="primary" onClick={() => setView("sales")}>
                        Browse templates
                      </Button>
                    ) : undefined
                  }
                />
              </Card>
            }
          >
            {(all) => {
              const shown = kind ? all.filter((w) => workflowKind(w.trigger) === kind) : all;
              return (
                <>
                  <div className="mb-3">
                    <Segments
                      label="Kind"
                      value={kind}
                      onChange={setKind}
                      options={[
                        { value: "", label: `All · ${all.length}`, icon: WorkflowIcon },
                        { value: "sales", label: `Sales · ${count("sales")}`, icon: Handshake },
                        { value: "marketing", label: `Email marketing · ${count("marketing")}`, icon: Megaphone },
                      ]}
                    />
                  </div>
                  <Card>
                    {shown.length ? (
                      <ul className="divide-y divide-line">
                        {shown.map((w) => (
                          <WorkflowRow key={w.id} wf={w} />
                        ))}
                      </ul>
                    ) : (
                      <EmptyState
                        compact
                        icon={<WorkflowIcon />}
                        title={`No ${kind === "marketing" ? "email marketing" : "sales"} workflows yet`}
                        description="Templates make the first one a minute's work."
                        action={
                          canWrite && kind ? (
                            <Button size="sm" variant="primary" onClick={() => setView(kind)}>
                              Browse templates
                            </Button>
                          ) : undefined
                        }
                      />
                    )}
                  </Card>
                </>
              );
            }}
          </QueryState>
        )}
      </RequirePermission>
    </Page>
  );
}
