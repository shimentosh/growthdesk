"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useParams, useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Copy, ListOrdered, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { QueryState } from "@/components/ui/ErrorState";
import { Field, FormError } from "@/components/ui/Field";
import { EntityTile } from "@/components/ui/icons";
import { Input, Textarea } from "@/components/ui/Input";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { RequirePermission } from "@/components/ui/RequirePermission";
import { SkeletonText } from "@/components/ui/Skeleton";
import { toast } from "@/components/ui/Toast";
import { StepsEditor } from "@/components/sequences/StepsEditor";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import { cleanSteps, stepsOf, type SequenceBody, type SequenceDetail, type SequenceStep } from "@/lib/types/sequences";

type Draft = { name: string; description: string; steps: SequenceStep[] };

const BLANK: Draft = { name: "", description: "", steps: [{ type: "email", config: { subject: "", body: "" } }] };

const draftOf = (s: SequenceDetail): Draft => ({ name: s.name, description: s.description ?? "", steps: stepsOf(s.steps) });

function Builder({ sequence }: { sequence: SequenceDetail | null }) {
  const ws = useWorkspace();
  const f = useFormat();
  const router = useRouter();
  const qc = useQueryClient();
  const canWrite = ws.can("campaigns.write");
  const [baseline, setBaseline] = useState<Draft>(() => (sequence ? draftOf(sequence) : BLANK));
  const [draft, setDraft] = useState<Draft>(baseline);
  const [confirm, setConfirm] = useState(false);
  const dirty = JSON.stringify(baseline) !== JSON.stringify(draft);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  useEffect(() => {
    if (!dirty || !canWrite) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, canWrite]);

  const save = useApiMutation<SequenceDetail, SequenceBody>({
    method: sequence ? "PATCH" : "POST",
    path: sequence ? ws.path(`/sequences/${sequence.id}`) : ws.path("/sequences"),
    invalidate: [ws.key("sequences")],
    success: sequence ? "Sequence saved" : "Sequence created",
    errorToast: false,
    onSuccess: (saved) => {
      const next = draftOf(saved);
      setBaseline(next);
      setDraft(next);
      qc.setQueryData(ws.key("sequences", saved.id), saved);
      if (!sequence) router.replace(ws.href(`/sequences/${saved.id}`));
    },
  });
  const duplicate = useApiMutation<SequenceDetail, void>({
    path: ws.path(`/sequences/${sequence?.id}/duplicate`),
    invalidate: [ws.key("sequences", "list")],
    onSuccess: (copy) => {
      toast.success(`Duplicated as “${copy.name}”`);
      router.push(ws.href(`/sequences/${copy.id}`));
    },
  });
  const remove = useApiMutation<{ deleted: boolean }, void>({
    method: "DELETE",
    path: ws.path(`/sequences/${sequence?.id}`),
    invalidate: [ws.key("sequences", "list")],
    success: "Sequence deleted",
    errorToast: false,
    onSuccess: () => router.push(ws.href("/sequences")),
  });

  const fields = save.error?.fields ?? {};
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({ name: draft.name.trim(), description: draft.description.trim(), steps: cleanSteps(draft.steps) });
  };
  const stepCount = draft.steps.length;

  return (
    <>
      <PageHeader
        back={{ href: ws.href("/sequences"), label: "Sequences" }}
        icon={<EntityTile of="sequences" />}
        title={draft.name.trim() || (sequence ? sequence.name : "New sequence")}
        description={
          sequence
            ? `${stepCount} step${stepCount === 1 ? "" : "s"} · updated ${f.relative(sequence.updatedAt)}`
            : "Lay out the steps once; campaigns start from a copy of them."
        }
        actions={
          canWrite ? (
            <>
              {dirty && <span className="text-xs text-text-3">Unsaved changes</span>}
              {sequence && (
                <>
                  <Button variant="ghost" icon={<Trash2 />} onClick={() => setConfirm(true)}>
                    Delete
                  </Button>
                  <Button
                    variant="ghost"
                    icon={<Copy />}
                    loading={duplicate.isPending}
                    disabled={dirty}
                    title={dirty ? "Save or discard your changes first: the copy is made from the saved version." : undefined}
                    onClick={() => duplicate.mutate()}
                  >
                    Duplicate
                  </Button>
                </>
              )}
              {dirty && sequence && (
                <Button
                  onClick={() => {
                    setDraft(baseline);
                    save.reset();
                  }}
                  disabled={save.isPending}
                >
                  Discard
                </Button>
              )}
              <Button variant="primary" type="submit" form="sequence-form" loading={save.isPending} disabled={sequence ? !dirty : false}>
                {sequence ? "Save" : "Create sequence"}
              </Button>
            </>
          ) : undefined
        }
      />

      {!canWrite && (
        <Callout tone="info" className="mb-4">
          You can view this sequence; your role cannot change it.
        </Callout>
      )}

      <form id="sequence-form" onSubmit={submit} noValidate className="flex min-w-0 flex-col gap-4">
        {save.error && !save.error.isPlanLimit && <FormError error={save.error.message} />}
        <Card>
          <fieldset disabled={!canWrite} className="min-w-0">
            <CardBody className="grid gap-4">
              <Field label="Name" required error={fields.name}>
                <Input value={draft.name} maxLength={120} onChange={(e) => set("name", e.target.value)} placeholder="Founder outreach, 4 touches" />
              </Field>
              <Field label="Description" error={fields.description}>
                <Textarea rows={2} maxLength={1000} value={draft.description} onChange={(e) => set("description", e.target.value)} placeholder="Who it is for and when to use it." />
              </Field>
            </CardBody>
          </fieldset>
        </Card>

        <Card>
          <CardHeader
            icon={<ListOrdered />}
            title="Steps"
            description="Run in order for each contact. Each step can wait first; a branch splits the path on what the contact did or who they are."
          />
          <CardBody>
            <StepsEditor steps={draft.steps} onChange={(steps) => set("steps", steps)} readOnly={!canWrite} errors={fields} />
          </CardBody>
        </Card>
      </form>

      {sequence && (
        <ConfirmDialog
          open={confirm}
          onOpenChange={setConfirm}
          title={`Delete “${sequence.name}”?`}
          description="Campaigns made from it keep their own copy of the steps, so nothing they send changes."
          onConfirm={() => remove.mutateAsync()}
        />
      )}
    </>
  );
}

export default function SequenceBuilderPage() {
  const ws = useWorkspace();
  const { sequenceId } = useParams<{ sequenceId: string }>();
  const isNew = sequenceId === "new";
  const seq = useApiQuery<SequenceDetail>(ws.key("sequences", sequenceId), isNew ? null : ws.path(`/sequences/${sequenceId}`));

  return (
    <Page width="narrow">
      <RequirePermission permission={isNew ? "campaigns.write" : "campaigns.read"}>
        {isNew ? (
          <Builder key="new" sequence={null} />
        ) : (
          <QueryState
            query={seq}
            loading={
              <Card className="p-4">
                <SkeletonText lines={8} />
              </Card>
            }
          >
            {(s) => <Builder key={s.id} sequence={s} />}
          </QueryState>
        )}
      </RequirePermission>
    </Page>
  );
}
