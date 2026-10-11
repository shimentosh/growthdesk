"use client";

import { useState, type FormEvent } from "react";
import { useParams, useRouter } from "next/navigation";
import { History, ListFilter, Play, Settings2, Trash2, Workflow as WorkflowIcon, Zap } from "lucide-react";
import type { z } from "zod";
import { WORKFLOW_TRIGGERS, type WorkflowInput, type WorkflowTrigger } from "@growthdesk/shared";
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

function Editor({ workflow }: { workflow: Workflow | null }) {
  const ws = useWorkspace();
  const f = useFormat();
  const router = useRouter();
  const canWrite = ws.can("automation.write");
  const [baseline, setBaseline] = useState<Draft>(() => (workflow ? draftOf(workflow) : BLANK));
  const [draft, setDraft] = useState<Draft>(baseline);
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
                options={WORKFLOW_TRIGGERS.map((t) => ({ value: t, label: <TriggerLabel trigger={t} />, description: <span className="block pl-6">{TRIGGER_LABELS[t].description}</span> }))}
              />
            </Field>
          </CardBody>
        </Card>

        <Card>
          <CardHeader icon={<ListFilter />} title="2 · Only if" description="Every condition must hold. Text matches ignore case." />
          <CardBody>
            <ConditionEditor value={draft.conditions} onChange={(c) => set("conditions", c)} disabled={!canWrite} />
            {fields.conditions && <p className="mt-2 text-xs text-bad-ink">{fields.conditions}</p>}
          </CardBody>
        </Card>

        <Card>
          <CardHeader icon={<Play />} title="3 · Then do this" description="Actions run in order. A wait pauses the run before that action." />
          <CardBody>
            <ActionList value={draft.actions} onChange={(a) => set("actions", a)} disabled={!canWrite} />
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
          workflow ? (
            <Badge tone={workflow.enabled ? "ok" : "mute"} dot>
              {workflow.enabled ? "Active" : "Off"}
            </Badge>
          ) : undefined
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

export default function WorkflowEditorPage() {
  const ws = useWorkspace();
  const { workflowId } = useParams<{ workflowId: string }>();
  const isNew = workflowId === "new";
  const wf = useApiQuery<Workflow>(ws.key("workflows", workflowId), isNew ? null : ws.path(`/workflows/${workflowId}`));

  return (
    <Page width="narrow">
      <RequirePermission permission={isNew ? "automation.write" : "automation.read"}>
        {isNew ? (
          <Editor key="new" workflow={null} />
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
