"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { CalendarClock, Ban, MailCheck, Save, Send, Trash2, Undo2, Users } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button, IconButton } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { ConfirmDialog, Modal } from "@/components/ui/Dialog";
import { QueryState } from "@/components/ui/ErrorState";
import { Field, FormError } from "@/components/ui/Field";
import { Input, NativeSelect } from "@/components/ui/Input";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { SkeletonText } from "@/components/ui/Skeleton";
import { StatCard } from "@/components/ui/StatCard";
import { cn } from "@/lib/cn";
import { formatNumber, utcToZonedInput, zoneAbbreviation, zonedInputToUtc } from "@/lib/format";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useFormat } from "@/lib/session";
import { platformKey, usePlatform } from "@/features/common/platform";
import { SendResultView } from "@/features/email/EmailSettings";
import { BroadcastStatusBadge, ContentEditor, FunnelBars, GrowthTile, ProblemList, ProgressBar } from "./common";
import type { Audience, BroadcastDetail, BroadcastStats, MarketingContent, TestSendResult } from "./types";

/*
 * /growth/broadcasts/[id] — a draft is edited here (name, audience, content
 * with a live preview), tested to yourself, then sent now or scheduled in your
 * own time zone after a confirmation that shows how many people it reaches.
 * Once scheduled the content is locked: pull it back to draft to change it.
 * While sending and after, the page shows progress and the delivery funnel.
 */

type Draft = MarketingContent & { name: string; audienceId: string };

const draftOf = (b: BroadcastDetail): Draft => ({ name: b.name, audienceId: b.audience?.id ?? "", subject: b.subject, preheader: b.preheader, blocks: b.blocks });
const same = (a: Draft, b: Draft) => JSON.stringify(a) === JSON.stringify(b);

function useUnsavedGuard(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);
}

function ScheduleDialog({
  b,
  open,
  onOpenChange,
  onDone,
  beforeSchedule,
}: {
  b: BroadcastDetail;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onDone: () => void;
  beforeSchedule: () => Promise<unknown>;
}) {
  const f = useFormat();
  const [mode, setMode] = useState<"now" | "later">("later");
  const [at, setAt] = useState(() => utcToZonedInput(new Date(Date.now() + 60 * 60_000).setMinutes(0, 0, 0), f.timeZone));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const schedule = useApiMutation<BroadcastDetail, { at?: string; now?: boolean }>({
    path: `/admin/growth/broadcasts/${b.id}/schedule`,
    invalidate: [platformKey("growth")],
    success: (d) => (d.status === "scheduled" && d.scheduledAt && new Date(d.scheduledAt).getTime() > Date.now() + 60_000 ? `Scheduled for ${f.dateTime(d.scheduledAt)}` : "Sending now"),
    errorToast: false,
  });
  const iso = mode === "later" ? zonedInputToUtc(at, f.timeZone) : null;
  const tooSoon = mode === "later" && (!iso || new Date(iso).getTime() < Date.now() + 60_000);
  const count = b.audience?.count ?? 0;

  async function confirm() {
    setPending(true);
    setError(null);
    try {
      await beforeSchedule();
      await schedule.mutateAsync(mode === "now" ? { now: true } : { at: iso! });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      icon={<GrowthTile of="broadcasts" size="md" />}
      title="Send this broadcast"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" icon={mode === "now" ? <Send /> : <CalendarClock />} loading={pending} disabled={tooSoon || count === 0 || b.problems.length > 0} onClick={confirm}>
            {mode === "now" ? `Send to ${formatNumber(count)} now` : "Schedule"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="rounded-xl border border-line bg-well p-4">
          <div className="flex items-center gap-2 text-xs font-medium text-text-3">
            <Users aria-hidden className="size-3.5" />
            {b.audience?.name ?? "No audience"}
          </div>
          <div className="mt-1 text-3xl font-semibold tracking-[-0.02em] text-text-hi tabular-nums">{formatNumber(count)}</div>
          <div className="text-xs text-text-3">people right now. The list is taken when sending starts, and consent is checked again for each email as it goes out.</div>
        </div>
        {b.problems.length > 0 && <ProblemList problems={b.problems} className="rounded-lg" />}
        <div role="radiogroup" aria-label="When" className="grid grid-cols-2 gap-2">
          {(["later", "now"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              onClick={() => setMode(m)}
              className={cn(
                "rounded-lg border px-3 py-2.5 text-left text-sm transition-colors",
                mode === m ? "border-accent/60 bg-accent/10 text-text-hi" : "border-line bg-panel text-text-2 hover:bg-hover",
              )}
            >
              <div className="font-medium">{m === "later" ? "Schedule" : "Send now"}</div>
              <div className="text-xs text-text-3">{m === "later" ? "Pick a date and time" : "Starts within a minute"}</div>
            </button>
          ))}
        </div>
        {mode === "later" && (
          <Field label={`Date and time (${zoneAbbreviation(f.timeZone)}, your time zone)`} error={tooSoon ? "Choose a time at least a minute from now." : undefined}>
            <Input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
          </Field>
        )}
        <FormError error={error} />
      </div>
    </Modal>
  );
}

function Stats({ b }: { b: BroadcastDetail }) {
  const live = b.status === "sending";
  const stats = useApiQuery<BroadcastStats>(platformKey("growth", "broadcasts", b.id, "stats"), `/admin/growth/broadcasts/${b.id}/stats`, { refetchInterval: live ? 4_000 : false });
  return (
    <QueryState query={stats} loading={<SkeletonText lines={5} />}>
      {(s) => (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <div className="grid grid-cols-2 gap-3">
            <StatCard label="Recipients" value={formatNumber(s.recipients.total)} />
            <StatCard label="Sent" value={formatNumber(s.recipients.sent)} tone={s.recipients.sent ? "ok" : undefined} />
            <StatCard label="Skipped" value={formatNumber(s.recipients.skipped)} hint="Opted out before their email went" />
            <StatCard label={s.recipients.canceled ? "Canceled" : "Failed"} value={formatNumber(s.recipients.canceled || s.recipients.failed)} tone={s.recipients.failed ? "bad" : undefined} />
            <div className="col-span-2">
              <ProgressBar progress={s.recipients} />
              {live && <p className="mt-1.5 text-xs text-text-3">{formatNumber(s.recipients.pending)} still to send…</p>}
            </div>
          </div>
          <Card>
            <CardHeader icon={<MailCheck />} title="Delivery" description="From the delivery log; opens and clicks arrive through Resend webhooks." />
            <CardBody>
              <FunnelBars email={s.email} unsubscribes={s.unsubscribes} />
            </CardBody>
          </Card>
        </div>
      )}
    </QueryState>
  );
}

function Editor({ b }: { b: BroadcastDetail }) {
  const router = useRouter();
  const f = useFormat();
  const { canChange } = usePlatform();
  const editable = canChange && b.status === "draft";
  const [base, setBase] = useState<Draft>(() => draftOf(b));
  const [draft, setDraft] = useState<Draft>(() => draftOf(b));
  const [scheduling, setScheduling] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [testResult, setTestResult] = useState<TestSendResult | null>(null);
  const audiences = useApiQuery<Audience[]>(platformKey("growth", "audiences"), "/admin/growth/audiences", { enabled: editable });

  // Follow the server after a status change, unless there are unsaved edits.
  const server = useRef(draftOf(b));
  useEffect(() => {
    const next = draftOf(b);
    const prev = server.current;
    if (same(next, prev)) return;
    server.current = next;
    setBase(next);
    setDraft((d) => (same(d, prev) ? next : d));
  }, [b]);

  const dirty = editable && !same(draft, base);
  useUnsavedGuard(dirty);

  const save = useApiMutation<BroadcastDetail, void>({
    method: "PATCH",
    path: `/admin/growth/broadcasts/${b.id}`,
    body: () => ({ name: draft.name, audienceId: draft.audienceId || null, subject: draft.subject, preheader: draft.preheader, blocks: draft.blocks }),
    invalidate: [platformKey("growth")],
    success: "Draft saved",
  });
  const saveIfDirty = () => (dirty ? save.mutateAsync() : Promise.resolve());
  const test = useApiMutation<TestSendResult, void>({
    path: `/admin/growth/broadcasts/${b.id}/test`,
    body: () => ({}),
    invalidate: [platformKey("email-log")],
    onSuccess: (r) => setTestResult(r),
  });
  const cancel = useApiMutation<BroadcastDetail, void>({
    path: `/admin/growth/broadcasts/${b.id}/cancel`,
    body: () => ({}),
    invalidate: [platformKey("growth")],
    success: (d) => (d.status === "draft" ? "Back to draft — nothing was sent" : "Sending stopped"),
    errorToast: false,
  });
  const remove = useApiMutation<unknown, void>({
    method: "DELETE",
    path: `/admin/growth/broadcasts/${b.id}`,
    invalidate: [platformKey("growth", "broadcasts")],
    success: "Broadcast deleted",
    errorToast: false,
    onSuccess: () => router.push("/growth/broadcasts"),
  });

  const selectedAudience = audiences.data?.find((a) => a.id === draft.audienceId);
  const showStats = b.status === "sending" || b.status === "sent" || b.status === "canceled" || (b.status === "failed" && b.progress.total > 0);

  return (
    <>
      <PageHeader
        back={{ href: "/growth/broadcasts", label: "Broadcasts" }}
        icon={<GrowthTile of="broadcasts" />}
        title={b.name}
        meta={
          <span className="flex flex-wrap items-center gap-2">
            <BroadcastStatusBadge status={b.status} />
            {dirty && (
              <Badge tone="warn" dot>
                Unsaved changes
              </Badge>
            )}
          </span>
        }
        description={
          b.status === "scheduled" && b.scheduledAt
            ? `Goes out ${f.dateTime(b.scheduledAt)} to ${b.audience?.name ?? "its audience"}.`
            : b.status === "sending"
              ? `Sending since ${f.dateTime(b.startedAt)}.`
              : b.finishedAt
                ? `Finished ${f.dateTime(b.finishedAt)}.`
                : undefined
        }
        actions={
          canChange && (
            <>
              {(b.status === "draft" || b.status === "canceled" || b.status === "failed") && <IconButton label="Delete broadcast" icon={<Trash2 />} onClick={() => setDeleting(true)} />}
              {b.status === "draft" && (
                <>
                  {dirty && (
                    <Button icon={<Save />} loading={save.isPending} onClick={() => save.mutate()}>
                      Save
                    </Button>
                  )}
                  <Button icon={<Send />} loading={test.isPending} onClick={() => void saveIfDirty().then(() => test.mutate())}>
                    Send test to me
                  </Button>
                  <Button variant="primary" icon={<CalendarClock />} onClick={() => setScheduling(true)} disabled={!draft.audienceId}>
                    Schedule…
                  </Button>
                </>
              )}
              {b.status === "scheduled" && (
                <Button icon={<Undo2 />} loading={cancel.isPending} onClick={() => cancel.mutate()}>
                  Back to draft
                </Button>
              )}
              {b.status === "sending" && (
                <Button variant="danger" icon={<Ban />} onClick={() => setCanceling(true)}>
                  Cancel sending
                </Button>
              )}
            </>
          )
        }
      />
      {b.error && (
        <Callout tone="bad" className="mb-4">
          {b.error}
        </Callout>
      )}
      {b.status === "scheduled" && (
        <Callout tone="info" className="mb-4">
          The content is locked while scheduled. Put it back to draft to change anything — nothing has been sent yet.
        </Callout>
      )}
      {!canChange && (
        <Callout tone="info" className="mb-4">
          Platform support can view broadcasts and their stats; an admin or owner edits and sends them.
        </Callout>
      )}
      {showStats && (
        <div className="mb-6">
          <Stats b={b} />
        </div>
      )}
      <ContentEditor
        value={draft}
        onChange={(c) => setDraft({ ...draft, ...c })}
        disabled={!editable}
        aside={
          <Card>
            <CardHeader icon={<Users />} title="Settings" />
            <CardBody className="flex flex-col gap-3">
              <Field label="Name" hint="Internal; recipients never see it.">
                <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} maxLength={160} disabled={!editable} />
              </Field>
              <Field
                label="Audience"
                hint={
                  editable
                    ? selectedAudience
                      ? `${formatNumber(selectedAudience.count)} people can receive it right now.`
                      : "Choose who receives it."
                    : b.audience
                      ? `${b.audience.name}${b.audience.count !== null ? ` · ${formatNumber(b.audience.count)} people now` : ""}`
                      : undefined
                }
              >
                <NativeSelect
                  value={draft.audienceId}
                  onChange={(e) => setDraft({ ...draft, audienceId: e.target.value })}
                  disabled={!editable}
                  placeholder="No audience"
                  options={
                    editable
                      ? (audiences.data ?? []).map((a) => ({ value: a.id, label: `${a.name} · ${formatNumber(a.count)}` }))
                      : b.audience
                        ? [{ value: b.audience.id, label: b.audience.name }]
                        : []
                  }
                />
              </Field>
              {editable && !audiences.isPending && !audiences.data?.length && (
                <Callout tone="info">
                  No audiences yet —{" "}
                  <a href="/growth/audiences" className="underline">
                    create one
                  </a>{" "}
                  first.
                </Callout>
              )}
            </CardBody>
          </Card>
        }
      />
      {scheduling && (
        <ScheduleDialog
          b={b}
          open
          onOpenChange={(v) => !v && setScheduling(false)}
          beforeSchedule={saveIfDirty}
          onDone={() => setScheduling(false)}
        />
      )}
      <ConfirmDialog
        open={canceling}
        onOpenChange={setCanceling}
        title="Stop sending?"
        description={`Emails already sent stay sent. The ${formatNumber(b.progress.pending)} people not reached yet will not get it, and this broadcast cannot be resumed.`}
        confirmLabel="Stop sending"
        onConfirm={() => cancel.mutateAsync()}
      />
      <ConfirmDialog open={deleting} onOpenChange={setDeleting} title={`Delete “${b.name}”?`} description="This cannot be undone." onConfirm={() => remove.mutateAsync()} />
      <Modal open={testResult !== null} onOpenChange={(v) => !v && setTestResult(null)} title="Test email" footer={<Button onClick={() => setTestResult(null)}>Close</Button>}>
        {testResult && <SendResultView r={testResult} />}
      </Modal>
    </>
  );
}

/** /growth/broadcasts/[id] */
export function BroadcastEditor() {
  const { id } = useParams<{ id: string }>();
  const [poll, setPoll] = useState(false);
  const detail = useApiQuery<BroadcastDetail>(platformKey("growth", "broadcasts", id), `/admin/growth/broadcasts/${id}`, { refetchInterval: poll ? 4_000 : false });
  useEffect(() => setPoll(detail.data?.status === "sending" || detail.data?.status === "scheduled"), [detail.data?.status]);
  return (
    <Page>
      <QueryState query={detail} loading={<SkeletonText lines={12} />}>
        {(b) => <Editor key={b.id} b={b} />}
      </QueryState>
    </Page>
  );
}
