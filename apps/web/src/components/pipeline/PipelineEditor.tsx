"use client";

import { useState, type FormEvent } from "react";
import { ArrowDown, ArrowUp, Archive, Plus, SquareKanban, Star, Trash2 } from "lucide-react";
import { labelOf, STAGE_KINDS, type StageKind } from "@growthdesk/shared";
import { Badge } from "@/components/ui/Badge";
import { Button, IconButton } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/Card";
import { Checkbox } from "@/components/ui/Checkbox";
import { ConfirmDialog, Modal } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Input, NativeSelect } from "@/components/ui/Input";
import { useApiMutation } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import type { Pipeline } from "@/lib/types/pipeline";
import { fieldErrors, useOpenKey } from "./utils";

/** PipelineInput allows 2–30 stages. */
const MIN_STAGES = 2;
const MAX_STAGES = 30;

type DraftStage = {
  /** A local key for React; the server id when the stage already exists. */
  key: string;
  id?: string;
  name: string;
  kind: StageKind;
  probability: string;
  /** Kept as-is: colour names have no place in this app's palette, but the API stores them. */
  color?: string;
};

let seq = 0;
const draftOf = (p: Pipeline): DraftStage[] =>
  p.stages.map((s) => ({ key: s.id, id: s.id, name: s.name, kind: s.kind, probability: String(s.probability), color: s.color }));

/** What would stop the API from accepting these stages (assertStages + PipelineInput), in words. */
function problems(name: string, stages: DraftStage[]): string[] {
  const out: string[] = [];
  if (!name.trim()) out.push("Give the pipeline a name.");
  if (stages.length < MIN_STAGES) out.push(`A pipeline needs at least ${MIN_STAGES} stages.`);
  if (stages.length > MAX_STAGES) out.push(`A pipeline can have at most ${MAX_STAGES} stages.`);
  if (stages.some((s) => !s.name.trim())) out.push("Every stage needs a name.");
  if (!stages.some((s) => s.kind === "open")) out.push("Keep at least one open stage.");
  if (!stages.some((s) => s.kind === "won")) out.push("Keep a Won stage.");
  if (!stages.some((s) => s.kind === "lost")) out.push("Keep a Lost stage.");
  if (stages.some((s) => !/^\d{1,3}$/.test(s.probability.trim()) || Number(s.probability) > 100)) out.push("Probabilities are whole numbers from 0 to 100.");
  return out;
}

/**
 * One pipeline: its name and ordered stages, saved together (PUT /pipelines/:id).
 * Stages keep their ids, so renaming or reordering never touches the deals in
 * them; the API refuses to remove a stage that still holds deals.
 */
export function PipelineEditor({ pipeline, canManage }: { pipeline: Pipeline; canManage: boolean }) {
  const ws = useWorkspace();
  const [name, setName] = useState(pipeline.name);
  const [stages, setStages] = useState<DraftStage[]>(() => draftOf(pipeline));
  const [archiving, setArchiving] = useState(false);
  const dirty = name !== pipeline.name || JSON.stringify(stages.map(({ key: _k, ...s }) => s)) !== JSON.stringify(draftOf(pipeline).map(({ key: _k, ...s }) => s));
  const issues = problems(name, stages);

  const save = useApiMutation<Pipeline, void>({
    method: "PUT",
    path: ws.path(`/pipelines/${pipeline.id}`),
    body: () => ({
      name: name.trim(),
      stages: stages.map((s) => ({ ...(s.id ? { id: s.id } : {}), name: s.name.trim(), kind: s.kind, probability: Number(s.probability), ...(s.color ? { color: s.color } : {}) })),
    }),
    // Deals embed their stage's name, so they refresh too.
    invalidate: [ws.key("pipelines"), ws.key("deals")],
    success: "Pipeline saved",
    errorToast: false,
    onSuccess: (p) => {
      setName(p.name);
      setStages(draftOf(p));
    },
  });
  const makeDefault = useApiMutation<Pipeline, void>({
    method: "PUT",
    path: ws.path(`/pipelines/${pipeline.id}`),
    // Name only, no stages: the API leaves the stages alone.
    body: () => ({ name: pipeline.name, isDefault: true }),
    invalidate: [ws.key("pipelines")],
    success: `${pipeline.name} is now the default pipeline`,
  });
  const archive = useApiMutation<unknown, void>({
    method: "DELETE",
    path: ws.path(`/pipelines/${pipeline.id}`),
    invalidate: [ws.key("pipelines"), ws.key("deals")],
    success: "Pipeline archived",
    errorToast: false,
  });
  const errors = fieldErrors(save.error);

  const update = (key: string, patch: Partial<DraftStage>) => setStages((list) => list.map((s) => (s.key === key ? { ...s, ...patch } : s)));
  const moveBy = (index: number, delta: number) =>
    setStages((list) => {
      const next = [...list];
      const [item] = next.splice(index, 1);
      next.splice(index + delta, 0, item!);
      return next;
    });
  const add = () =>
    setStages((list) => {
      // New stages go before the closing (Won / Lost) stages, where open stages belong.
      const at = list.findIndex((s) => s.kind !== "open");
      const stage: DraftStage = { key: `new-${++seq}`, name: "", kind: "open", probability: "0" };
      const next = [...list];
      next.splice(at === -1 ? next.length : at, 0, stage);
      return next;
    });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!issues.length) save.mutate();
  };

  return (
    <Card>
      <CardHeader
        icon={<SquareKanban />}
        title={
          <span className="flex items-center gap-2">
            {pipeline.name}
            {pipeline.isDefault && <Badge tone="info">Default</Badge>}
          </span>
        }
        description={`${pipeline.stages.length} stages`}
        actions={
          canManage && !pipeline.isDefault ? (
            <>
              <Button size="sm" variant="ghost" icon={<Star />} loading={makeDefault.isPending} onClick={() => makeDefault.mutate()}>
                Make default
              </Button>
              <Button size="sm" variant="ghost" icon={<Archive />} onClick={() => setArchiving(true)}>
                Archive
              </Button>
            </>
          ) : undefined
        }
      />
      <form onSubmit={submit}>
        <CardBody className="flex flex-col gap-4">
          <FormError error={save.error && !Object.keys(save.error.fields).length && !save.error.isPlanLimit ? save.error.message : null} />
          <Field label="Name" error={errors.name} className="max-w-sm">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} disabled={!canManage} />
          </Field>

          <div>
            <div className="mb-1.5 hidden grid-cols-[24px_minmax(0,1fr)_120px_88px_auto] items-center gap-2 px-1 text-xs font-medium text-text-3 sm:grid">
              <span aria-hidden>#</span>
              <span>Stage</span>
              <span>Kind</span>
              <span>Probability</span>
              <span className="sr-only">Order</span>
            </div>
            <ol className="flex flex-col gap-2">
              {stages.map((s, i) => {
                const rowError = errors[`stages.${i}.name`] ?? errors[`stages.${i}.kind`] ?? errors[`stages.${i}.probability`];
                return (
                  <li key={s.key} className="rounded-md border border-line bg-well p-2 sm:border-0 sm:bg-transparent sm:p-0">
                    <div className="grid grid-cols-[24px_minmax(0,1fr)] items-center gap-2 sm:grid-cols-[24px_minmax(0,1fr)_120px_88px_auto]">
                      <span className="text-center text-xs text-text-3 tabular-nums">{i + 1}</span>
                      <Input
                        aria-label={`Stage ${i + 1} name`}
                        value={s.name}
                        onChange={(e) => update(s.key, { name: e.target.value })}
                        maxLength={60}
                        placeholder="Stage name"
                        invalid={Boolean(errors[`stages.${i}.name`])}
                        disabled={!canManage}
                      />
                      <NativeSelect
                        aria-label={`Stage ${i + 1} kind`}
                        className="col-start-2 sm:col-start-auto"
                        value={s.kind}
                        disabled={!canManage}
                        onChange={(e) => {
                          const kind = e.target.value as StageKind;
                          // Closing stages are certain: Won is 100%, Lost is 0%.
                          update(s.key, { kind, ...(kind === "won" ? { probability: "100" } : kind === "lost" ? { probability: "0" } : {}) });
                        }}
                        options={STAGE_KINDS.map((k) => ({ value: k, label: labelOf(k) }))}
                      />
                      <div className="col-start-2 flex items-center gap-1.5 sm:col-start-auto">
                        <Input
                          aria-label={`Stage ${i + 1} probability`}
                          type="number"
                          inputMode="numeric"
                          min={0}
                          max={100}
                          step={1}
                          value={s.probability}
                          onChange={(e) => update(s.key, { probability: e.target.value })}
                          disabled={!canManage}
                        />
                        <span className="text-xs text-text-3">%</span>
                      </div>
                      {canManage && (
                        <div className="col-start-2 flex items-center gap-0.5 sm:col-start-auto">
                          <IconButton size="sm" label={`Move ${s.name || "stage"} up`} icon={<ArrowUp />} disabled={i === 0} onClick={() => moveBy(i, -1)} />
                          <IconButton size="sm" label={`Move ${s.name || "stage"} down`} icon={<ArrowDown />} disabled={i === stages.length - 1} onClick={() => moveBy(i, 1)} />
                          <IconButton
                            size="sm"
                            variant="danger"
                            label={`Remove ${s.name || "stage"}`}
                            icon={<Trash2 />}
                            disabled={stages.length <= MIN_STAGES}
                            onClick={() => setStages((list) => list.filter((x) => x.key !== s.key))}
                          />
                        </div>
                      )}
                    </div>
                    {rowError && <p className="mt-1 pl-8 text-xs text-bad-ink">{rowError}</p>}
                  </li>
                );
              })}
            </ol>
            {canManage && (
              <Button size="sm" variant="ghost" icon={<Plus />} className="mt-2" disabled={stages.length >= MAX_STAGES} onClick={add}>
                Add stage
              </Button>
            )}
          </div>

          {canManage && dirty && issues.length > 0 && (
            <Callout tone="warn" title="Fix these before saving">
              <ul className="list-disc pl-4">
                {issues.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </Callout>
          )}
          {canManage && <p className="text-xs text-text-3">Deals stay in their stage when you rename or reorder it. A stage that still holds deals cannot be removed — move them out first.</p>}
        </CardBody>
        {canManage && (
          <CardFooter>
            {dirty && (
              <Button
                onClick={() => {
                  setName(pipeline.name);
                  setStages(draftOf(pipeline));
                  save.reset();
                }}
              >
                Discard
              </Button>
            )}
            <Button variant="primary" type="submit" disabled={!dirty || issues.length > 0} loading={save.isPending}>
              Save changes
            </Button>
          </CardFooter>
        )}
      </form>
      <ConfirmDialog
        open={archiving}
        onOpenChange={setArchiving}
        title={`Archive “${pipeline.name}”?`}
        description="It disappears from the deals board and from new deals. A pipeline with open deals cannot be archived — close or move them first."
        confirmLabel="Archive"
        onConfirm={() => archive.mutateAsync()}
      />
    </Card>
  );
}

/** POST /pipelines with a name. The API gives it the standard stages, which can be edited afterwards. */
export function NewPipelineModal({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const key = useOpenKey(open);
  return <NewPipelineDialog key={key} open={open} onOpenChange={onOpenChange} />;
}

function NewPipelineDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const ws = useWorkspace();
  const [name, setName] = useState("");
  const [isDefault, setIsDefault] = useState(false);
  const create = useApiMutation<Pipeline, { name: string; isDefault: boolean }>({
    path: ws.path("/pipelines"),
    invalidate: [ws.key("pipelines")],
    success: (p) => `Pipeline “${p.name}” created`,
    errorToast: false,
    onSuccess: () => onOpenChange(false),
  });
  const errors = fieldErrors(create.error);
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="New pipeline"
      description="It starts with the standard stages. Rename, reorder or replace them after it is created."
      size="sm"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="new-pipeline" loading={create.isPending} disabled={!name.trim()}>
            Create pipeline
          </Button>
        </>
      }
    >
      <form
        id="new-pipeline"
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) create.mutate({ name: name.trim(), isDefault });
        }}
      >
        <FormError error={create.error && !errors.name && !create.error.isPlanLimit ? create.error.message : null} />
        <Field label="Name" required error={errors.name}>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus placeholder="e.g. Partnerships" />
        </Field>
        <Checkbox checked={isDefault} onCheckedChange={setIsDefault} label="Make it the default" description="New deals go here unless another pipeline is chosen." />
      </form>
    </Modal>
  );
}
