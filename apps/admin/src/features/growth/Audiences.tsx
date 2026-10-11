"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Pencil, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { labelOf, SIGNUP_SOURCES, SUBSCRIPTION_STATUSES, normalizeUserTag } from "@growthdesk/shared";
import { Badge } from "@/components/ui/Badge";
import { Button, IconButton } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog, Modal } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { QueryState } from "@/components/ui/ErrorState";
import { Field, FormError } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { SkeletonText, Spinner } from "@/components/ui/Skeleton";
import { post } from "@/lib/api";
import { cn } from "@/lib/cn";
import { formatNumber, utcToZonedInput, zonedInputToUtc } from "@/lib/format";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useFormat } from "@/lib/session";
import { platformKey, table, usePlatform } from "@/features/common/platform";
import type { AdminPlan } from "@/features/common/types";
import { GrowthTile, growthEmpty } from "./common";
import type { Audience, AudienceFilter, AudiencePreview } from "./types";

/*
 * /growth/audiences — saved filters over our own users. Whatever the filter
 * says, an audience only ever contains people who opted in to product emails,
 * have not unsubscribed, are not suppressed, verified their email and are
 * neither suspended nor anonymised. The builder shows the live count and the
 * newest 20 people it reaches.
 */

export const EMPTY_FILTER: AudienceFilter = {
  plans: [],
  subscriptionStatuses: [],
  signedUpAfter: null,
  signedUpBefore: null,
  lastLoginAfter: null,
  lastLoginBefore: null,
  workspacesMin: null,
  workspacesMax: null,
  tagsAny: [],
  signupSources: [],
};

/** A one-line summary of a filter, for lists and pickers. */
export function describeFilter(f: AudienceFilter, date: (v: string) => string): string {
  const parts: string[] = [];
  if (f.plans.length) parts.push(`plan ${f.plans.join(" / ")}`);
  if (f.subscriptionStatuses.length) parts.push(f.subscriptionStatuses.map(labelOf).join(" / ").toLowerCase());
  if (f.signedUpAfter) parts.push(`signed up after ${date(f.signedUpAfter)}`);
  if (f.signedUpBefore) parts.push(`signed up before ${date(f.signedUpBefore)}`);
  if (f.lastLoginAfter) parts.push(`active since ${date(f.lastLoginAfter)}`);
  if (f.lastLoginBefore) parts.push(`last seen before ${date(f.lastLoginBefore)}`);
  if (f.workspacesMin != null || f.workspacesMax != null) parts.push(`${f.workspacesMin ?? 0}–${f.workspacesMax ?? "∞"} workspaces`);
  if (f.tagsAny.length) parts.push(`tagged ${f.tagsAny.join(" or ")}`);
  if (f.signupSources.length) parts.push(`via ${f.signupSources.map(labelOf).join(" / ").toLowerCase()}`);
  return parts.length ? parts.join(" · ") : "Everyone who opted in";
}

function Chips<V extends string>({ options, value, onChange, disabled }: { options: { value: V; label: ReactNode }[]; value: V[]; onChange: (v: V[]) => void; disabled?: boolean }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const on = value.includes(o.value);
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            disabled={disabled}
            onClick={() => onChange(on ? value.filter((x) => x !== o.value) : [...value, o.value])}
            className={cn(
              "inline-flex h-7 items-center rounded-full border px-2.5 text-xs transition-colors disabled:opacity-50",
              on ? "border-accent/50 bg-accent/12 font-medium text-accent-ink" : "border-line bg-panel text-text-2 hover:bg-hover hover:text-text",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Debounced count + samples for a filter. */
function useAudiencePreview(filter: AudienceFilter | null) {
  const [state, setState] = useState<{ data: AudiencePreview | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: false });
  const body = filter ? JSON.stringify({ filter }) : null;
  useEffect(() => {
    if (!body) return;
    const ctrl = new AbortController();
    setState((s) => ({ ...s, loading: true }));
    const timer = setTimeout(() => {
      post<AudiencePreview>("/admin/growth/audiences/preview", JSON.parse(body), { signal: ctrl.signal })
        .then((data) => setState({ data, error: null, loading: false }))
        .catch((e: unknown) => {
          if (ctrl.signal.aborted) return;
          setState((s) => ({ ...s, error: e instanceof Error ? e.message : String(e), loading: false }));
        });
    }, 350);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [body]);
  return state;
}

function DateRange({
  label,
  after,
  before,
  onChange,
  disabled,
}: {
  label: string;
  after: string | null | undefined;
  before: string | null | undefined;
  onChange: (after: string | null, before: string | null) => void;
  disabled?: boolean;
}) {
  const { timeZone } = useFormat();
  const toInput = (v: string | null | undefined) => (v ? utcToZonedInput(v, timeZone, "date") : "");
  // A day typed here means the whole day in the viewer's time zone.
  const start = (d: string) => (d ? zonedInputToUtc(`${d}T00:00`, timeZone) : null);
  const end = (d: string) => (d ? zonedInputToUtc(`${d}T23:59:59`, timeZone) : null);
  return (
    <Field label={label}>
      <div className="grid grid-cols-2 gap-2">
        <Input type="date" aria-label={`${label} from`} value={toInput(after)} onChange={(e) => onChange(start(e.target.value), before ?? null)} disabled={disabled} />
        <Input type="date" aria-label={`${label} to`} value={toInput(before)} onChange={(e) => onChange(after ?? null, end(e.target.value))} disabled={disabled} />
      </div>
    </Field>
  );
}

function AudienceBuilder({ audience, open, onOpenChange }: { audience: Audience | null; open: boolean; onOpenChange: (v: boolean) => void }) {
  const { canChange } = usePlatform();
  const f = useFormat();
  const [name, setName] = useState(audience?.name ?? "");
  const [filter, setFilter] = useState<AudienceFilter>(audience?.filter ?? EMPTY_FILTER);
  const [tagText, setTagText] = useState((audience?.filter.tagsAny ?? []).join(", "));
  const plans = useApiQuery<AdminPlan[]>(platformKey("plans"), "/admin/plans", { staleTime: 5 * 60_000 });
  const preview = useAudiencePreview(open ? filter : null);
  const save = useApiMutation<Audience, void>({
    method: audience ? "PATCH" : "POST",
    path: audience ? `/admin/growth/audiences/${audience.id}` : "/admin/growth/audiences",
    body: () => ({ name, filter }),
    invalidate: [platformKey("growth")],
    success: audience ? "Audience saved" : "Audience created",
    errorToast: false,
    onSuccess: () => onOpenChange(false),
  });
  const set = (patch: Partial<AudienceFilter>) => setFilter((x) => ({ ...x, ...patch }));
  const num = (v: string) => (v === "" ? null : Math.max(0, Math.min(10_000, Math.trunc(Number(v)))));
  const disabled = !canChange;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      size="xl"
      dismissOnOutside={false}
      icon={<GrowthTile of="audiences" size="md" />}
      title={audience ? "Edit audience" : "New audience"}
      description="Combine filters; every one narrows the audience."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {canChange ? "Cancel" : "Close"}
          </Button>
          {canChange && (
            <Button variant="primary" loading={save.isPending} disabled={!name.trim()} onClick={() => save.mutate()}>
              {audience ? "Save audience" : "Create audience"}
            </Button>
          )}
        </>
      }
    >
      <div className="grid grid-cols-1 gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <Field label="Name" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="e.g. Trialing on Pro" disabled={disabled} autoFocus />
          </Field>
          <Field label="Plans" hint="People in any workspace whose account is on one of these plans.">
            {plans.isPending ? (
              <SkeletonText lines={1} />
            ) : (
              <Chips options={(plans.data ?? []).map((p) => ({ value: p.key, label: p.name }))} value={filter.plans} onChange={(v) => set({ plans: v })} disabled={disabled} />
            )}
          </Field>
          <Field label="Subscription status" hint="Combined with the plans above when both are set.">
            <Chips options={SUBSCRIPTION_STATUSES.map((s) => ({ value: s, label: labelOf(s) }))} value={filter.subscriptionStatuses} onChange={(v) => set({ subscriptionStatuses: v })} disabled={disabled} />
          </Field>
          <DateRange label="Signed up" after={filter.signedUpAfter} before={filter.signedUpBefore} onChange={(a, b) => set({ signedUpAfter: a, signedUpBefore: b })} disabled={disabled} />
          <DateRange label="Last signed in" after={filter.lastLoginAfter} before={filter.lastLoginBefore} onChange={(a, b) => set({ lastLoginAfter: a, lastLoginBefore: b })} disabled={disabled} />
          <Field label="Workspaces" hint="How many workspaces the person belongs to. Leave empty for no limit.">
            <div className="grid grid-cols-2 gap-2">
              <Input type="number" min={0} inputMode="numeric" aria-label="At least" placeholder="At least" value={filter.workspacesMin ?? ""} onChange={(e) => set({ workspacesMin: num(e.target.value) })} disabled={disabled} />
              <Input type="number" min={0} inputMode="numeric" aria-label="At most" placeholder="At most" value={filter.workspacesMax ?? ""} onChange={(e) => set({ workspacesMax: num(e.target.value) })} disabled={disabled} />
            </div>
          </Field>
          <Field label="Tags (any of)" hint="Comma-separated user tags, as set on the user page.">
            <Input
              value={tagText}
              onChange={(e) => {
                setTagText(e.target.value);
                set({ tagsAny: e.target.value.split(",").map(normalizeUserTag).filter(Boolean).slice(0, 20) });
              }}
              placeholder="beta, early-adopter"
              disabled={disabled}
            />
          </Field>
          <Field label="Signed up with">
            <Chips options={SIGNUP_SOURCES.map((s) => ({ value: s, label: labelOf(s) }))} value={filter.signupSources} onChange={(v) => set({ signupSources: v })} disabled={disabled} />
          </Field>
          <FormError error={save.error?.message ?? null} />
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          <div className="rounded-xl border border-line bg-well p-4">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-text-3">Reaches right now</span>
              {preview.loading && <Spinner size="sm" label="Counting" />}
            </div>
            <div className="mt-1 text-3xl font-semibold tracking-[-0.02em] text-text-hi tabular-nums">{preview.data ? formatNumber(preview.data.count) : "—"}</div>
            <div className="text-xs text-text-3">{describeFilter(filter, (v) => f.date(v, "medium"))}</div>
          </div>
          <Callout tone="info" title="Always applied" className="text-xs">
            <span className="inline-flex items-start gap-1.5">
              <ShieldCheck aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              Opted in to product emails, not unsubscribed or suppressed, email verified, not suspended or anonymised.
            </span>
          </Callout>
          {preview.error && <Callout tone="bad">{preview.error}</Callout>}
          <div className="min-h-0 overflow-hidden rounded-xl border border-line">
            <div className="border-b border-line bg-panel px-3 py-2 text-xs font-medium text-text-2">Newest {preview.data?.samples.length ?? 0} people</div>
            <ul className="max-h-[320px] divide-y divide-line overflow-auto">
              {(preview.data?.samples ?? []).map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                  <div className="min-w-0">
                    <div className="truncate font-medium text-text">{s.name || s.email}</div>
                    <div className="truncate text-xs text-text-3">{s.email}</div>
                  </div>
                  <div className="shrink-0 text-right text-2xs text-text-3">
                    <div>Joined {f.date(s.createdAt, "short")}</div>
                    <div>
                      {s.workspaces} workspace{s.workspaces === 1 ? "" : "s"}
                    </div>
                  </div>
                </li>
              ))}
              {preview.data && preview.data.samples.length === 0 && <li className="px-3 py-6 text-center text-sm text-text-3">Nobody matches yet.</li>}
            </ul>
          </div>
        </div>
      </div>
    </Modal>
  );
}

/** /growth/audiences */
export function Audiences() {
  const f = useFormat();
  const { canChange } = usePlatform();
  const list = useApiQuery<Audience[]>(platformKey("growth", "audiences"), "/admin/growth/audiences");
  const [editing, setEditing] = useState<Audience | null | "new">(null);
  const [deleting, setDeleting] = useState<Audience | null>(null);
  const remove = useApiMutation<unknown, string>({
    method: "DELETE",
    path: (id) => `/admin/growth/audiences/${id}`,
    invalidate: [platformKey("growth")],
    success: "Audience deleted",
    errorToast: false,
  });
  const total = useMemo(() => list.data?.length ?? 0, [list.data]);

  return (
    <Page>
      <PageHeader
        icon={<GrowthTile of="audiences" />}
        title="Audiences"
        description="Saved groups of your users for broadcasts. Consent, unsubscribes, suppression and verification are always checked, so an audience never reaches anyone who did not opt in."
        actions={
          canChange && (
            <Button variant="primary" icon={<Plus />} onClick={() => setEditing("new")}>
              New audience
            </Button>
          )
        }
      />
      <QueryState
        query={list}
        loading={<SkeletonText lines={6} />}
        isEmpty={(d) => d.length === 0}
        empty={
          <Card>
            <EmptyState
              {...growthEmpty("audiences")}
              title="No audiences yet"
              description="Create one to choose who a broadcast goes to — by plan, subscription, sign-up date, activity, workspaces, tags or sign-up source."
              action={
                canChange && (
                  <Button variant="primary" icon={<Plus />} onClick={() => setEditing("new")}>
                    New audience
                  </Button>
                )
              }
            />
          </Card>
        }
      >
        {(rows) => (
          <Card className="overflow-hidden">
            <div className={table.wrap}>
              <table className={table.table}>
                <thead>
                  <tr>
                    <th className={table.th}>Audience</th>
                    <th className={cn(table.th, "text-right")}>People now</th>
                    <th className={cn(table.th, "hidden md:table-cell")}>Broadcasts</th>
                    <th className={cn(table.th, "hidden lg:table-cell")}>Updated</th>
                    <th className={table.th}>
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((a) => (
                    <tr key={a.id} className="hover:bg-hover">
                      <td className={table.td}>
                        <button type="button" onClick={() => setEditing(a)} className="text-left">
                          <div className="font-medium text-text-hi hover:underline">{a.name}</div>
                          <div className="max-w-[56ch] truncate text-xs text-text-3">{describeFilter(a.filter, (v) => f.date(v, "medium"))}</div>
                        </button>
                      </td>
                      <td className={cn(table.td, "text-right font-medium tabular-nums")}>{formatNumber(a.count)}</td>
                      <td className={cn(table.td, "hidden md:table-cell")}>
                        {a.broadcasts ? (
                          <Badge tone="mute" quiet>
                            {a.broadcasts}
                          </Badge>
                        ) : (
                          <span className="text-text-3">—</span>
                        )}
                      </td>
                      <td className={cn(table.td, "hidden text-text-3 lg:table-cell")}>{f.smart(a.updatedAt)}</td>
                      <td className={cn(table.td, "w-0 whitespace-nowrap text-right")}>
                        <IconButton label={canChange ? "Edit" : "View"} icon={<Pencil />} onClick={() => setEditing(a)} />
                        {canChange && <IconButton label="Delete" icon={<Trash2 />} onClick={() => setDeleting(a)} />}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="border-t border-line px-4 py-2 text-xs text-text-3">
              {total} audience{total === 1 ? "" : "s"} · counts are live
            </div>
          </Card>
        )}
      </QueryState>
      {editing !== null && (
        <AudienceBuilder key={editing === "new" ? "new" : editing.id} audience={editing === "new" ? null : editing} open onOpenChange={(v) => !v && setEditing(null)} />
      )}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(v) => !v && setDeleting(null)}
        title={`Delete “${deleting?.name ?? ""}”?`}
        description="Draft broadcasts using it lose their audience. Sent broadcasts keep their recipient list and stats."
        onConfirm={() => remove.mutateAsync(deleting!.id)}
      />
    </Page>
  );
}
