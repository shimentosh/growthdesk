"use client";

import { useMemo, useState } from "react";
import { ClipboardList, Filter, Search, X } from "lucide-react";
import { LIFECYCLE_STAGES, type ContactFilterT, type LifecycleStage } from "@growthdesk/shared";
import { CompanyPicker, contactLabel } from "@/components/pickers/Pickers";
import { useTags } from "@/components/crm/Tags";
import { STAGE_PLURAL } from "@/components/crm/lifecycle";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Checkbox } from "@/components/ui/Checkbox";
import { Field } from "@/components/ui/Field";
import { Textarea } from "@/components/ui/Input";
import { SearchInput } from "@/components/ui/SearchInput";
import { Select } from "@/components/ui/Select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { formatNumber } from "@/lib/format";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import type { ContactSummary, Paged } from "@/lib/types";

export type PickedContact = { id: string; label: string; sub: string | null };

type Resolved = {
  contacts: Pick<ContactSummary, "id" | "fullName" | "firstName" | "lastName" | "email" | "phone">[];
  capped: boolean;
  unknownEmails: string[];
  invalid: string[];
};
type ResolveBody = { emails?: string[]; filter?: ContactFilterT };

/** The most one add can send (POST lists/:id/members takes up to 5000 ids). */
export const MAX_PICK = 5000;
/** Rows drawn in the "selected" list; the rest are counted. */
const SHOWN = 200;

const toPicked = (c: Pick<ContactSummary, "id" | "fullName" | "firstName" | "lastName" | "email" | "phone">): PickedContact => ({
  id: c.id,
  label: contactLabel(c),
  sub: c.email,
});
const contacts = (n: number) => `${formatNumber(n)} contact${n === 1 ? "" : "s"}`;

/**
 * Choose many contacts three ways: tick them in a search, paste email
 * addresses, or take everyone matching a tag, stage or company. All three
 * feed one selection, listed below the tabs.
 */
export function ContactChooser({
  picked,
  onPickedChange,
  error,
}: {
  picked: PickedContact[];
  onPickedChange: (next: PickedContact[]) => void;
  error?: string;
}) {
  const pickedIds = useMemo(() => new Set(picked.map((p) => p.id)), [picked]);
  const add = (rows: PickedContact[]) => {
    const fresh = rows.filter((r) => !pickedIds.has(r.id));
    if (fresh.length) onPickedChange([...picked, ...fresh]);
    return fresh.length;
  };
  const remove = (ids: Set<string>) => onPickedChange(picked.filter((p) => !ids.has(p.id)));

  return (
    <div className="flex flex-col gap-3">
      <Tabs defaultValue="search">
        <TabsList aria-label="How to choose contacts">
          <TabsTrigger value="search">
            <Search aria-hidden />
            Search
          </TabsTrigger>
          <TabsTrigger value="paste">
            <ClipboardList aria-hidden />
            Paste emails
          </TabsTrigger>
          <TabsTrigger value="filter">
            <Filter aria-hidden />
            By tag or stage
          </TabsTrigger>
        </TabsList>
        <TabsContent value="search" keepMounted>
          <SearchTab pickedIds={pickedIds} onAdd={add} onRemove={remove} />
        </TabsContent>
        <TabsContent value="paste" keepMounted>
          <PasteTab onAdd={add} />
        </TabsContent>
        <TabsContent value="filter" keepMounted>
          <FilterTab onAdd={add} />
        </TabsContent>
      </Tabs>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-text-2">
            Selected <span className="tabular-nums text-text-3">· {formatNumber(picked.length)}</span>
          </span>
          {picked.length > 0 && (
            <button type="button" className="text-xs text-text-3 hover:text-text hover:underline" onClick={() => onPickedChange([])}>
              Clear all
            </button>
          )}
        </div>
        {picked.length ? (
          <ul className="flex max-h-48 flex-col divide-y divide-line overflow-y-auto rounded-md border border-line">
            {picked.slice(0, SHOWN).map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-2 px-3 py-1.5">
                <span className="min-w-0">
                  <span className="block truncate text-sm text-text">{c.label}</span>
                  <span className="block truncate text-xs text-text-3">{c.sub || "No email address"}</span>
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${c.label}`}
                  onClick={() => remove(new Set([c.id]))}
                  className="shrink-0 rounded-xs p-1 text-text-3 hover:bg-hover hover:text-text"
                >
                  <X aria-hidden className="size-3.5" />
                </button>
              </li>
            ))}
            {picked.length > SHOWN && <li className="px-3 py-2 text-xs text-text-3">and {contacts(picked.length - SHOWN)} more</li>}
          </ul>
        ) : (
          <p className="rounded-md border border-dashed border-line px-3 py-3 text-center text-xs text-text-3">Nobody yet. Tick people, paste addresses or pick a tag above.</p>
        )}
        {error ? (
          <p className="text-xs text-bad-ink">{error}</p>
        ) : (
          picked.length > MAX_PICK && <p className="text-xs text-bad-ink">At most {formatNumber(MAX_PICK)} at a time. Remove some, or add the rest in a second pass.</p>
        )}
      </div>
    </div>
  );
}

/** Search, then tick rows; "select all" takes every row shown. */
function SearchTab({ pickedIds, onAdd, onRemove }: { pickedIds: Set<string>; onAdd: (rows: PickedContact[]) => number; onRemove: (ids: Set<string>) => void }) {
  const ws = useWorkspace();
  const [q, setQ] = useState("");
  const list = useApiQuery<Paged<ContactSummary>>(ws.key("contacts", "chooser"), ws.path("/contacts"), {
    query: { pageSize: 50, sort: "updatedAt", filter: q ? { q } : undefined },
    keepPrevious: true,
  });
  const rows = list.data?.items ?? [];
  const ticked = rows.filter((r) => pickedIds.has(r.id)).length;
  const all = rows.length > 0 && ticked === rows.length;

  return (
    <div className="flex flex-col gap-2">
      <SearchInput value={q} onChange={setQ} placeholder="Search by name, email, company…" aria-label="Search contacts" autoFocus />
      <div className="overflow-hidden rounded-md border border-line">
        <div className="flex items-center justify-between gap-2 border-b border-line bg-well px-3 py-2">
          <Checkbox
            checked={all ? true : ticked ? "indeterminate" : false}
            disabled={!rows.length}
            onCheckedChange={() => (all ? onRemove(new Set(rows.map((r) => r.id))) : onAdd(rows.map(toPicked)))}
            label={<span className="text-xs">Select all {rows.length ? formatNumber(rows.length) : ""} shown</span>}
          />
          {list.data && list.data.total > rows.length && (
            <span className="text-2xs text-text-3">
              {formatNumber(rows.length)} of {formatNumber(list.data.total)}; search to narrow
            </span>
          )}
        </div>
        <ul className="max-h-56 divide-y divide-line overflow-y-auto">
          {list.isPending ? (
            <li className="px-3 py-3 text-xs text-text-3">Loading contacts…</li>
          ) : !rows.length ? (
            <li className="px-3 py-3 text-xs text-text-3">{q ? "No contact matches" : "No contacts yet"}</li>
          ) : (
            rows.map((c) => {
              const on = pickedIds.has(c.id);
              const sub = [c.email, c.company?.name].filter(Boolean).join(" · ");
              return (
                <li key={c.id} className="px-3 py-1.5 hover:bg-hover">
                  <Checkbox
                    checked={on}
                    onCheckedChange={(v) => (v ? onAdd([toPicked(c)]) : onRemove(new Set([c.id])))}
                    label={
                      <span className="min-w-0">
                        <span className="block truncate text-sm text-text">{contactLabel(c)}</span>
                        <span className="block truncate text-xs text-text-3">{sub || "No email address"}</span>
                      </span>
                    }
                  />
                </li>
              );
            })
          )}
        </ul>
      </div>
    </div>
  );
}

/** Paste addresses (any separator); the ones that match contacts join the selection. */
function PasteTab({ onAdd }: { onAdd: (rows: PickedContact[]) => number }) {
  const ws = useWorkspace();
  const [text, setText] = useState("");
  const [outcome, setOutcome] = useState<{ found: number; added: number; unknown: string[]; invalid: string[]; capped: boolean } | null>(null);
  const resolve = useApiMutation<Resolved, ResolveBody>({
    path: ws.path("/contacts/resolve"),
    onSuccess: (r) => {
      const added = onAdd(r.contacts.map(toPicked));
      setOutcome({ found: r.contacts.length, added, unknown: r.unknownEmails, invalid: r.invalid, capped: r.capped });
    },
  });
  const emails = text.split(/[\s,;]+/).filter(Boolean);

  return (
    <div className="flex flex-col gap-2">
      <Field label="Email addresses" hint="One per line, or separated by commas or spaces. Copy a column from a spreadsheet works too.">
        <Textarea
          rows={5}
          value={text}
          placeholder={"ada@example.com\ngrace@example.com, linus@example.com"}
          onChange={(e) => {
            setText(e.target.value);
            setOutcome(null);
          }}
          className="font-mono text-xs"
        />
      </Field>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-text-3">{emails.length ? `${formatNumber(emails.length)} entr${emails.length === 1 ? "y" : "ies"}` : ""}</span>
        <Button size="sm" loading={resolve.isPending} disabled={!emails.length || emails.length > MAX_PICK} onClick={() => resolve.mutate({ emails })}>
          Find and select
        </Button>
      </div>
      {outcome && (
        <Callout tone={outcome.unknown.length || outcome.invalid.length ? "warn" : "info"} title={`${contacts(outcome.found)} found, ${formatNumber(outcome.added)} newly selected`}>
          {outcome.unknown.length > 0 && (
            <p>
              Not in your contacts ({formatNumber(outcome.unknown.length)}): <Clipped values={outcome.unknown} />. Import them first to add them.
            </p>
          )}
          {outcome.invalid.length > 0 && (
            <p>
              Not email addresses ({formatNumber(outcome.invalid.length)}): <Clipped values={outcome.invalid} />
            </p>
          )}
          {outcome.capped && <p>Only the first {formatNumber(MAX_PICK)} matches were taken.</p>}
        </Callout>
      )}
    </div>
  );
}

/** Everyone with a tag, at a stage, or at a company (any combination). */
function FilterTab({ onAdd }: { onAdd: (rows: PickedContact[]) => number }) {
  const ws = useWorkspace();
  const tags = useTags();
  const [tag, setTag] = useState("");
  const [stage, setStage] = useState<LifecycleStage | "">("");
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [added, setAdded] = useState<number | null>(null);
  const filter: ContactFilterT = { ...(tag ? { tag: [tag] } : {}), ...(stage ? { stage: [stage] } : {}), ...(companyId ? { companyId } : {}) };
  const any = Boolean(tag || stage || companyId);
  const count = useApiQuery<Paged<ContactSummary>>(ws.key("contacts", "chooser-count"), any ? ws.path("/contacts") : null, {
    query: { pageSize: 1, filter },
    keepPrevious: true,
  });
  const resolve = useApiMutation<Resolved, ResolveBody>({
    path: ws.path("/contacts/resolve"),
    onSuccess: (r) => setAdded(onAdd(r.contacts.map(toPicked))),
  });
  const total = any ? count.data?.total : undefined;
  const changed = () => setAdded(null);

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Tag">
          <Select
            value={tag}
            onValueChange={(v) => {
              setTag(v);
              changed();
            }}
            placeholder={tags.isPending ? "Loading tags…" : "Any tag"}
            options={[{ value: "", label: "Any tag" }, ...(tags.data ?? []).map((t) => ({ value: t.name, label: `${t.name} · ${formatNumber(t.contactCount)}`, text: t.name }))]}
          />
        </Field>
        <Field label="Stage">
          <Select
            value={stage}
            onValueChange={(v) => {
              setStage(v);
              changed();
            }}
            options={[{ value: "" as const, label: "Any stage" }, ...LIFECYCLE_STAGES.map((s) => ({ value: s, label: STAGE_PLURAL[s] }))]}
          />
        </Field>
      </div>
      <Field label="Company">
        <CompanyPicker
          value={companyId}
          placeholder="Any company"
          onChange={(id) => {
            setCompanyId(id);
            changed();
          }}
        />
      </Field>
      <div className="flex items-center justify-between gap-2 rounded-md border border-line bg-well px-3 py-2">
        <span className="text-xs text-text-2">
          {!any ? "Choose a tag, stage or company." : total === undefined ? "Counting…" : `${contacts(total)} match`}
          {added !== null && <span className="text-text-3"> · {formatNumber(added)} newly selected</span>}
        </span>
        <Button size="sm" loading={resolve.isPending} disabled={!any || !total} onClick={() => resolve.mutate({ filter })}>
          Select {total ? (total > MAX_PICK ? `first ${formatNumber(MAX_PICK)}` : "all") : "all"}
        </Button>
      </div>
    </div>
  );
}

/** A few values in full, the rest counted. */
function Clipped({ values, max = 5 }: { values: string[]; max?: number }) {
  const shown = values.slice(0, max).join(", ");
  return (
    <span className="break-all font-mono text-2xs">
      {shown}
      {values.length > max && ` and ${formatNumber(values.length - max)} more`}
    </span>
  );
}
