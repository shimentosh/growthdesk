"use client";

import { useState } from "react";
import { Handshake, Package } from "lucide-react";
import { EntityPicker } from "@/components/pickers/Pickers";
import { useApiQuery } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import type { Paged } from "@/lib/types";
import type { Product } from "@/lib/types/quotes";
import { money, periodSuffix } from "./common";

/** A deal as GET /deals lists it (the fields the quote editor reads). */
export type DealOption = {
  id: string;
  name: string;
  value: number;
  currency: string;
  contact: { id: string; fullName: string; email: string | null } | null;
  company: { id: string; name: string } | null;
  owner: { id: string; name: string } | null;
};

/** Search open deals by name (GET /deals; needs deals.read — without it the list is empty and the current label still shows). */
export function DealPicker({ value, valueLabel, onChange, disabled }: { value: string | null; valueLabel?: string | null; onChange: (id: string | null, deal: DealOption | null) => void; disabled?: boolean }) {
  const ws = useWorkspace();
  const [q, setQ] = useState("");
  const list = useApiQuery<Paged<DealOption>>(ws.key("deals", "picker"), ws.can("deals.read") ? ws.path("/deals") : null, { query: { q: q || undefined, pageSize: 20 }, keepPrevious: true });
  const rows = list.data?.items ?? [];
  return (
    <EntityPicker
      placeholder="No deal"
      icon={<Handshake />}
      value={value}
      valueLabel={valueLabel}
      disabled={disabled}
      items={rows.map((d) => ({ id: d.id, label: d.name, sublabel: [d.contact?.fullName, d.company?.name].filter(Boolean).join(" · ") || null }))}
      loading={list.isFetching}
      search={q}
      onSearch={setQ}
      emptyText={q ? "No deal matches" : "No deals yet"}
      onChange={(id) => onChange(id, rows.find((d) => d.id === id) ?? null)}
    />
  );
}

/** Pick an active catalogue product; the caller copies it into a line. */
export function ProductPicker({ onPick, disabled }: { onPick: (p: Product) => void; disabled?: boolean }) {
  const ws = useWorkspace();
  const [q, setQ] = useState("");
  const list = useApiQuery<Paged<Product>>(ws.key("products", "picker"), ws.path("/products"), { query: { q: q || undefined, state: "active", pageSize: 50 }, keepPrevious: true });
  const rows = list.data?.items ?? [];
  return (
    <EntityPicker
      placeholder="Add from catalogue…"
      icon={<Package />}
      value={null}
      clearable={false}
      size="sm"
      disabled={disabled}
      className="w-full sm:w-72"
      items={rows.map((p) => ({
        id: p.id,
        label: p.name,
        sublabel: [p.groupName, `${money(p.unitPrice, p.currency)}${periodSuffix(p.billingPeriod)}`, p.synced ? "synced" : ""].filter(Boolean).join(" · "),
      }))}
      loading={list.isFetching}
      search={q}
      onSearch={setQ}
      emptyText={q ? "No product matches" : "The catalogue is empty — add products under Sales → Products"}
      onChange={(id) => {
        const p = rows.find((x) => x.id === id);
        if (p) onPick(p);
      }}
    />
  );
}
