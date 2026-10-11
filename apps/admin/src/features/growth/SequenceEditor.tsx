"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, CircleAlert, Clock, Plus, Save, Send, Trash2 } from "lucide-react";
import { PLATFORM_DRIP_MAX_DELAY_HOURS, PLATFORM_DRIP_TRIGGER_LABELS, PLATFORM_DRIP_TRIGGERS, type PlatformDripTrigger } from "@growthdesk/shared";
import { Badge } from "@/components/ui/Badge";
import { Button, IconButton } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { ConfirmDialog, Modal } from "@/components/ui/Dialog";
import { QueryState } from "@/components/ui/ErrorState";
import { Field } from "@/components/ui/Field";
import { Input, NativeSelect } from "@/components/ui/Input";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { SkeletonText } from "@/components/ui/Skeleton";
import { StatCard } from "@/components/ui/StatCard";
import { Switch } from "@/components/ui/Switch";
import { cn } from "@/lib/cn";
import { formatNumber, formatPercent } from "@/lib/format";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useFormat } from "@/lib/session";
import { platformKey, usePlatform } from "@/features/common/platform";
import { SendResultView } from "@/features/email/EmailSettings";
import { ContentEditor, delayLabel, GrowthTile } from "./common";
import type { MarketingContent, SequenceDetail, SequenceStats, SequenceStep, TestSendResult } from "./types";

/*
 * /growth/sequences/[id] — the trigger, the on/off switch, and the steps as a
 * timeline (delay, subject, per-step delivery numbers). Selecting a step opens
 * its editor below. While the sequence is on, a step must stay sendable, and
 * the trigger is fixed.
 */

type StepDraft = MarketingContent & { delayHours: number };
const stepDraft = (s: SequenceStep): StepDraft => ({ delayHours: s.delayHours, subject: s.subject, preheader: s.preheader, blocks: s.blocks });
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function DelayInput({ hours, onChange, disabled }: { hours: number; onChange: (h: number) => void; disabled?: boolean }) {
  const [unit, setUnit] = useState<"hours" | "days">(hours > 0 && hours % 24 === 0 ? "days" : "hours");
  const shown = unit === "days" ? hours / 24 : hours;
  const max = unit === "days" ? PLATFORM_DRIP_MAX_DELAY_HOURS / 24 : PLATFORM_DRIP_MAX_DELAY_HOURS;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-2">
      <Input
        type="number"
        min={0}
        max={max}
        inputMode="numeric"
        aria-label="Wait"
        value={Number.isInteger(shown) ? shown : Number(shown.toFixed(2))}
        onChange={(e) => {
          const n = Math.max(0, Math.min(max, Math.trunc(Number(e.target.value) || 0)));
          onChange(unit === "days" ? n * 24 : n);
        }}
        disabled={disabled}
      />
      <NativeSelect
        aria-label="Unit"
        value={unit}
        onChange={(e) => setUnit(e.target.value as "hours" | "days")}
        options={[
          { value: "hours", label: "hours" },
          { value: "days", label: "days" },
        ]}
        disabled={disabled}
      />
    </div>
  );
}

function StepEditor({ seq, step, onDeleted }: { seq: SequenceDetail; step: SequenceStep; onDeleted: () => void }) {
  const { canChange } = usePlatform();
  const first = step.position === 1;
  const [draft, setDraft] = useState<StepDraft>(() => stepDraft(step));
  const [server, setServer] = useState<StepDraft>(() => stepDraft(step));
  const [testResult, setTestResult] = useState<TestSendResult | null>(null);
  const [deleting, setDeleting] = useState(false);
  useEffect(() => {
    const next = stepDraft(step);
    if (same(next, server)) return;
    setDraft((d) => (same(d, server) ? next : d));
    setServer(next);
  }, [step, server]);
  const dirty = !same(draft, server);
  const save = useApiMutation<SequenceDetail, void>({
    method: "PATCH",
    path: `/admin/growth/sequences/${seq.id}/steps/${step.id}`,
    body: () => draft,
    invalidate: [platformKey("growth", "sequences")],
    success: "Step saved",
  });
  const test = useApiMutation<TestSendResult, void>({
    path: `/admin/growth/sequences/${seq.id}/steps/${step.id}/test`,
    body: () => ({}),
    invalidate: [platformKey("email-log")],
    onSuccess: (r) => setTestResult(r),
  });
  const remove = useApiMutation<SequenceDetail, void>({
    method: "DELETE",
    path: `/admin/growth/sequences/${seq.id}/steps/${step.id}`,
    invalidate: [platformKey("growth", "sequences")],
    success: "Step deleted",
    errorToast: false,
    onSuccess: onDeleted,
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold tracking-[-0.01em] text-text-hi">Step {step.position}</h2>
          {dirty && (
            <Badge tone="warn" dot>
              Unsaved
            </Badge>
          )}
        </div>
        {canChange && (
          <div className="flex flex-wrap items-center gap-2">
            <IconButton label="Delete step" icon={<Trash2 />} onClick={() => setDeleting(true)} disabled={seq.active && seq.steps.length === 1} />
            <Button icon={<Send />} loading={test.isPending} disabled={dirty} title={dirty ? "Save first; the test sends the saved step" : undefined} onClick={() => test.mutate()}>
              Send test to me
            </Button>
            <Button variant="primary" icon={<Save />} loading={save.isPending} disabled={!dirty} onClick={() => save.mutate()}>
              Save step
            </Button>
          </div>
        )}
      </div>
      <ContentEditor
        value={draft}
        onChange={(c) => setDraft({ ...draft, ...c })}
        disabled={!canChange}
        aside={
          <Card>
            <CardHeader icon={<Clock />} title="Timing" description={delayLabel(draft.delayHours, first)} />
            <CardBody>
              <Field label={first ? "Wait after the trigger" : "Wait after the previous step"} hint="Up to 90 days. Sends go out within 10 minutes of being due.">
                <DelayInput key={step.id} hours={draft.delayHours} onChange={(delayHours) => setDraft({ ...draft, delayHours })} disabled={!canChange} />
              </Field>
            </CardBody>
          </Card>
        }
      />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete step ${step.position}?`}
        description="People waiting for this step move on to the next one."
        onConfirm={() => remove.mutateAsync()}
      />
      <Modal open={testResult !== null} onOpenChange={(v) => !v && setTestResult(null)} title="Test email" footer={<Button onClick={() => setTestResult(null)}>Close</Button>}>
        {testResult && <SendResultView r={testResult} />}
      </Modal>
    </div>
  );
}

function Timeline({
  seq,
  stats,
  selected,
  onSelect,
}: {
  seq: SequenceDetail;
  stats: SequenceStats | undefined;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const { canChange } = usePlatform();
  const reorder = useApiMutation<SequenceDetail, string[]>({
    method: "PUT",
    path: `/admin/growth/sequences/${seq.id}/steps/order`,
    body: (stepIds) => ({ stepIds }),
    invalidate: [platformKey("growth", "sequences")],
  });
  const add = useApiMutation<SequenceDetail, void>({
    path: `/admin/growth/sequences/${seq.id}/steps`,
    body: () => ({
      delayHours: 24,
      subject: "A tip for getting more from {{product_name}}",
      preheader: "",
      blocks: [
        { type: "heading", id: `h${Date.now().toString(36)}`, text: "One thing worth trying", level: 1, align: "left" },
        { type: "text", id: `t${Date.now().toString(36)}`, text: "Hi {{name|there}},\n\nWrite the tip here.", align: "left" },
      ],
    }),
    invalidate: [platformKey("growth", "sequences")],
    success: "Step added",
    onSuccess: (d) => {
      const last = d.steps.at(-1);
      if (last) onSelect(last.id);
    },
  });
  const ids = seq.steps.map((s) => s.id);
  const move = (i: number, d: -1 | 1) => {
    const next = [...ids];
    const [x] = next.splice(i, 1);
    next.splice(i + d, 0, x!);
    reorder.mutate(next);
  };
  return (
    <Card>
      <CardHeader
        title="Steps"
        description="Each step waits after the one before it."
        actions={
          canChange && (
            <Button size="sm" icon={<Plus />} loading={add.isPending} onClick={() => add.mutate()} disabled={seq.steps.length >= 50}>
              Add step
            </Button>
          )
        }
      />
      <ol className="relative flex flex-col">
        {seq.steps.map((s, i) => {
          const st = stats?.steps.find((x) => x.stepId === s.id);
          const sent = st?.email.sent ?? 0;
          return (
            <li key={s.id} className={cn("border-b border-line last:border-b-0", selected === s.id && "bg-accent/6")}>
              <div className="flex items-start gap-3 px-4 py-3">
                <button type="button" onClick={() => onSelect(s.id)} className="flex min-w-0 flex-1 items-start gap-3 text-left">
                  <span
                    className={cn(
                      "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold tabular-nums",
                      selected === s.id ? "border-accent bg-accent text-white" : "border-line-strong bg-panel text-text-2",
                    )}
                  >
                    {s.position}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-2xs font-medium tracking-wide text-text-3 uppercase">{delayLabel(s.delayHours, i === 0)}</span>
                    <span className="block truncate text-sm font-medium text-text-hi">{s.subject || "No subject"}</span>
                    <span className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-text-3 tabular-nums">
                      <span>{formatNumber(sent)} sent</span>
                      {sent > 0 && <span>{formatPercent((st?.email.opened ?? 0) / sent, 0)} opened</span>}
                      {sent > 0 && <span>{formatPercent((st?.email.clicked ?? 0) / sent, 0)} clicked</span>}
                      {(st?.unsubscribes ?? 0) > 0 && <span>{st!.unsubscribes} unsubscribed</span>}
                      {(st?.waiting ?? 0) > 0 && <span>{formatNumber(st!.waiting)} waiting</span>}
                    </span>
                    {s.problems.length > 0 && (
                      <span className="mt-1 flex items-center gap-1 text-xs text-warn-ink">
                        <CircleAlert aria-hidden className="size-3.5" />
                        {s.problems[0]}
                      </span>
                    )}
                  </span>
                </button>
                {canChange && seq.steps.length > 1 && (
                  <span className="flex shrink-0 flex-col">
                    <IconButton size="sm" label="Move up" icon={<ArrowUp />} disabled={i === 0 || reorder.isPending} onClick={() => move(i, -1)} />
                    <IconButton size="sm" label="Move down" icon={<ArrowDown />} disabled={i === seq.steps.length - 1 || reorder.isPending} onClick={() => move(i, 1)} />
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

function Editor({ seq }: { seq: SequenceDetail }) {
  const router = useRouter();
  const f = useFormat();
  const { canChange } = usePlatform();
  const [selected, setSelected] = useState<string | null>(seq.steps[0]?.id ?? null);
  const [name, setName] = useState(seq.name);
  const [confirmOn, setConfirmOn] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const stats = useApiQuery<SequenceStats>(platformKey("growth", "sequences", seq.id, "stats"), `/admin/growth/sequences/${seq.id}/stats`, { refetchInterval: seq.active ? 30_000 : false });
  useEffect(() => setName(seq.name), [seq.name]);
  useEffect(() => {
    if (!seq.steps.some((s) => s.id === selected)) setSelected(seq.steps[0]?.id ?? null);
  }, [seq.steps, selected]);

  const update = useApiMutation<SequenceDetail, { name?: string; trigger?: PlatformDripTrigger }>({
    method: "PATCH",
    path: `/admin/growth/sequences/${seq.id}`,
    invalidate: [platformKey("growth", "sequences")],
    success: "Saved",
  });
  const toggle = useApiMutation<SequenceDetail, boolean>({
    path: (on) => `/admin/growth/sequences/${seq.id}/${on ? "activate" : "deactivate"}`,
    body: () => ({}),
    invalidate: [platformKey("growth", "sequences")],
    success: (d) => (d.active ? "Sequence is on" : "Sequence paused"),
  });
  const remove = useApiMutation<unknown, void>({
    method: "DELETE",
    path: `/admin/growth/sequences/${seq.id}`,
    invalidate: [platformKey("growth", "sequences")],
    success: "Sequence deleted",
    errorToast: false,
    onSuccess: () => router.push("/growth/sequences"),
  });
  const step = useMemo(() => seq.steps.find((s) => s.id === selected) ?? null, [seq.steps, selected]);
  const problems = seq.steps.filter((s) => s.problems.length > 0);

  return (
    <>
      <PageHeader
        back={{ href: "/growth/sequences", label: "Onboarding sequences" }}
        icon={<GrowthTile of="sequences" />}
        title={seq.name}
        meta={
          seq.active ? (
            <Badge tone="live" dot>
              Active
            </Badge>
          ) : (
            <Badge tone="mute">Off</Badge>
          )
        }
        description={seq.active && seq.activatedAt ? `Enrolling people whose trigger happened after ${f.dateTime(seq.activatedAt)}.` : "Off: nobody is enrolled and nothing is sent."}
        actions={
          canChange && (
            <>
              {!seq.active && <IconButton label="Delete sequence" icon={<Trash2 />} onClick={() => setDeleting(true)} />}
              <div className="flex items-center gap-2 rounded-lg border border-line bg-panel px-3 py-1.5">
                <Switch
                  checked={seq.active}
                  disabled={toggle.isPending}
                  onCheckedChange={(on) => (on ? setConfirmOn(true) : toggle.mutate(false))}
                  label={<span className="font-medium">{seq.active ? "On" : "Off"}</span>}
                />
              </div>
            </>
          )
        }
      />
      <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <Card>
          <CardHeader title="Sequence" />
          <CardBody className="flex flex-col gap-3">
            <Field label="Name">
              <div className="flex gap-2">
                <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={160} disabled={!canChange} />
                {canChange && name.trim() && name !== seq.name && (
                  <Button loading={update.isPending} onClick={() => update.mutate({ name })}>
                    Save
                  </Button>
                )}
              </div>
            </Field>
            <Field label="Starts when" hint={seq.active ? "Switch the sequence off to change its trigger." : PLATFORM_DRIP_TRIGGER_LABELS[seq.trigger].description}>
              <NativeSelect
                value={seq.trigger}
                disabled={!canChange || seq.active || update.isPending}
                onChange={(e) => update.mutate({ trigger: e.target.value as PlatformDripTrigger })}
                options={PLATFORM_DRIP_TRIGGERS.map((t) => ({ value: t, label: PLATFORM_DRIP_TRIGGER_LABELS[t].label }))}
              />
            </Field>
          </CardBody>
        </Card>
        <div className="grid grid-cols-3 gap-3 self-start">
          <StatCard label="In progress" value={formatNumber(seq.enrollments.active)} hint="Waiting for a step" />
          <StatCard label="Completed" value={formatNumber(seq.enrollments.completed)} tone={seq.enrollments.completed ? "ok" : undefined} />
          <StatCard label="Stopped" value={formatNumber(seq.enrollments.stopped)} hint="Opted out on the way" />
        </div>
      </div>
      {problems.length > 0 && (
        <Callout tone="warn" className="mb-4" title="Some steps are not ready to send">
          {problems.map((s) => `Step ${s.position}: ${s.problems[0]}`).join(" ")}
        </Callout>
      )}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <div className="min-w-0 xl:sticky xl:top-4 xl:self-start">
          <Timeline seq={seq} stats={stats.data} selected={selected} onSelect={setSelected} />
        </div>
        <div className="min-w-0">{step ? <StepEditor key={step.id} seq={seq} step={step} onDeleted={() => setSelected(null)} /> : <Card className="p-8 text-center text-sm text-text-3">Add a step to start.</Card>}</div>
      </div>
      <ConfirmDialog
        open={confirmOn}
        onOpenChange={setConfirmOn}
        tone="default"
        title="Switch this sequence on?"
        description={`From now on, everyone who opted in to product emails is enrolled when “${PLATFORM_DRIP_TRIGGER_LABELS[seq.trigger].label.toLowerCase()}” happens to them. People whose trigger happened before now are not enrolled.`}
        confirmLabel="Switch on"
        onConfirm={() => toggle.mutateAsync(true)}
      />
      <ConfirmDialog open={deleting} onOpenChange={setDeleting} title={`Delete “${seq.name}”?`} description="Its steps and enrollments are deleted. Emails already sent stay in the delivery log." onConfirm={() => remove.mutateAsync()} />
    </>
  );
}

/** /growth/sequences/[id] */
export function SequenceEditor() {
  const { id } = useParams<{ id: string }>();
  const detail = useApiQuery<SequenceDetail>(platformKey("growth", "sequences", id), `/admin/growth/sequences/${id}`);
  return (
    <Page>
      <QueryState query={detail} loading={<SkeletonText lines={12} />}>
        {(s) => <Editor key={s.id} seq={s} />}
      </QueryState>
    </Page>
  );
}
