"use client";

import { useState } from "react";
import { EntityPicker } from "@/components/pickers/Pickers";
import { useApiQuery } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import type { Paged } from "@/lib/types";
import type { Deal } from "@/lib/types/pipeline";

/**
 * Search deals by name (GET /deals?q=). Built on the shared EntityPicker so it
 * looks and behaves like ContactPicker. Without deals.read the list stays
 * empty and only the current label shows.
 */
export function DealPicker({
  value,
  valueLabel,
  onChange,
  placeholder = "Choose a deal",
  disabled,
  size,
  className,
  "aria-label": ariaLabel,
}: {
  value: string | null | undefined;
  valueLabel?: string | null;
  onChange: (id: string | null, deal: Deal | null) => void;
  placeholder?: string;
  disabled?: boolean;
  size?: "sm" | "md";
  className?: string;
  "aria-label"?: string;
}) {
  const ws = useWorkspace();
  const [q, setQ] = useState("");
  const list = useApiQuery<Paged<Deal>>(ws.key("deals", "picker"), ws.can("deals.read") ? ws.path("/deals") : null, {
    query: { pageSize: 20, q },
    keepPrevious: true,
  });
  const rows = list.data?.items ?? [];
  return (
    <EntityPicker
      value={value}
      valueLabel={valueLabel}
      placeholder={placeholder}
      disabled={disabled}
      size={size}
      className={className}
      aria-label={ariaLabel}
      items={rows.map((d) => ({ id: d.id, label: d.name, sublabel: [d.stage.name, d.contact?.fullName || d.company?.name].filter(Boolean).join(" · ") }))}
      loading={list.isFetching}
      search={q}
      onSearch={setQ}
      emptyText={q ? "No deal matches" : "No deals yet"}
      onChange={(id) => onChange(id, rows.find((d) => d.id === id) ?? null)}
    />
  );
}
