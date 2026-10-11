"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import {
  BadgeCheck,
  Bookmark,
  BookmarkPlus,
  Building2,
  CalendarOff,
  Check,
  ChevronDown,
  CircleDot,
  Flag,
  ListFilter,
  Mail,
  Phone,
  Search,
  Tag,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import { CONTACT_STATUSES, PRIORITIES, QUALIFICATIONS, labelOf } from "@growthdesk/shared";
import { useMembers } from "@/components/pickers/Pickers";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { ConfirmDialog, Modal } from "@/components/ui/Dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/DropdownMenu";
import { Field, FormError } from "@/components/ui/Field";
import { Input, NativeSelect } from "@/components/ui/Input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/Popover";
import { cn } from "@/lib/cn";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import type { SavedView } from "@/lib/types/crm";
import { DEFAULT_SORT, activeFilterCount, fromFilter, toFilter, type ContactListState, type SortField, type YesNo } from "./contactListState";
import { useTags } from "./Tags";

type Update = (patch: Partial<ContactListState>, opts?: { replace?: boolean }) => void;

function toggle<T extends string>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

function Group({ title, icon, children }: { title: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1.5 flex items-center gap-1.5 text-2xs font-semibold tracking-wide text-text-3 uppercase">
        {icon && <span aria-hidden className="flex [&_svg]:size-3.5">{icon}</span>}
        {title}
      </legend>
      {children}
    </fieldset>
  );
}

/** The Filters button and its panel. Every change applies at once (and lands in the URL). */
export function FilterPopover({ state, update }: { state: ContactListState; update: Update }) {
  const ws = useWorkspace();
  const tags = useTags();
  const members = useMembers();
  const count = activeFilterCount(state);
  const yesNo = [
    { value: "", label: "Any" },
    { value: "yes", label: "Yes" },
    { value: "no", label: "No" },
  ];

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button icon={<ListFilter />}>
          Filters
          {count > 0 && <span className="rounded-xs bg-accent px-1.5 text-2xs font-semibold text-on-accent tabular-nums">{count}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="max-h-[min(560px,80vh)] w-[min(560px,calc(100vw-24px))] overflow-y-auto p-4">
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-3">
          <Group title="Status" icon={<CircleDot />}>
            {CONTACT_STATUSES.map((s) => (
              <Checkbox key={s} checked={state.status.includes(s)} onCheckedChange={() => update({ status: toggle(state.status, s) })} label={labelOf(s)} />
            ))}
          </Group>
          <Group title="Qualification" icon={<BadgeCheck />}>
            {QUALIFICATIONS.map((q) => (
              <Checkbox
                key={q}
                checked={state.qualification.includes(q)}
                onCheckedChange={() => update({ qualification: toggle(state.qualification, q) })}
                label={labelOf(q)}
              />
            ))}
          </Group>
          <Group title="Priority" icon={<Flag />}>
            {PRIORITIES.map((p) => (
              <Checkbox key={p} checked={state.priority.includes(p)} onCheckedChange={() => update({ priority: toggle(state.priority, p) })} label={labelOf(p)} />
            ))}
          </Group>
        </div>

        <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Owner">
            <NativeSelect value={state.owner} onChange={(e) => update({ owner: e.target.value })} size="sm">
              <option value="">Anyone</option>
              <option value="me">Me</option>
              <option value="none">Unassigned</option>
              {ws.can("members.read") &&
                (members.data?.members ?? []).map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.name || m.email}
                  </option>
                ))}
            </NativeSelect>
          </Field>
          <Field label="Has email">
            <NativeSelect size="sm" value={state.hasEmail} onChange={(e) => update({ hasEmail: e.target.value as YesNo })} options={yesNo} />
          </Field>
          <Field label="Has phone">
            <NativeSelect size="sm" value={state.hasPhone} onChange={(e) => update({ hasPhone: e.target.value as YesNo })} options={yesNo} />
          </Field>
        </div>

        <div className="mt-4">
          <Checkbox
            checked={state.noNextAction}
            onCheckedChange={(c) => update({ noNextAction: c })}
            label="No next action"
            description="Contacts with no next-action date set."
          />
        </div>

        <div className="mt-5">
          <Group title="Tags" icon={<Tag />}>
            {tags.isPending ? (
              <p className="text-xs text-text-3">Loading tags…</p>
            ) : !tags.data?.length ? (
              <p className="text-xs text-text-3">No tags in this workspace yet.</p>
            ) : (
              <div className="grid max-h-40 grid-cols-1 gap-1.5 overflow-y-auto sm:grid-cols-2">
                {tags.data.map((t) => (
                  <Checkbox
                    key={t.id}
                    checked={state.tag.includes(t.name)}
                    onCheckedChange={() => update({ tag: toggle(state.tag, t.name) })}
                    label={
                      <span>
                        {t.name} <span className="text-xs text-text-3 tabular-nums">({t.contactCount})</span>
                      </span>
                    }
                  />
                ))}
              </div>
            )}
          </Group>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function Chip({ label, icon, onRemove }: { label: ReactNode; icon?: ReactNode; onRemove: () => void }) {
  return (
    <span className="inline-flex h-6 max-w-full items-center gap-1 rounded-xs bg-mute-chip pr-1 pl-2 text-xs text-text-2">
      {icon && <span aria-hidden className="flex shrink-0 text-text-3 [&_svg]:size-3">{icon}</span>}
      <span className="truncate">{label}</span>
      <button type="button" aria-label="Remove filter" onClick={onRemove} className="rounded-xs p-0.5 text-text-3 hover:bg-hover hover:text-text">
        <X aria-hidden className="size-3" />
      </button>
    </span>
  );
}

/** One removable chip per active filter, and "Clear all". */
export function FilterChips({ state, update, clear }: { state: ContactListState; update: Update; clear: () => void }) {
  const members = useMembers();
  if (!activeFilterCount(state) && !state.q) return null;
  const ownerLabel =
    state.owner === "me"
      ? "Me"
      : state.owner === "none"
        ? "Unassigned"
        : (() => {
            const m = members.data?.members.find((x) => x.userId === state.owner);
            return m ? m.name || m.email : "A teammate";
          })();
  const yn = (v: YesNo) => (v === "yes" ? "yes" : "no");

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {state.q && <Chip icon={<Search />} label={`Search: “${state.q}”`} onRemove={() => update({ q: "" })} />}
      {state.status.length > 0 && <Chip icon={<CircleDot />} label={`Status: ${state.status.map(labelOf).join(", ")}`} onRemove={() => update({ status: [] })} />}
      {state.qualification.length > 0 && (
        <Chip icon={<BadgeCheck />} label={`Qualification: ${state.qualification.map(labelOf).join(", ")}`} onRemove={() => update({ qualification: [] })} />
      )}
      {state.priority.length > 0 && <Chip icon={<Flag />} label={`Priority: ${state.priority.map(labelOf).join(", ")}`} onRemove={() => update({ priority: [] })} />}
      {state.owner && <Chip icon={<UserRound />} label={`Owner: ${ownerLabel}`} onRemove={() => update({ owner: "" })} />}
      {state.tag.length > 0 && <Chip icon={<Tag />} label={`Tag: ${state.tag.join(", ")}`} onRemove={() => update({ tag: [] })} />}
      {state.hasEmail && <Chip icon={<Mail />} label={`Has email: ${yn(state.hasEmail)}`} onRemove={() => update({ hasEmail: "" })} />}
      {state.hasPhone && <Chip icon={<Phone />} label={`Has phone: ${yn(state.hasPhone)}`} onRemove={() => update({ hasPhone: "" })} />}
      {state.noNextAction && <Chip icon={<CalendarOff />} label="No next action" onRemove={() => update({ noNextAction: false })} />}
      {state.companyId && <Chip icon={<Building2 />} label="At one company" onRemove={() => update({ companyId: "" })} />}
      <button type="button" onClick={clear} className="px-1 text-xs font-medium text-accent-hi hover:underline">
        Clear all
      </button>
    </div>
  );
}

/** The saved-views menu: pick one (its filters and sort land in the URL), save the current filters, delete the active one. */
export function SavedViewsMenu({ state, update }: { state: ContactListState; update: Update }) {
  const ws = useWorkspace();
  const viewsKey = ws.key("views", "contact");
  const views = useApiQuery<SavedView[]>(viewsKey, ws.path("/views"), { query: { entity: "contact" } });
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);

  const active = views.data?.find((v) => v.id === state.view) ?? null;

  const create = useApiMutation<SavedView, { entity: "contact"; name: string; filters: Record<string, unknown>; sort: Record<string, unknown>; shared: boolean }>({
    path: ws.path("/views"),
    invalidate: [viewsKey],
    success: (v) => `View “${v.name}” saved`,
    errorToast: false,
    onSuccess: (v) => {
      setSaving(false);
      setName("");
      setShared(false);
      update({ view: v.id });
    },
  });
  const remove = useApiMutation<unknown, string>({
    method: "DELETE",
    path: (id) => ws.path(`/views/${id}`),
    invalidate: [viewsKey],
    success: "View deleted",
    errorToast: false,
    onSuccess: () => update({ view: "" }),
  });

  const apply = (v: SavedView) => {
    const field = typeof v.sort?.field === "string" ? (v.sort.field as SortField) : DEFAULT_SORT;
    update({ ...fromFilter(v.filters ?? {}), view: v.id, sort: field, dir: v.sort?.dir === "asc" ? "asc" : "desc" });
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate({
      entity: "contact",
      name: name.trim(),
      filters: (toFilter(state) ?? {}) as Record<string, unknown>,
      sort: { field: state.sort, dir: state.dir },
      shared,
    });
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button icon={<Bookmark />} iconRight={<ChevronDown className="text-text-3" />}>
            <span className="max-w-40 truncate">{active ? active.name : "All contacts"}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-w-80">
          <DropdownMenuLabel>Views</DropdownMenuLabel>
          <DropdownMenuItem icon={<Check className={cn(state.view && "invisible")} />} onSelect={() => update({ view: "" })}>
            All contacts
          </DropdownMenuItem>
          {views.data?.map((v) => (
            <DropdownMenuItem key={v.id} icon={<Check className={cn(v.id !== state.view && "invisible")} />} onSelect={() => apply(v)}>
              <span className="flex items-center gap-2">
                <span className="truncate">{v.name}</span>
                {v.userId === null && <Badge tone="mute">Shared</Badge>}
              </span>
            </DropdownMenuItem>
          ))}
          {views.isError && <p className="px-2 py-1.5 text-xs text-bad-ink">Could not load saved views.</p>}
          <DropdownMenuSeparator />
          <DropdownMenuItem icon={<BookmarkPlus />} onSelect={() => setSaving(true)}>
            Save current filters as a view…
          </DropdownMenuItem>
          {active && (
            <DropdownMenuItem danger icon={<Trash2 />} onSelect={() => setDeleting(true)}>
              Delete “{active.name}”
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <Modal
        open={saving}
        onOpenChange={(o) => {
          if (!o) create.reset();
          setSaving(o);
        }}
        title="Save view"
        description="Saves the current filters and sort so you can come back to them in one click."
        size="sm"
        footer={
          <>
            <Button onClick={() => setSaving(false)}>Cancel</Button>
            <Button variant="primary" type="submit" form="save-view" loading={create.isPending} disabled={!name.trim()}>
              Save view
            </Button>
          </>
        }
      >
        <form id="save-view" onSubmit={submit} noValidate className="flex flex-col gap-3">
          <FormError error={create.error && !create.error.fields.name ? create.error.message : null} />
          <Field label="Name" required error={create.error?.fields.name}>
            <Input autoFocus maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. My hot leads" />
          </Field>
          <Checkbox checked={shared} onCheckedChange={setShared} label="Share with the workspace" description="Everyone in the workspace sees shared views; others are only yours." />
        </form>
      </Modal>

      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete the view “${active?.name ?? ""}”?`}
        description={active?.userId === null ? "It is shared, so it disappears for everyone in the workspace. Contacts are not affected." : "Contacts are not affected."}
        onConfirm={() => (active ? remove.mutateAsync(active.id) : undefined)}
      />
    </>
  );
}
