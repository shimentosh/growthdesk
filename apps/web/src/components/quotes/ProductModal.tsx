"use client";

import { useState, type FormEvent } from "react";
import { Package } from "lucide-react";
import { BILLING_PERIODS, type BillingPeriod } from "@growthdesk/shared";
import { formLevelError, useOpenKey } from "@/components/pipeline/utils";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Modal } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { IconTile } from "@/components/ui/IconTile";
import { Input, NativeSelect, Textarea } from "@/components/ui/Input";
import { useApiMutation } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import type { Product } from "@/lib/types/quotes";
import { periodLabel } from "./common";

const FIELDS = ["name", "sku", "description", "category", "groupName", "unit", "unitPrice", "costPrice", "currency", "billingPeriod", "taxRate"] as const;

type Draft = { name: string; sku: string; description: string; category: string; groupName: string; unit: string; unitPrice: string; costPrice: string; currency: string; billingPeriod: BillingPeriod; taxRate: string };

const draftOf = (p: Product | null, currency: string): Draft => ({
  name: p?.name ?? "",
  sku: p?.sku ?? "",
  description: p?.description ?? "",
  category: p?.category ?? "",
  groupName: p?.groupName ?? "",
  unit: p?.unit ?? "",
  unitPrice: p ? p.unitPrice : "",
  costPrice: p?.costPrice ?? "",
  currency: p?.currency ?? currency,
  billingPeriod: p?.billingPeriod ?? "one_time",
  taxRate: p ? p.taxRate : "0",
});

type Props = { open: boolean; onOpenChange: (open: boolean) => void; product: Product | null };

/**
 * Create or edit a catalogue product (products.manage). A product synced from
 * the client portal opens read-only: the next sync would overwrite any edit.
 */
export function ProductModal(props: Props) {
  const key = useOpenKey(props.open);
  return <Inner key={key} {...props} />;
}

function Inner({ open, onOpenChange, product }: Props) {
  const ws = useWorkspace();
  const f = useFormat();
  const [draft, setDraft] = useState<Draft>(() => draftOf(product, ws.currency));
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const synced = Boolean(product?.synced);
  const save = useApiMutation<Product, Record<string, unknown>>({
    method: product ? "PATCH" : "POST",
    path: product ? ws.path(`/products/${product.id}`) : ws.path("/products"),
    invalidate: [ws.key("products")],
    success: product ? "Product saved" : "Product added",
    errorToast: false,
    onSuccess: () => onOpenChange(false),
  });
  const fields = save.error?.fields ?? {};

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({
      name: draft.name.trim(),
      sku: draft.sku.trim(),
      description: draft.description.trim(),
      category: draft.category.trim(),
      groupName: draft.groupName.trim(),
      unit: draft.unit.trim(),
      unitPrice: draft.unitPrice.trim() || "0",
      costPrice: draft.costPrice.trim() || null,
      currency: draft.currency.trim().toUpperCase(),
      billingPeriod: draft.billingPeriod,
      taxRate: draft.taxRate.trim() || "0",
    });
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      dismissOnOutside={false}
      icon={<IconTile icon={<Package />} tint="brown" size="md" />}
      title={product ? product.name : "New product"}
      description={synced ? `Synced from the client portal${product?.syncedAt ? ` · ${f.relative(product.syncedAt)}` : ""}` : "Picking it on a quote line fills in its name, price, tax and billing period."}
      footer={
        synced ? (
          <Button onClick={() => onOpenChange(false)}>Close</Button>
        ) : (
          <>
            <Button onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button variant="primary" type="submit" form="product-form" loading={save.isPending} disabled={!draft.name.trim()}>
              {product ? "Save" : "Add product"}
            </Button>
          </>
        )
      }
    >
      <form id="product-form" onSubmit={submit} noValidate>
        <fieldset disabled={synced} className="flex flex-col gap-4">
          {synced && <Callout tone="info">This product is synced from the client portal; change it there. Quote lines can still use it like any product.</Callout>}
          <FormError error={formLevelError(save.error, FIELDS)} />
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_160px]">
            <Field label="Name" required error={fields.name}>
              <Input value={draft.name} maxLength={200} onChange={(e) => set("name", e.target.value)} placeholder="Website build" autoFocus={!product} />
            </Field>
            <Field label="SKU" error={fields.sku}>
              <Input value={draft.sku} maxLength={64} onChange={(e) => set("sku", e.target.value)} placeholder="WEB-01" className="font-mono" />
            </Field>
          </div>
          <Field label="Description" error={fields.description} hint="Printed under the line on the quote.">
            <Textarea rows={3} value={draft.description} maxLength={2000} onChange={(e) => set("description", e.target.value)} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Price" required error={fields.unitPrice}>
              <Input inputMode="decimal" value={draft.unitPrice} onChange={(e) => set("unitPrice", e.target.value)} placeholder="0.00" className="tabular-nums" />
            </Field>
            <Field label="Currency" error={fields.currency}>
              <Input value={draft.currency} maxLength={3} onChange={(e) => set("currency", e.target.value.toUpperCase())} className="font-mono uppercase" />
            </Field>
            <Field label="Billing" error={fields.billingPeriod}>
              <NativeSelect
                value={draft.billingPeriod}
                disabled={synced}
                onChange={(e) => set("billingPeriod", e.target.value as BillingPeriod)}
                options={BILLING_PERIODS.map((p) => ({ value: p, label: periodLabel(p) }))}
              />
            </Field>
            <Field label="Tax %" error={fields.taxRate}>
              <Input inputMode="decimal" value={draft.taxRate} onChange={(e) => set("taxRate", e.target.value)} placeholder="0" className="tabular-nums" />
            </Field>
            <Field label="Cost" error={fields.costPrice} hint="What one unit costs you; shows the margin.">
              <Input inputMode="decimal" value={draft.costPrice} onChange={(e) => set("costPrice", e.target.value)} placeholder="Optional" className="tabular-nums" />
            </Field>
            <Field label="Unit" error={fields.unit}>
              <Input value={draft.unit} maxLength={60} onChange={(e) => set("unit", e.target.value)} placeholder="hour, post…" />
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Group" error={fields.groupName} hint="Tiers of one offering share a group, e.g. “Guest Posts”.">
              <Input value={draft.groupName} maxLength={300} onChange={(e) => set("groupName", e.target.value)} />
            </Field>
            <Field label="Category" error={fields.category}>
              <Input value={draft.category} maxLength={120} onChange={(e) => set("category", e.target.value)} placeholder="Link building" />
            </Field>
          </div>
          {product && (product.details.turnaround || product.details.features.length > 0) && (
            <div className="rounded-md border border-line bg-well px-3 py-2.5 text-xs text-text-2">
              {product.details.turnaround && (
                <div>
                  <span className="text-text-3">Turnaround:</span> {product.details.turnaround}
                </div>
              )}
              {product.details.features.length > 0 && (
                <ul className="mt-1 list-disc pl-4">
                  {product.details.features.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </fieldset>
      </form>
    </Modal>
  );
}
