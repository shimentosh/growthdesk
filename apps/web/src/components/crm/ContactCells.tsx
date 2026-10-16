"use client";

import { labelOf, type ContactStatus, type Priority, type Qualification } from "@growthdesk/shared";
import { Avatar } from "@/components/ui/Avatar";
import { StatusBadge } from "@/components/ui/Badge";
import { cn } from "@/lib/cn";

/*
 * The people table's cells, in the same quiet style as the campaigns table:
 * states are the shared StatusBadge (a word on a light wash, no icons),
 * everything else is plain text. Colour only where a state means something.
 */

export function StatusChip({ value }: { value: ContactStatus | null | undefined }) {
  return <StatusBadge value={value} />;
}

/** Unqualified is where everyone starts, so it is plain muted text rather than a chip. */
export function QualificationChip({ value }: { value: Qualification | null | undefined }) {
  if (value === "unqualified") return <span className="text-xs text-text-3">{labelOf(value)}</span>;
  return <StatusBadge value={value} />;
}

/** Priority as a word; only urgent is a chip, since it asks for attention. */
export function PriorityIndicator({ value }: { value: Priority | null | undefined }) {
  if (!value) return <span className="text-text-3">—</span>;
  if (value === "urgent") return <StatusBadge value={value} />;
  return <span className={cn("whitespace-nowrap", value === "low" ? "text-text-3" : "text-text-2")}>{labelOf(value)}</span>;
}

/** 0–100 as a plain number. */
export function ScoreMeter({ value }: { value: number | null | undefined }) {
  if (value === null || value === undefined) return <span className="text-text-3">—</span>;
  return (
    <span className="text-text-2 tabular-nums" title={`Score ${value} of 100`}>
      {value}
    </span>
  );
}

export function OwnerCell({ owner }: { owner: { name: string; email?: string | null } | null | undefined }) {
  if (!owner) return <span className="text-text-3">Unassigned</span>;
  return (
    <span className="inline-flex max-w-full items-center gap-1.5">
      <Avatar size="xs" name={owner.name} email={owner.email} />
      <span className="truncate text-text-2">{owner.name}</span>
    </span>
  );
}

/** A company's initial on a neutral square, then its name. */
export function CompanyMark({ name, size = "sm" }: { name: string; size?: "sm" | "md" }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-[5px] bg-s-3 font-semibold text-text-3 uppercase",
        size === "sm" ? "size-5 text-[10px]" : "size-7 text-xs",
      )}
    >
      {name.trim().charAt(0) || "?"}
    </span>
  );
}
