"use client";

import { useId, useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import { Checkbox } from "@/components/ui/Checkbox";
import { Input, NativeSelect } from "@/components/ui/Input";
import { Spinner } from "@/components/ui/Skeleton";
import { useMembers } from "@/components/pickers/Pickers";
import { useApiQuery } from "@/lib/query";
import { useWorkspace } from "@/lib/session";

/*
 * Small controls the workflow builder's action forms are made of: a duration
 * typed in minutes / hours / days but stored in minutes, a checklist of
 * teammates, and a tag list.
 */

type Unit = "minutes" | "hours" | "days";
const FACTOR: Record<Unit, number> = { minutes: 1, hours: 60, days: 1440 };

const unitFor = (minutes: number): Unit => (minutes > 0 && minutes % 1440 === 0 ? "days" : minutes > 0 && minutes % 60 === 0 ? "hours" : "minutes");

/**
 * A length of time, stored in whole minutes. `value` undefined is "not set"
 * (allowed when `optional`), which a blank box produces.
 */
export function DurationInput({
  value,
  onChange,
  optional,
  max,
  "aria-label": ariaLabel,
}: {
  value: number | undefined;
  onChange: (minutes: number | undefined) => void;
  optional?: boolean;
  /** In minutes. */
  max?: number;
  "aria-label"?: string;
}) {
  const [unit, setUnit] = useState<Unit>(() => unitFor(value ?? 0));
  // A value that does not divide evenly into the chosen unit shows in minutes rather than as a fraction.
  const shownUnit: Unit = value !== undefined && value % FACTOR[unit] !== 0 ? "minutes" : unit;
  const amount = value === undefined ? "" : String(value / FACTOR[shownUnit]);
  const emit = (text: string, u: Unit) => {
    if (text.trim() === "") return onChange(optional ? undefined : 0);
    const n = Math.max(0, Math.round(Number(text) * FACTOR[u]));
    onChange(Number.isFinite(n) ? (max !== undefined ? Math.min(n, max) : n) : optional ? undefined : 0);
  };
  return (
    <div className="flex gap-1.5">
      <div className="w-20 shrink-0">
        <Input
          inputMode="numeric"
          aria-label={ariaLabel ? `${ariaLabel} amount` : undefined}
          value={amount}
          placeholder={optional ? "—" : "0"}
          onChange={(e) => emit(e.target.value.replace(/\D/g, ""), shownUnit)}
        />
      </div>
      <div className="w-28 shrink-0">
        <NativeSelect
          aria-label={ariaLabel ? `${ariaLabel} unit` : undefined}
          value={shownUnit}
          onChange={(e) => {
            const u = e.target.value as Unit;
            setUnit(u);
            if (amount !== "") emit(amount, u);
          }}
          options={[
            { value: "minutes", label: "minutes" },
            { value: "hours", label: "hours" },
            { value: "days", label: "days" },
          ]}
        />
      </div>
    </div>
  );
}

/** Tick teammates (user ids). Needs members.read; without it, says so instead of showing an empty list. */
export function MemberChecklist({ value, onChange, emptyHint }: { value: string[]; onChange: (ids: string[]) => void; emptyHint?: string }) {
  const ws = useWorkspace();
  const members = useMembers();
  if (!ws.can("members.read")) {
    return <p className="text-xs text-text-3">Your role cannot list teammates{value.length ? ` (${value.length} chosen)` : ""}.</p>;
  }
  if (members.isPending) return <Spinner size="sm" label="Loading teammates" />;
  const rows = members.data?.members ?? [];
  const set = new Set(value);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="grid max-h-48 gap-1.5 overflow-y-auto rounded-sm border border-line p-2 sm:grid-cols-2">
        {rows.map((m) => (
          <Checkbox
            key={m.userId}
            checked={set.has(m.userId)}
            onCheckedChange={(on) => onChange(on ? [...value, m.userId] : value.filter((id) => id !== m.userId))}
            label={m.name || m.email}
            description={m.name ? m.email : undefined}
          />
        ))}
      </div>
      {emptyHint && !value.length && <p className="text-xs text-text-3">{emptyHint}</p>}
    </div>
  );
}

/** Tag names: type and press Enter (or comma). Suggests the workspace's existing tags. */
export function TagListInput({ value, onChange, invalid }: { value: string[]; onChange: (tags: string[]) => void; invalid?: boolean }) {
  const ws = useWorkspace();
  const listId = `tags${useId().replace(/:/g, "")}`;
  const [text, setText] = useState("");
  const tags = useApiQuery<{ id: string; name: string }[]>(ws.key("tags"), ws.can("contacts.read") ? ws.path("/tags") : null, { staleTime: 60_000 });
  const add = (raw: string) => {
    const name = raw.trim().slice(0, 50);
    if (!name || value.some((t) => t.toLowerCase() === name.toLowerCase()) || value.length >= 20) return;
    onChange([...value, name]);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      add(text);
      setText("");
    } else if (e.key === "Backspace" && !text && value.length) {
      onChange(value.slice(0, -1));
    }
  };
  return (
    <div className="flex flex-col gap-1.5">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((t) => (
            <span key={t} className="inline-flex h-6 items-center gap-1 rounded-xs bg-mute-chip pr-1 pl-2 text-xs text-text">
              {t}
              <button type="button" aria-label={`Remove ${t}`} onClick={() => onChange(value.filter((x) => x !== t))} className="rounded-xs p-0.5 text-text-3 hover:bg-hover hover:text-text">
                <X aria-hidden className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <Input
        list={listId}
        value={text}
        invalid={invalid}
        placeholder={value.length ? "Add another tag" : "Type a tag and press Enter"}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        onBlur={() => {
          if (text.trim()) {
            add(text);
            setText("");
          }
        }}
      />
      <datalist id={listId}>
        {(tags.data ?? [])
          .filter((t) => !value.includes(t.name))
          .map((t) => (
            <option key={t.id} value={t.name} />
          ))}
      </datalist>
    </div>
  );
}
