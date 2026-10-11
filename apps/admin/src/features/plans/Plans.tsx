"use client";

import { useState, type FormEvent } from "react";
import { Pencil, Plus } from "lucide-react";
import { FEATURE_KEYS, FEATURE_LABELS, formatMoney, LIMIT_KEYS, LIMIT_LABELS, type FeatureKey, type LimitKey } from "@growthdesk/shared";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Checkbox } from "@/components/ui/Checkbox";
import { Modal } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { QueryState } from "@/components/ui/ErrorState";
import { Field, FormError } from "@/components/ui/Field";
import { Input, Textarea } from "@/components/ui/Input";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { SkeletonText } from "@/components/ui/Skeleton";
import { cn } from "@/lib/cn";
import { formatNumber } from "@/lib/format";
import { useApiMutation, useApiQuery } from "@/lib/query";
import type { AdminPlan } from "@/features/common/types";
import { platformEmpty, PlatformTile, platformKey, table, usePlatform } from "@/features/common/platform";

/*
 * Plans (docs/BILLING.md): prices, trial, limits, features and the payment
 * provider's price ids. The amounts here are what customers are shown; what
 * checkout charges is the provider price the id points at, so keep the two
 * in step.
 */

type Draft = {
  key: string;
  name: string;
  description: string;
  isActive: boolean;
  isPublic: boolean;
  sortOrder: string;
  currency: string;
  monthly: string;
  annual: string;
  trialDays: string;
  limits: Record<LimitKey, string>;
  features: Record<FeatureKey, boolean>;
  stripeMonth: string;
  stripeYear: string;
};

const toMajor = (cents: number) => (cents / 100).toFixed(2).replace(/\.00$/, "");
const toCents = (major: string) => Math.round(Number(major || "0") * 100);

function draftOf(p: AdminPlan | null): Draft {
  return {
    key: p?.key ?? "",
    name: p?.name ?? "",
    description: p?.description ?? "",
    isActive: p?.isActive ?? true,
    isPublic: p?.isPublic ?? true,
    sortOrder: String(p?.sortOrder ?? 0),
    currency: p?.currency ?? "USD",
    monthly: p ? toMajor(p.monthlyPriceCents) : "0",
    annual: p ? toMajor(p.annualPriceCents) : "0",
    trialDays: String(p?.trialDays ?? 0),
    limits: Object.fromEntries(LIMIT_KEYS.map((k) => [k, String(p?.limits[k] ?? 0)])) as Record<LimitKey, string>,
    features: Object.fromEntries(FEATURE_KEYS.map((k) => [k, p?.features[k] ?? false])) as Record<FeatureKey, boolean>,
    stripeMonth: p?.providerPrices?.stripe?.month ?? "",
    stripeYear: p?.providerPrices?.stripe?.year ?? "",
  };
}

function PlanDialog({ plan, open, onOpenChange }: { plan: AdminPlan | null; open: boolean; onOpenChange: (v: boolean) => void }) {
  const [d, setD] = useState<Draft>(() => draftOf(plan));
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((prev) => ({ ...prev, [k]: v }));
  const save = useApiMutation<AdminPlan, Record<string, unknown>>({
    method: plan ? "PUT" : "POST",
    path: plan ? `/admin/plans/${plan.key}` : "/admin/plans",
    invalidate: [platformKey("plans"), platformKey("settings")],
    success: plan ? "Plan saved" : "Plan created",
    errorToast: false,
    onSuccess: () => onOpenChange(false),
  });
  const fields = save.error?.fields ?? {};

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body: Record<string, unknown> = {
      name: d.name.trim(),
      description: d.description.trim(),
      isActive: d.isActive,
      isPublic: d.isPublic,
      sortOrder: Number(d.sortOrder || "0"),
      currency: d.currency.trim().toUpperCase(),
      monthlyPriceCents: toCents(d.monthly),
      annualPriceCents: toCents(d.annual),
      trialDays: Number(d.trialDays || "0"),
      limits: Object.fromEntries(LIMIT_KEYS.map((k) => [k, Number(d.limits[k] || "0")])),
      features: d.features,
      providerPrices: { stripe: { month: d.stripeMonth.trim(), year: d.stripeYear.trim() } },
    };
    if (!plan) body.key = d.key.trim();
    save.mutate(body);
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      size="xl"
      dismissOnOutside={false}
      title={plan ? `Edit ${plan.name}` : "New plan"}
      description={plan ? `Key "${plan.key}" — subscriptions refer to it, so it cannot change.` : "The key is permanent: subscriptions and settings refer to it."}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="plan-form" loading={save.isPending}>
            {plan ? "Save plan" : "Create plan"}
          </Button>
        </>
      }
    >
      <form id="plan-form" onSubmit={submit} className="flex flex-col gap-5">
        <FormError error={save.error && (!Object.keys(fields).length || fields.limits || fields.features || fields.providerPrices) ? save.error.message : null} />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {!plan && (
            <Field label="Key" error={fields.key} hint="Lower-case letters, digits, - and _">
              <Input value={d.key} onChange={(e) => set("key", e.target.value)} placeholder="e.g. enterprise" />
            </Field>
          )}
          <Field label="Name" error={fields.name}>
            <Input value={d.name} onChange={(e) => set("name", e.target.value)} />
          </Field>
          <Field label="Sort order" error={fields.sortOrder}>
            <Input type="number" value={d.sortOrder} onChange={(e) => set("sortOrder", e.target.value)} />
          </Field>
        </div>
        <Field label="Description" error={fields.description}>
          <Textarea rows={2} value={d.description} onChange={(e) => set("description", e.target.value)} maxLength={500} />
        </Field>
        <div className="flex flex-wrap gap-6">
          <Checkbox checked={d.isActive} onCheckedChange={(v) => set("isActive", v)} label="Active" description="Can be chosen and assigned." />
          <Checkbox checked={d.isPublic} onCheckedChange={(v) => set("isPublic", v)} label="Public" description="Listed on the customer's billing page." />
        </div>

        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Field label="Currency" error={fields.currency}>
            <Input value={d.currency} onChange={(e) => set("currency", e.target.value)} maxLength={3} />
          </Field>
          <Field label="Monthly price" error={fields.monthlyPriceCents}>
            <Input type="number" min={0} step="0.01" value={d.monthly} onChange={(e) => set("monthly", e.target.value)} />
          </Field>
          <Field label="Annual price" error={fields.annualPriceCents}>
            <Input type="number" min={0} step="0.01" value={d.annual} onChange={(e) => set("annual", e.target.value)} />
          </Field>
          <Field label="Trial days" error={fields.trialDays}>
            <Input type="number" min={0} max={365} value={d.trialDays} onChange={(e) => set("trialDays", e.target.value)} />
          </Field>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Stripe monthly price id" hint="Must charge the monthly price above.">
            <Input value={d.stripeMonth} onChange={(e) => set("stripeMonth", e.target.value)} placeholder="price_…" className="font-mono" />
          </Field>
          <Field label="Stripe annual price id" hint="Must charge the annual price above.">
            <Input value={d.stripeYear} onChange={(e) => set("stripeYear", e.target.value)} placeholder="price_…" className="font-mono" />
          </Field>
        </div>

        <fieldset>
          <legend className="mb-2 text-xs font-medium text-text-2">Limits (−1 = unlimited)</legend>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {LIMIT_KEYS.map((k) => (
              <Field key={k} label={LIMIT_LABELS[k]}>
                <Input type="number" min={-1} value={d.limits[k]} onChange={(e) => set("limits", { ...d.limits, [k]: e.target.value })} />
              </Field>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend className="mb-2 text-xs font-medium text-text-2">Features</legend>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {FEATURE_KEYS.map((k) => (
              <Checkbox key={k} checked={d.features[k]} onCheckedChange={(v) => set("features", { ...d.features, [k]: v })} label={FEATURE_LABELS[k]} />
            ))}
          </div>
        </fieldset>
      </form>
    </Modal>
  );
}

/** /plans */
export function Plans() {
  const { canChange } = usePlatform();
  const q = useApiQuery<AdminPlan[]>(platformKey("plans"), "/admin/plans");
  const [editing, setEditing] = useState<AdminPlan | "new" | null>(null);

  return (
    <Page>
      <PageHeader
        icon={<PlatformTile of="plans" />}
        title="Plans"
        description="What each plan costs and allows. Limits are enforced for every account on the plan as soon as it is saved."
        actions={
          canChange && (
            <Button variant="primary" icon={<Plus />} onClick={() => setEditing("new")}>
              New plan
            </Button>
          )
        }
      />
      <QueryState
        query={q}
        loading={<SkeletonText lines={6} />}
        isEmpty={(d) => d.length === 0}
        empty={
          <Card>
            <EmptyState {...platformEmpty("plans")} title="No plans" description="Run the seed (pnpm db:seed) or create one." />
          </Card>
        }
      >
        {(plans) => (
          <Card className="overflow-hidden">
            <div className={table.wrap}>
              <table className={table.table}>
                <thead>
                  <tr>
                    <th className={table.th}>Plan</th>
                    <th className={table.th}>Monthly</th>
                    <th className={table.th}>Annual</th>
                    <th className={table.th}>Trial</th>
                    <th className={table.th}>Stripe prices</th>
                    <th className={table.th}>Subscriptions</th>
                    <th className={table.th} />
                  </tr>
                </thead>
                <tbody>
                  {plans.map((p) => (
                    <tr key={p.id} className="hover:bg-hover">
                      <td className={cn(table.td, "max-w-80")}>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-medium">{p.name}</span>
                          <span className="font-mono text-xs text-text-3">{p.key}</span>
                          {!p.isActive && <Badge tone="bad">Inactive</Badge>}
                          {!p.isPublic && <Badge>Hidden</Badge>}
                          {p.isDefault && <Badge tone="info">New workspaces</Badge>}
                          {p.isExpiredFallback && <Badge tone="warn">Lapsed fallback</Badge>}
                        </div>
                        {p.description && <div className="truncate text-xs text-text-3">{p.description}</div>}
                      </td>
                      <td className={cn(table.td, "tabular-nums")}>{formatMoney(p.monthlyPriceCents, p.currency)}</td>
                      <td className={cn(table.td, "tabular-nums")}>{formatMoney(p.annualPriceCents, p.currency)}</td>
                      <td className={cn(table.td, "tabular-nums")}>{p.trialDays ? `${p.trialDays} days` : "—"}</td>
                      <td className={cn(table.td, "text-xs")}>
                        {p.providerPrices?.stripe?.month || p.providerPrices?.stripe?.year ? (
                          <span className="text-text-2">
                            {[p.providerPrices.stripe?.month && "Monthly", p.providerPrices.stripe?.year && "Annual"].filter(Boolean).join(" · ")}
                          </span>
                        ) : (
                          <span className="text-text-3">Not set</span>
                        )}
                      </td>
                      <td className={cn(table.td, "tabular-nums")}>{formatNumber(p.subscriptions)}</td>
                      <td className={cn(table.td, "text-right")}>
                        {canChange && (
                          <Button size="sm" variant="ghost" icon={<Pencil />} onClick={() => setEditing(p)}>
                            Edit
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </QueryState>
      {editing && (
        <PlanDialog
          key={editing === "new" ? "new" : editing.key}
          plan={editing === "new" ? null : editing}
          open
          onOpenChange={(v) => !v && setEditing(null)}
        />
      )}
    </Page>
  );
}
