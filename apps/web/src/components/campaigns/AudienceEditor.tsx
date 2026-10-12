"use client";

import Link from "next/link";
import { useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { Users, X } from "lucide-react";
import { CONTACT_STATUSES, PRIORITIES, QUALIFICATIONS, labelOf, type ContactFilterT } from "@growthdesk/shared";
import { Button, IconButton } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Checkbox } from "@/components/ui/Checkbox";
import { Field, FormError } from "@/components/ui/Field";
import { Input, NativeSelect } from "@/components/ui/Input";
import { ContactPicker, contactLabel, useMembers } from "@/components/pickers/Pickers";
import { LIST_READ } from "@/components/crm/lifecycle";
import { useMarketing, useMarketingLists } from "@/components/marketing/common";
import { get } from "@/lib/api";
import { formatNumber } from "@/lib/format";
import { useApiQuery } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import type { ContactSummary } from "@/lib/types";
import type { CampaignAudience, CampaignDetail, CampaignReadiness } from "@/lib/types/campaigns";
import type { SavedView } from "@/lib/types/crm";
import { SkippedList, lockedReason, useCampaignPatch } from "./common";

type Mode = CampaignAudience["type"];
type Filter = Omit<ContactFilterT, "createdAfter" | "createdBefore"> & { createdAfter?: string; createdBefore?: string };

const MODES: { value: Mode; label: string; hint: string }[] = [
  {
    value: "lists",
    label: "Lead lists",
    hint: "Resolved when you launch: the leads on any of these lists then. People already handed to sales or made contacts are left out.",
  },
  { value: "filter", label: "Contacts matching a filter", hint: "Resolved when you launch: whoever matches then is enrolled." },
  { value: "view", label: "A saved contact view", hint: "Resolved when you launch, with the view's filters at that moment." },
  { value: "contacts", label: "Specific contacts", hint: "Exactly the contacts you pick." },
];
const SHOWN = 25;

const filterOf = (a: CampaignAudience | null): Filter => (a?.type === "filter" ? (a.filter as Filter) : {});

/** Drops empty values so the stored filter (and its description) says only what was chosen. */
function cleanFilter(f: Filter): Filter {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(f)) {
    if (v === undefined || v === "" || (Array.isArray(v) && !v.length)) continue;
    out[k] = typeof v === "string" ? v.trim() : v;
  }
  return out as Filter;
}

/**
 * Who the campaign is for (shared AudienceInput): a filter, a saved view or
 * hand-picked contacts. Saved with PATCH audience while draft or paused; the
 * readiness check (drafts) shows how many of them can actually be enrolled.
 */
export function AudienceEditor({ campaign }: { campaign: CampaignDetail }) {
  const ws = useWorkspace();
  const locked = lockedReason(campaign.status);
  const disabled = Boolean(locked) || !ws.can("campaigns.write");
  const stored = campaign.audience;
  const [mode, setMode] = useState<Mode>(stored?.type ?? "lists");
  const [listIds, setListIds] = useState<string[]>(stored?.type === "lists" ? stored.listIds : []);
  const mk = useMarketing();
  const canLists = ws.can(LIST_READ);
  const lists = useMarketingLists(true);
  const [ids, setIds] = useState<string[]>(stored?.type === "contacts" ? stored.contactIds : []);
  const [viewId, setViewId] = useState(stored?.type === "view" ? stored.viewId : "");
  const [filter, setFilter] = useState<Filter>(filterOf(stored));
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [showAll, setShowAll] = useState(false);
  const save = useCampaignPatch(campaign.id, "Audience saved");
  const members = useMembers();
  const views = useApiQuery<SavedView[]>(ws.key("views", "contact"), ws.path("/views"), { query: { entity: "contact" } });
  const readiness = useApiQuery<CampaignReadiness>(
    ws.key("campaigns", campaign.id, "readiness"),
    campaign.status === "draft" ? ws.path(`/campaigns/${campaign.id}/readiness`) : null,
  );

  const audience: CampaignAudience | null =
    mode === "lists"
      ? listIds.length
        ? { type: "lists", listIds }
        : null
      : mode === "contacts" ? { type: "contacts", contactIds: ids } : mode === "view" ? (viewId ? { type: "view", viewId } : null) : { type: "filter", filter: cleanFilter(filter) as ContactFilterT };
  const dirty = JSON.stringify(audience) !== JSON.stringify(stored?.type === "filter" ? { type: "filter", filter: cleanFilter(filterOf(stored)) } : stored);
  const fields = save.error?.fields ?? {};

  // Names for stored ids the picker has not given us a label for.
  const shown = showAll ? ids.slice(0, 500) : ids.slice(0, SHOWN);
  const lookups = useQueries({
    queries: (mode === "contacts" ? shown.filter((id) => !labels[id]) : []).map((id) => ({
      queryKey: ws.key("contacts", id),
      queryFn: ({ signal }: { signal: AbortSignal }) => get<ContactSummary>(ws.path(`/contacts/${id}`), { signal }),
      staleTime: 60_000,
      retry: false,
    })),
  });
  const looked = new Map<string, string>();
  for (const q of lookups) if (q.data) looked.set(q.data.id, contactLabel(q.data));
  const nameOf = (id: string) => labels[id] ?? looked.get(id) ?? (lookups.some((q) => q.isPending) ? "Loading…" : "A contact you cannot see, or that was deleted");

  const setF = (patch: Partial<Filter>) => setFilter((f) => ({ ...f, ...patch }));
  const toggle = <T extends string>(list: T[] | undefined, v: T, on: boolean): T[] => (on ? [...(list ?? []), v] : (list ?? []).filter((x) => x !== v));
  const yesNo = (v: boolean | undefined) => (v === undefined ? "" : v ? "yes" : "no");
  const fromYesNo = (v: string) => (v === "yes" ? true : v === "no" ? false : undefined);

  return (
    <div className="flex flex-col gap-4">
      {locked && <Callout tone="info">{locked}</Callout>}
      {campaign.status === "draft" && readiness.data && (
        <Card>
          <CardBody className="grid gap-3 sm:grid-cols-2">
            <div className="text-sm">
              <p className="text-xs text-text-3">Saved audience</p>
              <p className="mt-1 text-text">{readiness.data.audience.description}</p>
              <p className="mt-1 text-text-2">
                {formatNumber(readiness.data.audience.candidates)} contact{readiness.data.audience.candidates === 1 ? "" : "s"} ·{" "}
                <strong className="font-medium text-text">{formatNumber(readiness.data.audience.eligible)}</strong> can be enrolled today
              </p>
            </div>
            {readiness.data.audience.skipped.length > 0 && (
              <div>
                <p className="mb-1 text-xs text-text-3">Would be skipped</p>
                <SkippedList items={readiness.data.audience.skipped} />
              </div>
            )}
          </CardBody>
        </Card>
      )}
      {campaign.status !== "draft" && (
        <Callout tone="info">
          {campaign.audienceDescription}. The audience is enrolled when the campaign launches; to add people later, use Enrollments → Add contacts.
        </Callout>
      )}

      <Card>
        <CardHeader icon={<Users />} title="Who to enroll" description="Deleted, do-not-contact, unsubscribed, bounced and suppressed contacts are always skipped, and so are contacts without an email address when the first action is an email." />
        <CardBody>
          <fieldset disabled={disabled} className="flex min-w-0 flex-col gap-4">
            {save.error && !save.error.isPlanLimit && <FormError error={save.error.message} />}
            <Field label="Audience" hint={MODES.find((m) => m.value === mode)?.hint}>
              <NativeSelect value={mode} onChange={(e) => setMode(e.target.value as Mode)} options={MODES.map((m) => ({ value: m.value, label: m.label }))} />
            </Field>

            {mode === "lists" && (
              <Field label="Lead lists" required error={fields["audience.listIds"]} hint="Pick one or more. Someone on two lists is enrolled once.">
                {!canLists ? (
                  <p className="text-sm text-text-3">Your role cannot see lead lists.</p>
                ) : lists.isPending ? (
                  <p className="text-sm text-text-3">Loading lists…</p>
                ) : lists.isError ? (
                  <p className="text-sm text-bad-ink">Lists could not be loaded: {lists.error.message}</p>
                ) : (lists.data ?? []).filter((l) => !l.archivedAt || listIds.includes(l.id)).length === 0 ? (
                  <p className="text-sm text-text-3">
                    No lead lists yet.{" "}
                    {ws.can("contacts.import") && (
                      <Link href={ws.href("/imports")} className="text-accent-ink hover:text-accent-hi">
                        Import a CSV into a new list
                      </Link>
                    )}
                  </p>
                ) : (
                  <ul className="divide-y divide-line rounded-md border border-line">
                    {(lists.data ?? [])
                      .filter((l) => !l.archivedAt || listIds.includes(l.id))
                      .map((l) => (
                        <li key={l.id} className="flex items-center justify-between gap-3 px-3 py-2">
                          <Checkbox
                            checked={listIds.includes(l.id)}
                            disabled={disabled}
                            onCheckedChange={(on) => setListIds(on ? [...listIds, l.id] : listIds.filter((x) => x !== l.id))}
                            label={
                              <span className="font-medium">
                                {l.name}
                                {l.archivedAt && <span className="ml-1.5 text-xs font-normal text-text-3">(archived)</span>}
                              </span>
                            }
                          />
                          <Link href={mk.href(`/lists/${l.id}`)} className="shrink-0 text-xs text-text-3 tabular-nums hover:text-accent-hi">
                            {formatNumber(l.counts.subscribed + l.counts.pending)} people
                          </Link>
                        </li>
                      ))}
                  </ul>
                )}
              </Field>
            )}

            {mode === "view" && (
              <Field label="Saved view" required error={fields["audience.viewId"]}>
                <NativeSelect
                  value={viewId}
                  onChange={(e) => setViewId(e.target.value)}
                  placeholder={views.isPending ? "Loading…" : "Choose a view"}
                  options={(views.data ?? []).map((v) => ({ value: v.id, label: `${v.name}${v.userId ? "" : " (shared)"}` }))}
                />
              </Field>
            )}

            {mode === "contacts" && (
              <div className="flex flex-col gap-2">
                {!disabled && (
                  <Field label="Add a contact" hint="Search by name, email or phone.">
                    <ContactPicker
                      value={null}
                      clearable={false}
                      placeholder="Search contacts to add"
                      onChange={(id, c) => {
                        if (!id || ids.includes(id)) return;
                        setIds([...ids, id]);
                        if (c) setLabels((l) => ({ ...l, [id]: contactLabel(c) }));
                      }}
                    />
                  </Field>
                )}
                <p className="text-xs text-text-3">{ids.length ? `${formatNumber(ids.length)} selected` : "No contacts selected yet."}</p>
                {ids.length > 0 && (
                  <ul className="divide-y divide-line rounded-md border border-line">
                    {shown.map((id) => (
                      <li key={id} className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm">
                        <span className="min-w-0 truncate text-text">{nameOf(id)}</span>
                        {!disabled && <IconButton size="sm" label="Remove" icon={<X />} onClick={() => setIds(ids.filter((x) => x !== id))} />}
                      </li>
                    ))}
                  </ul>
                )}
                {ids.length > shown.length && (
                  <Button size="sm" variant="ghost" onClick={() => setShowAll(true)} className="self-start">
                    Show {formatNumber(Math.min(ids.length, 500) - shown.length)} more
                  </Button>
                )}
              </div>
            )}

            {mode === "filter" && (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Matching text" hint="Name, email, phone, job title or company." error={fields["audience.filter.q"]}>
                  <Input value={filter.q ?? ""} maxLength={200} onChange={(e) => setF({ q: e.target.value })} placeholder="Anything" />
                </Field>
                <Field label="Owner" hint={filter.ownerId === "me" ? "“Me” means whoever launches the campaign." : undefined}>
                  <NativeSelect
                    value={filter.ownerId ?? ""}
                    onChange={(e) => setF({ ownerId: (e.target.value || undefined) as Filter["ownerId"] })}
                    options={[
                      { value: "", label: "Anyone" },
                      { value: "me", label: "Me" },
                      { value: "none", label: "No owner" },
                      ...(members.data?.members ?? []).map((m) => ({ value: m.userId, label: m.name || m.email })),
                      ...(filter.ownerId && filter.ownerId !== "me" && filter.ownerId !== "none" && !members.data?.members.some((m) => m.userId === filter.ownerId)
                        ? [{ value: filter.ownerId, label: "A teammate" }]
                        : []),
                    ]}
                  />
                </Field>
                <Field label="Tags" hint="Comma-separated; a contact with any of them matches.">
                  <Input
                    value={(filter.tag ?? []).join(", ")}
                    onChange={(e) =>
                      setF({
                        tag: e.target.value
                          .split(",")
                          .map((s) => s.trim())
                          .filter(Boolean),
                      })
                    }
                    placeholder="Any tag"
                  />
                </Field>
                <Field label="Lead source" hint="Exact match, ignoring case.">
                  <Input value={filter.leadSource ?? ""} maxLength={100} onChange={(e) => setF({ leadSource: e.target.value })} placeholder="Any" />
                </Field>
                <Field label="Has email">
                  <NativeSelect value={yesNo(filter.hasEmail)} onChange={(e) => setF({ hasEmail: fromYesNo(e.target.value) })} options={[{ value: "", label: "Either" }, { value: "yes", label: "Yes" }, { value: "no", label: "No" }]} />
                </Field>
                <Field label="Has phone">
                  <NativeSelect value={yesNo(filter.hasPhone)} onChange={(e) => setF({ hasPhone: fromYesNo(e.target.value) })} options={[{ value: "", label: "Either" }, { value: "yes", label: "Yes" }, { value: "no", label: "No" }]} />
                </Field>
                <ChecklistField label="Status" values={CONTACT_STATUSES} chosen={filter.status} disabled={disabled} onChange={(v, on) => setF({ status: toggle(filter.status, v, on) })} />
                <ChecklistField label="Qualification" values={QUALIFICATIONS} chosen={filter.qualification} disabled={disabled} onChange={(v, on) => setF({ qualification: toggle(filter.qualification, v, on) })} />
                <ChecklistField label="Priority" values={PRIORITIES} chosen={filter.priority} disabled={disabled} onChange={(v, on) => setF({ priority: toggle(filter.priority, v, on) })} />
              </div>
            )}
            {fields.audience && <p className="text-xs text-bad-ink">{fields.audience}</p>}
          </fieldset>
        </CardBody>
      </Card>

      {!disabled && (
        <div className="flex justify-end">
          <Button variant="primary" disabled={!dirty || !audience} loading={save.isPending} onClick={() => audience && save.mutate({ audience })}>
            Save audience
          </Button>
        </div>
      )}
    </div>
  );
}

function ChecklistField<T extends string>({
  label,
  values,
  chosen,
  disabled,
  onChange,
}: {
  label: string;
  values: readonly T[];
  chosen: T[] | undefined;
  disabled: boolean;
  onChange: (value: T, on: boolean) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1 text-xs font-medium text-text-2">{label}</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        {values.map((v) => (
          <Checkbox key={v} label={labelOf(v)} disabled={disabled} checked={(chosen ?? []).includes(v)} onCheckedChange={(on) => onChange(v, on)} />
        ))}
      </div>
      <span className="text-xs text-text-3">{chosen?.length ? "Any of the checked" : "Any"}</span>
    </fieldset>
  );
}
