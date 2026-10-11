"use client";

/*
 * Record pickers shared by every area: a button that opens a searchable list
 * and returns the chosen id (or null when cleared).
 *
 *   <ContactPicker value={contactId} onChange={(id, contact) => …} />
 *   <CompanyPicker value={companyId} onChange={…} />
 *   <MemberPicker value={ownerId} onChange={…} placeholder="Unassigned" />
 *   <CampaignPicker value={campaignId} onChange={…} statuses={["running", "paused"]} />
 *
 * They search the API as you type (contacts, companies) or filter the member
 * list locally. Wrap in <Field label=…> for a label; the trigger takes the
 * Field's id and aria props.
 */

import { useState, type ReactNode } from "react";
import { Building2, Check, ChevronsUpDown, SearchX, Send, UserRound, X } from "lucide-react";
import { labelOf } from "@growthdesk/shared";
import { cn } from "@/lib/cn";
import { useApiQuery } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import type { ContactSummary, Member, MembersResponse, Paged } from "@/lib/types";
import { useFieldControl } from "@/components/ui/Field";
import { controlClass } from "@/components/ui/Input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/Popover";
import { SearchInput } from "@/components/ui/SearchInput";
import { Spinner } from "@/components/ui/Skeleton";

export type PickerItem = { id: string; label: string; sublabel?: string | null };

type BaseProps = {
  value: string | null | undefined;
  /** The label to show for `value` before the list has loaded (e.g. the record's current contact name). */
  valueLabel?: string | null;
  placeholder?: string;
  disabled?: boolean;
  /** Offer a "clear" mark (default true). */
  clearable?: boolean;
  size?: "sm" | "md";
  className?: string;
  "aria-label"?: string;
};

/** The generic searchable picker the three wrappers are built on. */
export function EntityPicker({
  value,
  valueLabel,
  placeholder = "Choose…",
  disabled,
  clearable = true,
  size = "md",
  className,
  items,
  loading,
  search,
  onSearch,
  onChange,
  emptyText = "Nothing found",
  footer,
  icon,
  ...aria
}: BaseProps & {
  items: PickerItem[];
  loading?: boolean;
  search: string;
  onSearch: (q: string) => void;
  onChange: (id: string | null, item: PickerItem | null) => void;
  emptyText?: string;
  footer?: ReactNode;
  /** A bare glyph for the kind of record, shown at the start of the trigger. */
  icon?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const field = useFieldControl();
  const current = items.find((i) => i.id === value);
  const label = current?.label ?? (value ? (valueLabel ?? "Selected") : null);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div className={cn("relative w-full", className)}>
        <PopoverTrigger asChild disabled={disabled}>
          <button
            type="button"
            {...field}
            aria-label={aria["aria-label"]}
            aria-haspopup="listbox"
            className={cn(
              controlClass,
              "inline-flex items-center justify-between gap-2 text-left",
              size === "md" ? "h-8 px-2.5" : "h-7 px-2 text-xs",
              clearable && value ? "pr-12" : "pr-7",
              !label && "text-text-3",
            )}
          >
            <span className="flex min-w-0 items-center gap-2">
              {icon && <span aria-hidden className="flex shrink-0 text-text-3 [&_svg]:size-3.5">{icon}</span>}
              <span className="truncate">{label ?? placeholder}</span>
            </span>
          </button>
        </PopoverTrigger>
        {clearable && value && !disabled && (
          <button
            type="button"
            aria-label="Clear"
            onClick={() => onChange(null, null)}
            className="absolute top-1/2 right-6 -translate-y-1/2 rounded-xs p-0.5 text-text-3 hover:bg-hover hover:text-text"
          >
            <X aria-hidden className="size-3.5" />
          </button>
        )}
        <ChevronsUpDown aria-hidden className="pointer-events-none absolute top-1/2 right-2 size-3.5 -translate-y-1/2 text-text-3" />
      </div>
      <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] min-w-64 p-0">
        <div className="border-b border-line p-2">
          <SearchInput value={search} onChange={onSearch} size="sm" autoFocus delay={250} />
        </div>
        <ul role="listbox" className="max-h-64 overflow-y-auto p-1">
          {loading && !items.length ? (
            <li className="flex justify-center py-4">
              <Spinner label="Loading" />
            </li>
          ) : !items.length ? (
            <li className="flex flex-col items-center gap-1.5 px-2 py-5 text-center text-xs text-text-3">
              <SearchX aria-hidden className="size-4" />
              {emptyText}
            </li>
          ) : (
            items.map((i) => (
              <li key={i.id} role="option" aria-selected={i.id === value}>
                <button
                  type="button"
                  onClick={() => {
                    onChange(i.id, i);
                    setOpen(false);
                  }}
                  className="flex w-full items-start gap-2 rounded-xs px-2 py-1.5 text-left hover:bg-hover"
                >
                  <Check aria-hidden className={cn("mt-0.5 size-3.5 shrink-0 text-accent", i.id !== value && "invisible")} />
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-text">{i.label}</span>
                    {i.sublabel && <span className="block truncate text-xs text-text-3">{i.sublabel}</span>}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
        {footer && <div className="border-t border-line p-1">{footer}</div>}
      </PopoverContent>
    </Popover>
  );
}

export const contactLabel = (c: Pick<ContactSummary, "fullName" | "firstName" | "lastName" | "email" | "phone">) =>
  c.fullName || [c.firstName, c.lastName].filter(Boolean).join(" ") || c.email || c.phone || "Unnamed contact";

/** Search contacts by name, email or phone. */
export function ContactPicker({ onChange, ...props }: BaseProps & { onChange: (id: string | null, contact: ContactSummary | null) => void }) {
  const ws = useWorkspace();
  const [q, setQ] = useState("");
  const list = useApiQuery<Paged<ContactSummary>>(ws.key("contacts", "picker"), ws.path("/contacts"), {
    query: { pageSize: 20, sort: "updatedAt", filter: q ? { q } : undefined },
    keepPrevious: true,
  });
  const rows = list.data?.items ?? [];
  const items: PickerItem[] = rows.map((c) => ({ id: c.id, label: contactLabel(c), sublabel: [c.email, c.company?.name].filter(Boolean).join(" · ") || null }));
  return (
    <EntityPicker
      placeholder="Choose a contact"
      icon={<UserRound />}
      {...props}
      items={items}
      loading={list.isFetching}
      search={q}
      onSearch={setQ}
      emptyText={q ? "No contact matches" : "No contacts yet"}
      onChange={(id) => onChange(id, rows.find((c) => c.id === id) ?? null)}
    />
  );
}

export type CompanySummary = { id: string; name: string; domain: string | null };

/** Search companies by name or domain. */
export function CompanyPicker({ onChange, ...props }: BaseProps & { onChange: (id: string | null, company: CompanySummary | null) => void }) {
  const ws = useWorkspace();
  const [q, setQ] = useState("");
  const list = useApiQuery<Paged<CompanySummary>>(ws.key("companies", "picker"), ws.path("/companies"), {
    query: { pageSize: 20, sort: "name", dir: "asc", q },
    keepPrevious: true,
  });
  const rows = list.data?.items ?? [];
  return (
    <EntityPicker
      placeholder="Choose a company"
      icon={<Building2 />}
      {...props}
      items={rows.map((c) => ({ id: c.id, label: c.name, sublabel: c.domain }))}
      loading={list.isFetching}
      search={q}
      onSearch={setQ}
      emptyText={q ? "No company matches" : "No companies yet"}
      onChange={(id) => onChange(id, rows.find((c) => c.id === id) ?? null)}
    />
  );
}

/** The workspace's members (needs members.read; without it the list is empty and the current label still shows). */
export function useMembers() {
  const ws = useWorkspace();
  return useApiQuery<MembersResponse>(ws.key("members"), ws.can("members.read") ? ws.path("/members") : null, { staleTime: 60_000 });
}

/** Pick a teammate. `value` is a user id (owners and assignees are users, not memberships). */
export function MemberPicker({ onChange, ...props }: BaseProps & { onChange: (userId: string | null, member: Member | null) => void }) {
  const members = useMembers();
  const [q, setQ] = useState("");
  const rows = (members.data?.members ?? []).filter((m) => {
    const s = q.trim().toLowerCase();
    return !s || m.name.toLowerCase().includes(s) || m.email.toLowerCase().includes(s);
  });
  return (
    <EntityPicker
      placeholder="Choose a teammate"
      icon={<UserRound />}
      {...props}
      items={rows.map((m) => ({ id: m.userId, label: m.name || m.email, sublabel: m.email }))}
      loading={members.isPending}
      search={q}
      onSearch={setQ}
      emptyText="No teammate matches"
      onChange={(id) => onChange(id, rows.find((m) => m.userId === id) ?? null)}
    />
  );
}

export type CampaignSummary = { id: string; name: string; status: string; stepCount: number };

/** Search campaigns by name (GET /campaigns; needs campaigns.read — without it the list is empty and the current label still shows). */
export function CampaignPicker({
  onChange,
  statuses,
  ...props
}: BaseProps & {
  onChange: (id: string | null, campaign: CampaignSummary | null) => void;
  /** Only offer campaigns in these states (filtered locally; the API filters one status at a time). */
  statuses?: readonly string[];
}) {
  const ws = useWorkspace();
  const [q, setQ] = useState("");
  const list = useApiQuery<Paged<CampaignSummary>>(ws.key("campaigns", "picker"), ws.can("campaigns.read") ? ws.path("/campaigns") : null, {
    query: { pageSize: 50, sort: "updatedAt", q: q || undefined },
    keepPrevious: true,
  });
  const rows = (list.data?.items ?? []).filter((c) => !statuses || statuses.includes(c.status));
  // The chosen campaign may be outside the loaded page (or no longer exist): look it up for its label.
  const listed = list.data?.items.find((c) => c.id === props.value);
  const chosen = useApiQuery<CampaignSummary>(
    ws.key("campaigns", props.value, "label"),
    props.value && list.data && !listed && ws.can("campaigns.read") ? ws.path(`/campaigns/${props.value}`) : null,
    { staleTime: 5 * 60_000 },
  );
  const valueLabel = props.valueLabel ?? listed?.name ?? chosen.data?.name ?? (chosen.error?.isNotFound ? "A deleted campaign" : undefined);
  return (
    <EntityPicker
      placeholder="Choose a campaign"
      icon={<Send />}
      {...props}
      valueLabel={valueLabel}
      items={rows.map((c) => ({ id: c.id, label: c.name, sublabel: `${labelOf(c.status)} · ${c.stepCount} step${c.stepCount === 1 ? "" : "s"}` }))}
      loading={list.isFetching}
      search={q}
      onSearch={setQ}
      emptyText={q ? "No campaign matches" : "No campaigns yet"}
      onChange={(id) => onChange(id, rows.find((c) => c.id === id) ?? null)}
    />
  );
}
