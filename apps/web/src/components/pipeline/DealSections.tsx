"use client";

import Link from "next/link";
import { useMemo, useState, type FormEvent } from "react";
import { Activity, ArrowRightLeft, CalendarDays, CheckSquare, CircleDot, ClipboardList, Ellipsis, Handshake, History, Info, ListChecks, Milestone, Pin, PinOff, Plus, StickyNote, Trash2, Trophy, XCircle, type LucideIcon } from "lucide-react";
import { labelOf } from "@growthdesk/shared";
import { CompanyPicker, ContactPicker, MemberPicker } from "@/components/pickers/Pickers";
import { Badge } from "@/components/ui/Badge";
import { Button, IconButton } from "@/components/ui/Button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/Card";
import { Checkbox } from "@/components/ui/Checkbox";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/DropdownMenu";
import { QueryState } from "@/components/ui/ErrorState";
import { Field, FormError } from "@/components/ui/Field";
import { Input, NativeSelect, Textarea } from "@/components/ui/Input";
import { KeyValueList } from "@/components/ui/KeyValue";
import { SkeletonText } from "@/components/ui/Skeleton";
import { cn } from "@/lib/cn";
import { currencies } from "@/lib/format";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import type { DealDetail, Note, Pipeline, PipelineStage, TimelineEntry } from "@/lib/types/pipeline";
import { StageDot } from "./StageDot";
import { calendarDateInput, fieldErrors, formatCalendarDate, formLevelError, parseAmount } from "./utils";

// ─── Stage ───────────────────────────────────────────────────────────────────

/**
 * Where the deal stands: the pipeline's stages as a row of steps (click one to
 * move there), plus Mark won / Mark lost. Closing asks for a reason first —
 * `onClose` opens that dialog.
 */
export function StagePanel({
  deal,
  pipeline,
  canWrite,
  pending,
  onMove,
  onClose,
}: {
  deal: DealDetail;
  pipeline: Pipeline | undefined;
  canWrite: boolean;
  pending: boolean;
  onMove: (stage: PipelineStage) => void;
  onClose: (stage: PipelineStage) => void;
}) {
  const f = useFormat();
  const stages = pipeline?.stages ?? [];
  const open = stages.filter((s) => s.kind === "open");
  const won = stages.find((s) => s.kind === "won");
  const lost = stages.find((s) => s.kind === "lost");
  const currentPos = deal.stage.position;
  const reason = deal.status === "won" ? deal.wonReason : deal.status === "lost" ? deal.lostReason : "";

  return (
    <Card>
      <CardHeader
        icon={<Milestone />}
        title="Stage"
        description={pipeline ? pipeline.name : undefined}
        actions={
          canWrite && deal.status === "open" ? (
            <>
              {won && (
                <Button size="sm" variant="tinted" icon={<Trophy />} disabled={pending} onClick={() => onClose(won)}>
                  Mark won
                </Button>
              )}
              {lost && (
                <Button size="sm" variant="ghost" icon={<XCircle />} disabled={pending} onClick={() => onClose(lost)}>
                  Mark lost
                </Button>
              )}
            </>
          ) : undefined
        }
      />
      <CardBody className="flex flex-col gap-3">
        {open.length > 0 && (
          <ol className="flex flex-wrap gap-1" aria-label="Open stages">
            {open.map((s) => {
              const current = s.id === deal.stage.id;
              const passed = deal.status === "open" && s.position < currentPos;
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    disabled={!canWrite || current || pending}
                    aria-current={current ? "step" : undefined}
                    onClick={() => onMove(s)}
                    title={canWrite && !current ? `Move to ${s.name}` : s.name}
                    className={cn(
                      "inline-flex h-7 items-center gap-1.5 rounded-xs border px-2 text-xs font-medium transition-colors disabled:cursor-default",
                      current
                        ? "border-solid-line bg-solid text-on-solid"
                        : passed
                          ? "border-transparent bg-s-4 text-text-2 enabled:hover:bg-s-5"
                          : "border-line-strong bg-ctl-face text-text-3 enabled:hover:bg-ctl-hover enabled:hover:text-text",
                    )}
                  >
                    {current && <StageDot stage={s} className="size-1.5" />}
                    {s.name}
                  </button>
                </li>
              );
            })}
          </ol>
        )}
        {deal.status !== "open" ? (
          <div className="flex flex-col gap-1 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={deal.status === "won" ? "ok" : "bad"} dot>
                {labelOf(deal.status)}
              </Badge>
              <span className="text-text-2">
                {deal.stage.name}
                {deal.closedAt && ` · ${f.date(deal.closedAt)}`}
              </span>
            </div>
            {reason && <p className="text-xs whitespace-pre-wrap text-text-2">{reason}</p>}
            {canWrite && open.length > 0 && <p className="text-xs text-text-3">Pick an open stage above to reopen it.</p>}
          </div>
        ) : (
          <p className="text-xs text-text-3">
            In {deal.stage.name} since {f.date(deal.stageEnteredAt)} · {deal.stage.probability}% probability
          </p>
        )}
        {deal.status === "open" && <StageGuidance stageName={deal.stage.name} guidance={stages.find((s) => s.id === deal.stage.id)?.guidance ?? ""} />}
      </CardBody>
    </Card>
  );
}

/** The stage's guidance (Settings → Pipelines) as a short checklist-style note: one point per line. */
export function StageGuidance({ stageName, guidance }: { stageName: string; guidance: string }) {
  const points = guidance
    .split("\n")
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter(Boolean);
  if (!points.length) return null;
  return (
    <div className="rounded-md border border-line bg-well px-3 py-2">
      <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-text-2">
        <ListChecks aria-hidden className="size-3.5 text-text-3" />
        In {stageName}
      </div>
      <ul className="flex flex-col gap-0.5 text-xs text-text-2">
        {points.map((p, i) => (
          <li key={i} className="flex gap-1.5">
            <span aria-hidden className="mt-1.5 size-1 shrink-0 rounded-full bg-text-3" />
            <span className="min-w-0 break-words">{p}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── Details ─────────────────────────────────────────────────────────────────

const DETAIL_FIELDS = ["name", "value", "currency", "expectedCloseDate", "contactId", "companyId", "ownerId", "proposalUrl", "description"] as const;

const toForm = (deal: DealDetail) => ({
  name: deal.name,
  value: String(deal.value),
  currency: deal.currency,
  expectedCloseDate: calendarDateInput(deal.expectedCloseDate),
  contactId: deal.contact?.id ?? null,
  companyId: deal.company?.id ?? null,
  ownerId: deal.owner?.id ?? null,
  proposalUrl: deal.proposalUrl,
  description: deal.description,
});

/** The deal's fields, edited in place (PATCH /deals/:id). Key it by the deal id. */
export function DealDetailsForm({ deal, canWrite }: { deal: DealDetail; canWrite: boolean }) {
  const ws = useWorkspace();
  const currencyOptions = useMemo(() => currencies().map((c) => ({ value: c.code, label: c.label })), []);
  const initial = toForm(deal);
  const [v, setV] = useState(initial);
  const [labels, setLabels] = useState({ contact: deal.contact?.fullName || deal.contact?.email || null, company: deal.company?.name ?? null, owner: deal.owner?.name ?? null });
  const set = <K extends keyof typeof initial>(k: K, value: (typeof initial)[K]) => setV((s) => ({ ...s, [k]: value }));
  const dirty = JSON.stringify(v) !== JSON.stringify(initial);

  const save = useApiMutation<DealDetail, Record<string, unknown>>({
    method: "PATCH",
    path: ws.path(`/deals/${deal.id}`),
    invalidate: [ws.key("deals")],
    success: "Deal saved",
    errorToast: false,
    // Take the server's version (e.g. "10.50" comes back as 10.5) so the form is clean again.
    onSuccess: (d) => setV(toForm(d)),
  });
  const errors = fieldErrors(save.error);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({
      name: v.name,
      value: parseAmount(v.value) ?? 0,
      currency: v.currency,
      // A calendar date ("2026-10-09"), stored by the API as UTC midnight.
      expectedCloseDate: v.expectedCloseDate || null,
      contactId: v.contactId,
      companyId: v.companyId,
      ownerId: v.ownerId,
      proposalUrl: v.proposalUrl,
      description: v.description,
    });
  };

  return (
    <Card>
      <CardHeader icon={<ClipboardList />} title="Details" />
      <form onSubmit={submit}>
        <CardBody className="flex flex-col gap-4">
          <FormError error={formLevelError(save.error, DETAIL_FIELDS)} />
          <Field label="Name" required error={errors.name}>
            <Input value={v.name} onChange={(e) => set("name", e.target.value)} maxLength={200} disabled={!canWrite} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Value" error={errors.value}>
              <Input type="number" inputMode="decimal" min={0} step="0.01" value={v.value} onChange={(e) => set("value", e.target.value)} disabled={!canWrite} />
            </Field>
            <Field label="Currency" error={errors.currency}>
              <NativeSelect value={v.currency} onChange={(e) => set("currency", e.target.value)} options={currencyOptions} disabled={!canWrite} />
            </Field>
            <Field label="Contact" error={errors.contactId}>
              <ContactPicker
                value={v.contactId}
                valueLabel={labels.contact}
                disabled={!canWrite}
                onChange={(id, c) => {
                  set("contactId", id);
                  setLabels((l) => ({ ...l, contact: c ? c.fullName || c.email : null }));
                }}
              />
            </Field>
            <Field label="Company" error={errors.companyId}>
              <CompanyPicker
                value={v.companyId}
                valueLabel={labels.company}
                disabled={!canWrite}
                onChange={(id, c) => {
                  set("companyId", id);
                  setLabels((l) => ({ ...l, company: c?.name ?? null }));
                }}
              />
            </Field>
            <Field label="Owner" error={errors.ownerId}>
              <MemberPicker
                value={v.ownerId}
                valueLabel={labels.owner}
                disabled={!canWrite}
                placeholder="No owner"
                onChange={(id, m) => {
                  set("ownerId", id);
                  setLabels((l) => ({ ...l, owner: m ? m.name || m.email : null }));
                }}
              />
            </Field>
            <Field label="Expected close" error={errors.expectedCloseDate}>
              <Input type="date" value={v.expectedCloseDate} onChange={(e) => set("expectedCloseDate", e.target.value)} disabled={!canWrite} />
            </Field>
          </div>
          <Field label="Proposal link" error={errors.proposalUrl}>
            <Input type="url" value={v.proposalUrl} onChange={(e) => set("proposalUrl", e.target.value)} maxLength={1000} placeholder="https://" disabled={!canWrite} />
          </Field>
          <Field label="Description" error={errors.description}>
            <Textarea value={v.description} onChange={(e) => set("description", e.target.value)} rows={4} maxLength={5000} disabled={!canWrite} />
          </Field>
        </CardBody>
        {canWrite && (
          <CardFooter>
            {dirty && (
              <Button
                onClick={() => {
                  setV(initial);
                  save.reset();
                }}
              >
                Discard
              </Button>
            )}
            <Button variant="primary" type="submit" disabled={!dirty} loading={save.isPending}>
              Save changes
            </Button>
          </CardFooter>
        )}
      </form>
    </Card>
  );
}

/** Read-only facts the form does not edit. */
export function DealFacts({ deal }: { deal: DealDetail }) {
  const ws = useWorkspace();
  const f = useFormat();
  return (
    <Card>
      <CardHeader icon={<Info />} title="Record" />
      <CardBody>
        <KeyValueList
          items={[
            {
              label: "Contact",
              value: deal.contact && (
                <Link href={ws.href(`/contacts/${deal.contact.id}`)} className="text-accent-hi hover:text-accent">
                  {deal.contact.fullName || deal.contact.email || "Unnamed contact"}
                </Link>
              ),
            },
            {
              label: "Company",
              value: deal.company && (
                <Link href={ws.href(`/companies/${deal.company.id}`)} className="text-accent-hi hover:text-accent">
                  {deal.company.name}
                </Link>
              ),
            },
            { label: "Expected close", value: deal.expectedCloseDate && formatCalendarDate(deal.expectedCloseDate) },
            {
              label: "Proposal",
              value: deal.proposalUrl && /^https?:\/\//i.test(deal.proposalUrl) && (
                <a href={deal.proposalUrl} target="_blank" rel="noreferrer noopener" className="break-all text-accent-hi hover:text-accent">
                  {deal.proposalUrl}
                </a>
              ),
            },
            {
              label: "Source campaign",
              value: deal.sourceCampaign && (
                <Link href={ws.href(`/campaigns/${deal.sourceCampaign.id}`)} className="text-accent-hi hover:text-accent">
                  {deal.sourceCampaign.name}
                </Link>
              ),
            },
            { label: "Created", value: f.dateTime(deal.createdAt) },
            { label: "Updated", value: f.relative(deal.updatedAt) },
          ]}
        />
      </CardBody>
    </Card>
  );
}

// ─── Notes ───────────────────────────────────────────────────────────────────

/** Add, pin and delete notes (POST /deals/:id/notes; PATCH/DELETE /notes/:id). */
export function DealNotes({ deal, canWrite }: { deal: DealDetail; canWrite: boolean }) {
  const ws = useWorkspace();
  const f = useFormat();
  const [body, setBody] = useState("");
  const [pinned, setPinned] = useState(false);
  const [deleting, setDeleting] = useState<Note | null>(null);

  const add = useApiMutation<Note, { body: string; pinned: boolean }>({
    path: ws.path(`/deals/${deal.id}/notes`),
    invalidate: [ws.key("deals", deal.id)],
    success: "Note added",
    errorToast: false,
    onSuccess: () => {
      setBody("");
      setPinned(false);
    },
  });
  const pin = useApiMutation<unknown, { id: string; pinned: boolean }>({
    method: "PATCH",
    path: (n) => ws.path(`/notes/${n.id}`),
    body: (n) => ({ pinned: n.pinned }),
    invalidate: [ws.key("deals", deal.id)],
    success: (_, n) => (n.pinned ? "Note pinned" : "Note unpinned"),
  });
  const remove = useApiMutation<unknown, string>({
    method: "DELETE",
    path: (id) => ws.path(`/notes/${id}`),
    invalidate: [ws.key("deals", deal.id)],
    success: "Note deleted",
    errorToast: false,
  });

  return (
    <Card>
      <CardHeader icon={<StickyNote />} title="Notes" description={deal.notes.length ? `${deal.notes.length} note${deal.notes.length === 1 ? "" : "s"}` : undefined} />
      {canWrite && (
        <form
          className="flex flex-col gap-2 border-b border-line p-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (body.trim()) add.mutate({ body, pinned });
          }}
        >
          <Field error={fieldErrors(add.error).body ?? formLevelError(add.error, ["body"])}>
            <Textarea aria-label="New note" value={body} onChange={(e) => setBody(e.target.value)} rows={3} maxLength={10000} placeholder="Write a note…" />
          </Field>
          <div className="flex items-center justify-between gap-2">
            <Checkbox checked={pinned} onCheckedChange={setPinned} label="Pin to top" />
            <Button size="sm" variant="primary" type="submit" icon={<Plus />} disabled={!body.trim()} loading={add.isPending}>
              Add note
            </Button>
          </div>
        </form>
      )}
      {deal.notes.length === 0 ? (
        <p className="flex items-center justify-center gap-2 px-4 py-6 text-xs text-text-3">
          <StickyNote aria-hidden className="size-3.5" />
          No notes yet.
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {deal.notes.map((n) => (
            <li key={n.id} className="flex items-start gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm break-words whitespace-pre-wrap text-text">{n.body}</p>
                <p className="mt-1 flex items-center gap-2 text-xs text-text-3">
                  {n.pinned && (
                    <Badge tone="info" quiet>
                      Pinned
                    </Badge>
                  )}
                  <span title={f.dateTime(n.createdAt)}>{f.relative(n.createdAt)}</span>
                </p>
              </div>
              {canWrite && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <IconButton size="sm" label="Note actions" icon={<Ellipsis />} />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem icon={n.pinned ? <PinOff /> : <Pin />} onSelect={() => pin.mutate({ id: n.id, pinned: !n.pinned })}>
                      {n.pinned ? "Unpin" : "Pin to top"}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem danger icon={<Trash2 />} onSelect={() => setDeleting(n)}>
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete this note?"
        description="The note is removed from the deal. This cannot be undone."
        onConfirm={() => (deleting ? remove.mutateAsync(deleting.id) : undefined)}
      />
    </Card>
  );
}

// ─── Timeline ────────────────────────────────────────────────────────────────

/** Everything logged against the deal (GET /deals/:id/timeline), newest first. */
export function DealTimeline({ dealId }: { dealId: string }) {
  const ws = useWorkspace();
  const f = useFormat();
  const timeline = useApiQuery<TimelineEntry[]>(ws.key("deals", dealId, "timeline"), ws.path(`/deals/${dealId}/timeline`));
  return (
    <Card>
      <CardHeader icon={<Activity />} title="Timeline" description="The latest 200 events." />
      <QueryState
        query={timeline}
        loading={<SkeletonText lines={4} className="p-4" />}
        isEmpty={(d) => d.length === 0}
        empty={
          <p className="flex items-center justify-center gap-2 px-4 py-6 text-xs text-text-3">
            <History aria-hidden className="size-3.5" />
            Nothing has happened on this deal yet.
          </p>
        }
      >
        {(rows) => (
          <ol className="relative px-4 py-3">
            {rows.map((r) => (
              <li key={r.id} className="relative flex gap-3 pb-4 last:pb-0">
                <TimelineGlyph type={r.type} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm break-words text-text">{r.summary}</p>
                  <p className="mt-0.5 text-xs text-text-3">
                    {timelineLabel(r.type)}
                    {r.actor?.name && ` · ${r.actor.name}`} · <span title={f.dateTime(r.occurredAt)}>{f.relative(r.occurredAt)}</span>
                  </p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </QueryState>
    </Card>
  );
}

const TIMELINE_GLYPHS: Record<string, LucideIcon> = {
  "deal.created": Handshake,
  "deal.stage_changed": ArrowRightLeft,
  "deal.won": Trophy,
  "deal.lost": XCircle,
  "note.added": StickyNote,
  "task.created": CheckSquare,
  "task.completed": CheckSquare,
  "meeting.booked": CalendarDays,
};

/** The event's glyph in a small grey circle, down the timeline's left edge. */
function TimelineGlyph({ type }: { type: string }) {
  const Icon = TIMELINE_GLYPHS[type] ?? CircleDot;
  return (
    <span aria-hidden className="flex size-6 shrink-0 items-center justify-center rounded-full bg-s-3 text-text-3">
      <Icon className="size-3.5" />
    </span>
  );
}

/** "deal.stage_changed" → "Stage changed". */
function timelineLabel(type: string) {
  const known: Record<string, string> = {
    "deal.created": "Deal created",
    "deal.stage_changed": "Stage changed",
    "note.added": "Note",
    "task.created": "Task created",
    "task.completed": "Task completed",
    "meeting.booked": "Meeting booked",
  };
  return known[type] ?? labelOf(type.split(".").pop() ?? type);
}
