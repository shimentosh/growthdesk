"use client";

import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { BILLING_PERIODS, fromUnits, type BillingPeriod, type QuoteTotals } from "@growthdesk/shared";
import { Button, IconButton } from "@/components/ui/Button";
import { Input, NativeSelect, Textarea } from "@/components/ui/Input";
import { cn } from "@/lib/cn";
import type { Product } from "@/lib/types/quotes";
import { money, periodLabel, periodSuffix } from "./common";
import { ProductPicker } from "./pickers";

/** One line as the editor holds it: decimal text exactly as typed, sent to the API as is. */
export type LineDraft = {
  key: string;
  productId: string | null;
  name: string;
  description: string;
  quantity: string;
  unitPrice: string;
  discountPercent: string;
  taxRate: string;
  billingPeriod: BillingPeriod;
};

let seq = 0;
export const lineKey = () => `l${++seq}`;

export const blankLine = (): LineDraft => ({ key: lineKey(), productId: null, name: "", description: "", quantity: "1", unitPrice: "", discountPercent: "0", taxRate: "0", billingPeriod: "one_time" });

/** A catalogue product copied into a line: the line keeps its own copy, so later product edits never change the quote. */
export const lineFromProduct = (p: Product): LineDraft => ({
  key: lineKey(),
  productId: p.id,
  name: p.name,
  description: p.description,
  quantity: "1",
  unitPrice: p.unitPrice,
  discountPercent: "0",
  taxRate: p.taxRate,
  billingPeriod: p.billingPeriod,
});

const NUM = "h-7 px-2 text-right text-xs tabular-nums";

/**
 * The quote's lines: pick from the catalogue or type one in, then quantity,
 * price, discount, tax and billing period per line; reorder with the arrows.
 * Amounts are computed live with the same rules the API stores
 * (packages/shared/src/quotes.ts), so the preview never disagrees with the
 * saved quote. `errors` maps "lineItems.<i>.<field>" to the API's message.
 */
export function LineItemsEditor({
  lines,
  onChange,
  totals,
  currency,
  disabled,
  errors = {},
}: {
  lines: LineDraft[];
  onChange: (lines: LineDraft[]) => void;
  totals: QuoteTotals;
  currency: string;
  disabled?: boolean;
  errors?: Record<string, string>;
}) {
  const patch = (i: number, p: Partial<LineDraft>) => onChange(lines.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const move = (i: number, by: -1 | 1) => {
    const next = [...lines];
    const [l] = next.splice(i, 1);
    next.splice(i + by, 0, l!);
    onChange(next);
  };
  const err = (i: number, field: string) => errors[`lineItems.${i}.${field}`];

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[820px] border-collapse text-sm">
          <thead className="border-b border-line text-xs text-text-3">
            <tr>
              <th scope="col" className="py-2 pr-2 text-left font-medium">
                Item
              </th>
              <th scope="col" className="w-20 px-1 py-2 text-right font-medium">
                Qty
              </th>
              <th scope="col" className="w-28 px-1 py-2 text-right font-medium">
                Price
              </th>
              <th scope="col" className="w-20 px-1 py-2 text-right font-medium">
                Disc. %
              </th>
              <th scope="col" className="w-20 px-1 py-2 text-right font-medium">
                Tax %
              </th>
              <th scope="col" className="w-32 px-1 py-2 text-left font-medium">
                Billing
              </th>
              <th scope="col" className="w-28 px-1 py-2 text-right font-medium">
                Amount
              </th>
              <th scope="col" className="w-24 py-2 pl-1">
                <span className="sr-only">Arrange</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {lines.map((l, i) => {
              const a = totals.lines[i];
              return (
                <tr key={l.key} className="align-top">
                  <td className="py-2 pr-2">
                    <Input size="sm" value={l.name} maxLength={200} invalid={Boolean(err(i, "name"))} aria-label={`Line ${i + 1} name`} placeholder="Item name" onChange={(e) => patch(i, { name: e.target.value })} />
                    <Textarea
                      rows={1}
                      value={l.description}
                      maxLength={2000}
                      aria-label={`Line ${i + 1} description`}
                      placeholder="Description (optional)"
                      onChange={(e) => patch(i, { description: e.target.value })}
                      className="mt-1 min-h-7 py-1 text-xs"
                    />
                    {(err(i, "name") || err(i, "quantity") || err(i, "unitPrice") || err(i, "discountPercent") || err(i, "taxRate")) && (
                      <p className="mt-1 text-xs text-bad-ink">{err(i, "name") ?? err(i, "quantity") ?? err(i, "unitPrice") ?? err(i, "discountPercent") ?? err(i, "taxRate")}</p>
                    )}
                  </td>
                  <td className="px-1 py-2">
                    <Input size="sm" inputMode="decimal" value={l.quantity} invalid={Boolean(err(i, "quantity"))} aria-label={`Line ${i + 1} quantity`} onChange={(e) => patch(i, { quantity: e.target.value })} className={NUM} />
                  </td>
                  <td className="px-1 py-2">
                    <Input size="sm" inputMode="decimal" value={l.unitPrice} invalid={Boolean(err(i, "unitPrice"))} aria-label={`Line ${i + 1} price`} placeholder="0.00" onChange={(e) => patch(i, { unitPrice: e.target.value })} className={NUM} />
                  </td>
                  <td className="px-1 py-2">
                    <Input size="sm" inputMode="decimal" value={l.discountPercent} invalid={Boolean(err(i, "discountPercent"))} aria-label={`Line ${i + 1} discount percent`} onChange={(e) => patch(i, { discountPercent: e.target.value })} className={NUM} />
                  </td>
                  <td className="px-1 py-2">
                    <Input size="sm" inputMode="decimal" value={l.taxRate} invalid={Boolean(err(i, "taxRate"))} aria-label={`Line ${i + 1} tax percent`} onChange={(e) => patch(i, { taxRate: e.target.value })} className={NUM} />
                  </td>
                  <td className="px-1 py-2">
                    <NativeSelect
                      size="sm"
                      aria-label={`Line ${i + 1} billing`}
                      value={l.billingPeriod}
                      disabled={disabled}
                      onChange={(e) => patch(i, { billingPeriod: e.target.value as BillingPeriod })}
                      options={BILLING_PERIODS.map((p) => ({ value: p, label: periodLabel(p) }))}
                    />
                  </td>
                  <td className="px-1 py-2 pt-3.5 text-right text-xs whitespace-nowrap text-text tabular-nums">
                    {a ? `${money(fromUnits(a.net), currency)}${periodSuffix(l.billingPeriod)}` : "—"}
                    {a && a.discount !== 0 && <span className="block text-2xs text-text-3">−{money(fromUnits(a.discount), currency)}</span>}
                  </td>
                  <td className="py-2 pl-1">
                    {!disabled && (
                      <div className="flex justify-end gap-0.5">
                        <IconButton size="sm" label="Move up" icon={<ArrowUp />} disabled={i === 0} onClick={() => move(i, -1)} />
                        <IconButton size="sm" label="Move down" icon={<ArrowDown />} disabled={i === lines.length - 1} onClick={() => move(i, 1)} />
                        <IconButton size="sm" label="Remove line" icon={<Trash2 />} onClick={() => onChange(lines.filter((_, j) => j !== i))} />
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
            {!lines.length && (
              <tr>
                <td colSpan={8} className={cn("py-6 text-center text-sm text-text-3")}>
                  No lines yet. Add one from the catalogue, or type one in.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {!disabled && (
        <div className="flex flex-wrap items-center gap-2">
          <ProductPicker onPick={(p) => onChange([...lines, lineFromProduct(p)])} />
          <Button size="sm" icon={<Plus />} onClick={() => onChange([...lines, blankLine()])}>
            Custom line
          </Button>
        </div>
      )}
    </div>
  );
}
