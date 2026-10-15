"use client";

import { Suspense, useState, type FormEvent } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { History, ListFilter, Play, Settings2, Trash2, Workflow as WorkflowIcon, Zap } from "lucide-react";
import type { z } from "zod";
import { TRIGGER_EVENT_FIELDS, WORKFLOW_KINDS, WORKFLOW_TEMPLATES, WORKFLOW_TRIGGERS, workflowKind, type WorkflowInput, type WorkflowKind, type WorkflowTrigger } from "@growthdesk/shared";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Checkbox } from "@/components/ui/Checkbox";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { QueryState } from "@/components/ui/ErrorState";
import { Field, FormError } from "@/components/ui/Field";
import { Input, Textarea } from "@/components/ui/Input";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { RequirePermission } from "@/components/ui/RequirePermission";
import { Select } from "@/components/ui/Select";
import { SkeletonText } from "@/components/ui/Skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { EntityTile } from "@/components/ui/icons";
import { ActionList } from "@/components/automation/ActionEditor";
import { ConditionEditor } from "@/components/automation/ConditionEditor";
import { RunsList } from "@/components/automation/RunsList";
import { TriggerLabel } from "@/components/automation/glyphs";
import { KIND_META, KindChooser, TemplateGallery, triggersOf } from "@/components/automation/WorkflowStarter";
import { formatNumber } from "@/lib/format";
import { useUnsavedChanges } from "@/lib/unsaved";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import { TRIGGER_LABELS, type Workflow, type WorkflowAction, type WorkflowCondition } from "@/lib/types/automation";

type WorkflowInputT = z.input<typeof WorkflowInput>;

type Draft = {
  name: string;
  description: string;
  trigger: WorkflowTrigger;
  conditions: WorkflowCondition[];
  actions: WorkflowAction[];
  requiresApproval: boolean;
  enabled: boolean;
};

const BLANK: Draft = { name: "", description: "", trigger: "contact.created", conditions: [], actions: [], requiresApproval: false, enabled: false };

const draftOf = (w: Workflow): Draft => ({
  name: w.name,
  description: w.description ?? "",
  trigger: w.trigger,
  conditions: Array.isArray(w.conditions) ? w.conditions : [],
  actions: Array.isArray(w.actions) ? w.actions.map((a) => ({ type: a.type, delayMinutes: a.delayMinutes ?? 0, config: a.config ?? {} })) : [],
  requiresApproval: w.requiresApproval,
  enabled: w.enabled,
});

const bodyOf = (d: Draft): WorkflowInputT => ({
  name: d.name.trim(),
  description: d.description.trim(),
  trigger: d.trigger,
  conditions: d.conditions,
  actions: d.actions,
  requiresApproval: d.requiresApproval,
  enabled: d.enabled,
});

/** A new workflow's starting point: the draft, its kind, and what is still to choose (from a template). */
type Start = { draft: Draft; kind: WorkflowKind; todo?: string };

/** A template, or a blank workflow of the kind (its first trigger). */
function fromTemplate(kind: WorkflowKind, templateId: string): Start | null {
  if (templateId === "blank") return { kind, draft: { ...BLANK, trigger: triggersOf(kind)[0]! } };
  const t = WORKFLOW_TEMPLATES.find((x) => x.id === templateId);
  if (!t) return null;
  return {
    kind: t.kind,
    todo: t.todo,
    draft: {
      ...BLANK,
      name: t.name,
      description: t.description,
      trigger: t.trigger,
      conditions: t.conditions.map((c) => ({ ...c })),
      actions: t.actions.map((a) => ({ type: a.type, delayMinutes: a.delayMinutes ?? 0, config: { ...a.config } })),
    },
  };
}

/** A new workflow opened from a campaign ("enroll every new lead"): new contacts and imported leads go into it. */
function prefilled(campaignId: string, campaignName: string | null, trigger: string | null): Draft {
  return {
    ...BLANK,
    trigger: (WORKFLOW_TRIGGERS as readonly string[]).includes(trigger ?? "") ? (trigger as WorkflowTrigger) : BLANK.trigger,
    name: campaignName ? `New leads → ${campaignName}`.slice(0, 120) : "New leads → campaign",
    // Made from a campaign to start enrolling people: on unless switched off before saving.
    enabled: true,
    actions: [{ type: "enroll_campaign", delayMinutes: 0, config: { campaignId } }],
  };
}

function Editor({ workflow, start }: { workflow: Workflow | null; start?: Start }) {
  const ws = useWorkspace();
  const f = useFormat();
  const router = useRouter();
  const canWrite = ws.can("automation.write");
  // The starting point is "unsaved" for a new workflow (template or prefilled), so Save is offered at once.
  const [baseline, setBaseline] = useState<Draft>(() => (workflow ? draftOf(workflow) : BLANK));
  const [draft, setDraft] = useState<Draft>(() => (workflow ? baseline : (start?.draft ?? BLANK)));
  const kind: WorkflowKind = workflow ? workflowKind(workflow.trigger) : (start?.kind ?? workflowKind(draft.trigger));
  // The kind's own triggers, plus the current one should an older workflow use another kind's.
  const triggerChoices = [...new Set([...triggersOf(kind), draft.trigger])].filter((t) => (WORKFLOW_TRIGGERS as readonly string[]).includes(t));
  const [confirm, setConfirm] = useState(false);
  const dirty = JSON.stringify(baseline) !== JSON.stringify(draft);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  // Leaving with unsaved edits asks first: reloads, closing the tab, and in-app links (the sidebar included).
  useUnsavedChanges(dirty && canWrite, "Your changes to this workflow will be lost.");

  const save = useApiMutation<Workflow, WorkflowInputT>({
    method: workflow ? "PATCH" : "POST",
    path: workflow ? ws.path(`/workflows/${workflow.id}`) : ws.path("/workflows"),
    invalidate: [ws.key("workflows")],
    success: workflow ? "Workflow saved" : "Workflow created",
    errorToast: false,
    onSuccess: (saved) => {
      const next = draftOf(saved);
      setBaseline(next);
      setDraft(next);
      if (!workflow) router.replace(ws.href(`/automation/${saved.id}`));
    },
  });
  const remove = useApiMutation<{ deleted: boolean }, void>({
    method: "DELETE",
    path: ws.path(`/workflows/${workflow?.id}`),
    invalidate: [ws.key("workflows", "list"), ws.key("workflow-runs")],
    success: "Workflow deleted",
    errorToast: false,
    onSuccess: () => router.push(ws.href("/automation")),
  });

  const fields = save.error?.fields ?? {};
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(bodyOf(draft));
  };
  const trigger = TRIGGER_LABELS[draft.trigger];

  const builder = (
    <form id="workflow-form" onSubmit={submit} noValidate>
      <fieldset disabled={!canWrite} className="flex min-w-0 flex-col gap-4">
        {save.error && !save.error.isPlanLimit && <FormError error={save.error.message} />}
        {!workflow && start?.todo && (
          <Callout tone="info" title="Almost ready">
            {start.todo}, then create the workflow. It starts switched off — turn on Active under Settings when you are happy with it.
          </Callout>
        )}
        <Card>
          <CardBody className="grid gap-4">
            <Field label="Name" required error={fields.name}>
              <Input value={draft.name} maxLength={120} onChange={(e) => set("name", e.target.value)} placeholder="Assign new leads round-robin" />
            </Field>
            <Field label="Description" error={fields.description}>
              <Textarea rows={2} maxLength={1000} value={draft.description} onChange={(e) => set("description", e.target.value)} placeholder="What it is for, so a teammate knows whether to touch it." />
            </Field>
          </CardBody>
        </Card>

        <Card>
          <CardHeader icon={<Zap />} title="1 · When this happens" />
          <CardBody>
            <Field label="Trigger" error={fields.trigger} hint={trigger?.description}>
              <Select<WorkflowTrigger>
                value={draft.trigger}
                disabled={!canWrite}
                onValueChange={(v) => set("trigger", v)}
                options={triggerChoices.map((t) => ({ value: t, label: <TriggerLabel trigger={t} />, description: <span className="block pl-6">{TRIGGER_LABELS[t].description}</span> }))}
              />
            </Field>
          </CardBody>
        </Card>

        <Card>
          <CardHeader icon={<ListFilter />} title="2 · Only if" description="Every condition must hold. Text matches ignore case." />
          <CardBody>
            <ConditionEditor value={draft.conditions} onChange={(c) => set("conditions", c)} disabled={!canWrite} eventFields={TRIGGER_EVENT_FIELDS[draft.trigger] ?? []} />
            {fields.conditions && <p className="mt-2 text-xs text-bad-ink">{fields.conditions}</p>}
          </CardBody>
        </Card>

        <Card>
          <CardHeader icon={<Play />} title="3 · Then do this" description="Actions run in order. A wait pauses the run before that action." />
          <CardBody>
            <ActionList value={draft.actions} onChange={(a) => set("actions", a)} disabled={!canWrite} kind={kind} />
            {fields.actions && <p className="mt-2 text-xs text-bad-ink">{fields.actions}</p>}
          </CardBody>
        </Card>

        <Card>
          <CardHeader icon={<Settings2 />} title="Settings" />
          <CardBody className="flex flex-col gap-3">
            <Checkbox
              checked={draft.requiresApproval}
              onCheckedChange={(c) => set("requiresApproval", c)}
              label="Ask for approval before acting"
              description="Each run pauses after its conditions pass; owners and admins are notified and approve or reject it under Runs."
            />
            <Checkbox
              checked={draft.enabled}
              onCheckedChange={(c) => set("enabled", c)}
              label="Active"
              description="Only active workflows run. Events from before it was switched on are not replayed."
            />
          </CardBody>
        </Card>
      </fieldset>
    </form>
  );

  return (
    <>
      <PageHeader
        back={{ href: ws.href("/automation"), label: "Workflows" }}
        icon={<EntityTile of="workflows" />}
        title={draft.name.trim() || (workflow ? workflow.name : "New workflow")}
        meta={
          <>
            <Badge quiet>{KIND_META[kind].short}</Badge>
            {workflow && (
              <Badge tone={workflow.enabled ? "ok" : "mute"} dot>
                {workflow.enabled ? "Active" : "Off"}
              </Badge>
            )}
          </>
        }
        description={
          workflow
            ? `${formatNumber(workflow.runCount)} run${workflow.runCount === 1 ? "" : "s"}${workflow.lastRunAt ? ` · last ${f.relative(workflow.lastRunAt)}` : ""} · updated ${f.relative(workflow.updatedAt)}`
            : "Choose a trigger, add conditions if it should not run every time, then the actions."
        }
        actions={
          canWrite ? (
            <>
              {dirty && <span className="text-xs text-text-3">Unsaved changes</span>}
              {workflow && (
                <Button variant="ghost" icon={<Trash2 />} onClick={() => setConfirm(true)}>
                  Delete
                </Button>
              )}
              {dirty && workflow && (
                <Button onClick={() => { setDraft(baseline); save.reset(); }} disabled={save.isPending}>
                  Discard
                </Button>
              )}
              <Button variant="primary" type="submit" form="workflow-form" loading={save.isPending} disabled={workflow ? !dirty : false}>
                {workflow ? "Save" : "Create workflow"}
              </Button>
            </>
          ) : undefined
        }
      />

      {!canWrite && (
        <Callout tone="info" className="mb-4">
          You can view this workflow; your role cannot change it.
        </Callout>
      )}

      {workflow ? (
        <Tabs defaultValue="builder">
          <TabsList>
            <TabsTrigger value="builder">
              <WorkflowIcon aria-hidden />
              Builder
            </TabsTrigger>
            <TabsTrigger value="runs">
              <History aria-hidden />
              Runs
            </TabsTrigger>
          </TabsList>
          <TabsContent value="builder">{builder}</TabsContent>
          <TabsContent value="runs">
            <Card>
              <RunsList workflowId={workflow.id} />
            </Card>
          </TabsContent>
        </Tabs>
      ) : (
        builder
      )}

      {workflow && (
        <ConfirmDialog
          open={confirm}
          onOpenChange={setConfirm}
          title={`Delete “${workflow.name}”?`}
          description="It stops running, and its runs still waiting on a delay or an approval are canceled. Past runs stay in the log."
          onConfirm={() => remove.mutateAsync()}
        />
      )}
    </>
  );
}

/**
 * /automation/new: kind (?kind=) → template (?template=) → the builder. A
 * campaign's "enroll every new lead" link (?enrollCampaign=) goes straight to
 * the builder, as before.
 */
function NewWorkflow() {
  const ws = useWorkspace();
  const router = useRouter();
  const sp = useSearchParams();
  const campaignId = sp.get("enrollCampaign");
  const kindParam = sp.get("kind");
  const kind = (WORKFLOW_KINDS as readonly string[]).includes(kindParam ?? "") ? (kindParam as WorkflowKind) : null;
  const templateId = sp.get("template");
  const go = (q: string) => router.push(ws.href(`/automation/new${q}`));

  if (campaignId) return <Editor key={`campaign-${campaignId}`} workflow={null} start={{ kind: "sales", draft: prefilled(campaignId, sp.get("campaignName"), sp.get("trigger")) }} />;
  const start = kind && templateId ? fromTemplate(kind, templateId) : null;
  if (start) return <Editor key={`${kind}-${templateId}`} workflow={null} start={start} />;

  return (
    <>
      <PageHeader back={{ href: ws.href("/automation"), label: "Workflows" }} icon={<EntityTile of="workflows" />} title="New workflow" description={kind ? "Start from a template, or from scratch." : "Choose what it works on."} />
      {kind ? <TemplateGallery kind={kind} onBack={() => go("")} onPick={(id) => go(`?kind=${kind}&template=${id}`)} /> : <KindChooser onPick={(k) => go(`?kind=${k}`)} />}
    </>
  );
}

export default function WorkflowEditorPage() {
  const ws = useWorkspace();
  const { workflowId } = useParams<{ workflowId: string }>();
  const isNew = workflowId === "new";
  const wf = useApiQuery<Workflow>(ws.key("workflows", workflowId), isNew ? null : ws.path(`/workflows/${workflowId}`));

  return (
    <Page width="narrow">
      <RequirePermission permission={isNew ? "automation.write" : "automation.read"}>
        {isNew ? (
          <Suspense fallback={<SkeletonText lines={6} />}>
            <NewWorkflow />
          </Suspense>
        ) : (
          <QueryState
            query={wf}
            loading={
              <Card className="p-4">
                <SkeletonText lines={6} />
              </Card>
            }
          >
            {(w) => <Editor key={w.id} workflow={w} />}
          </QueryState>
        )}
      </RequirePermission>
    </Page>
  );
}
