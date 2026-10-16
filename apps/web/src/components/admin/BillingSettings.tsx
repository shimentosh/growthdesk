"use client";

import { useState, type FormEvent } from "react";
import { useSearchParams } from "next/navigation";
import { BadgeCheck, Check, CircleX, CreditCard, ExternalLink, FileText, Gauge, Landmark, Layers, Receipt, Undo2 } from "lucide-react";
import {
  FEATURE_KEYS,
  FEATURE_LABELS,
  formatMoney,
  isUnlimited,
  LIMIT_KEYS,
  LIMIT_LABELS,
  readFeatures,
  readLimits,
  type BillingInterval,
} from "@growthdesk/shared";
import { Badge, StatusBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/Card";
import { COL, ColumnLabel } from "@/components/ui/columns";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { QueryState } from "@/components/ui/ErrorState";
import { Field, FormError } from "@/components/ui/Field";
import { EntityTile } from "@/components/ui/icons";
import { Input, Textarea } from "@/components/ui/Input";
import { KeyValueList, type KeyValueItem } from "@/components/ui/KeyValue";
import { Meter } from "@/components/ui/Meter";
import { PageHeader } from "@/components/ui/PageHeader";
import { RequirePermission } from "@/components/ui/RequirePermission";
import { SkeletonText } from "@/components/ui/Skeleton";
import { toast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";
import { daysUntil, formatNumber } from "@/lib/format";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace, workspaceDetailKey } from "@/lib/session";
import type { BillingOverview, CancelResult, CheckoutResult, PublicPlan } from "@/lib/types/admin";
import { countryName, table } from "./labels";

/*
 * Plan & billing. A plan only ever changes when the payment provider's
 * webhook says so (docs/BILLING.md), so after checkout, a switch or a
 * cancellation this page says "requested" and waits for the provider rather
 * than pretending the change has happened.
 */

type Sub = NonNullable<BillingOverview["subscription"]>;

const LIVE_STATES = ["trialing", "active", "past_due", "incomplete"];

const providerLabel = (provider: string) =>
  provider === "none" ? "None yet" : provider === "manual" ? "Invoiced by arrangement" : provider.charAt(0).toUpperCase() + provider.slice(1);

const usesProvider = (sub: Sub | null) => Boolean(sub && sub.provider !== "none" && sub.provider !== "manual");

function CurrentPlan({ data }: { data: BillingOverview }) {
  const ws = useWorkspace();
  const f = useFormat();
  const canManage = ws.can("billing.manage");
  const sub = data.subscription;
  const [confirm, setConfirm] = useState<"cancel" | "resume" | null>(null);
  const keys = [ws.key("billing"), workspaceDetailKey(ws.id)];

  const portal = useApiMutation<{ url: string }>({
    path: ws.path("/billing/portal"),
    onSuccess: (r) => window.location.assign(r.url),
  });
  const cancel = useApiMutation<CancelResult>({
    path: ws.path("/billing/cancel"),
    invalidate: keys,
    errorToast: false,
    success: (r) => (r.pending ? "Cancellation requested. It shows here once the payment provider confirms it." : "Subscription ended"),
  });
  const resume = useApiMutation<CancelResult>({
    path: ws.path("/billing/resume"),
    invalidate: keys,
    errorToast: false,
    success: "Resume requested. It shows here once the payment provider confirms it.",
  });

  const trialDays = sub?.status === "trialing" ? daysUntil(sub.trialEndsAt) : null;
  const items: KeyValueItem[] = [
    { label: "Status", value: sub ? <StatusBadge value={sub.status} /> : <Badge>No subscription</Badge> },
  ];
  if (data.plan.key !== data.effectivePlan.key) items.push({ label: "Subscribed plan", value: data.plan.name, hint: `Not in effect — the ${data.effectivePlan.name} allowance applies.` });
  if (sub?.status === "trialing" && sub.trialEndsAt) {
    items.push({
      label: "Trial ends",
      value: f.date(sub.trialEndsAt),
      hint: trialDays !== null ? (trialDays > 0 ? `${trialDays} ${trialDays === 1 ? "day" : "days"} left` : "Ended") : undefined,
    });
  }
  if (sub && (sub.managedByProvider || sub.provider === "manual")) items.push({ label: "Billing interval", value: sub.interval === "year" ? "Yearly" : "Monthly" });
  if (sub?.currentPeriodEnd) items.push({ label: sub.cancelAtPeriodEnd ? "Ends on" : "Renews on", value: f.date(sub.currentPeriodEnd) });
  if (sub?.status === "past_due" && sub.graceUntil) items.push({ label: "Full access until", value: f.date(sub.graceUntil) });
  if (sub) items.push({ label: "Payment", value: providerLabel(sub.provider) });

  const canCancel = sub && LIVE_STATES.includes(sub.status) && !sub.cancelAtPeriodEnd;
  const canResume = sub?.managedByProvider && sub.cancelAtPeriodEnd && LIVE_STATES.includes(sub.status);

  return (
    <Card>
      <CardHeader
        icon={<BadgeCheck />}
        title="Current plan"
        description="One subscription covers every workspace on this billing account."
        actions={
          canManage && usesProvider(sub) ? (
            <Button size="sm" icon={<CreditCard />} loading={portal.isPending} onClick={() => portal.mutate()}>
              Payment methods & invoices
            </Button>
          ) : undefined
        }
      />
      <CardBody className="flex flex-col gap-4">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-2xl font-semibold tracking-[-0.02em] text-text-hi">{data.effectivePlan.name}</span>
          <span className="text-sm text-text-3">plan</span>
          {data.access === "restricted" && <Badge tone="bad">Restricted</Badge>}
        </div>
        {data.reason && (
          <Callout tone={data.access === "restricted" ? "bad" : "warn"}>{data.reason}</Callout>
        )}
        {sub?.cancelAtPeriodEnd && (
          <Callout tone="warn" title="Cancellation scheduled">
            {sub.currentPeriodEnd ? `The plan stays active until ${f.date(sub.currentPeriodEnd)}.` : "The plan stays active until the end of the billing period."} After that the free
            allowance applies. Nothing is deleted.
          </Callout>
        )}
        <KeyValueList items={items} />
      </CardBody>
      {canManage && (canCancel || canResume) && (
        <CardFooter>
          {canResume && (
            <Button variant="primary" icon={<Undo2 />} loading={resume.isPending} onClick={() => setConfirm("resume")}>
              Keep my subscription
            </Button>
          )}
          {canCancel && (
            <Button variant="danger" icon={<CircleX />} onClick={() => setConfirm("cancel")}>
              Cancel subscription
            </Button>
          )}
        </CardFooter>
      )}
      <ConfirmDialog
        open={confirm === "cancel"}
        onOpenChange={(open) => !open && setConfirm(null)}
        title="Cancel the subscription?"
        description={
          sub?.managedByProvider
            ? `It stays active until the end of the current billing period${sub.currentPeriodEnd ? ` (${f.date(sub.currentPeriodEnd)})` : ""}, then the free allowance applies. Nothing is deleted, and you can resume before then.`
            : "It ends now and the free allowance applies straight away. Nothing is deleted; choose a plan any time to restore your limits."
        }
        confirmLabel="Cancel subscription"
        cancelLabel="Keep it"
        onConfirm={() => cancel.mutateAsync()}
      />
      <ConfirmDialog
        open={confirm === "resume"}
        onOpenChange={(open) => !open && setConfirm(null)}
        tone="default"
        title="Keep the subscription?"
        description="The scheduled cancellation is withdrawn and the plan renews as normal."
        confirmLabel="Keep subscription"
        onConfirm={() => resume.mutateAsync()}
      />
    </Card>
  );
}

function Usage({ data }: { data: BillingOverview }) {
  return (
    <Card>
      <CardHeader
        icon={<Gauge />}
        title="Usage"
        description={`${data.scope === "account" ? "Counted across every workspace on this billing account." : "Counted in this workspace; the plan's limits are shared by every workspace on the account."} Monthly allowances restart on ${new Date(data.meterResetsAt).toLocaleDateString(undefined, { month: "long", day: "numeric", timeZone: "UTC" })}.`}
      />
      <CardBody className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
        {LIMIT_KEYS.map((key) => {
          const u = data.usage[key];
          if (!u) return null;
          return <Meter key={key} label={u.label || LIMIT_LABELS[key]} value={u.used} max={u.limit} />;
        })}
      </CardBody>
    </Card>
  );
}

const limitText = (n: number) => (isUnlimited(n) ? "Unlimited" : formatNumber(n));

function PlanCard({
  plan,
  interval,
  data,
  onChoose,
  pending,
}: {
  plan: PublicPlan;
  interval: BillingInterval;
  data: BillingOverview;
  onChoose: (plan: PublicPlan) => void;
  pending: boolean;
}) {
  const ws = useWorkspace();
  const sub = data.subscription;
  const cents = interval === "year" ? plan.annualPriceCents : plan.monthlyPriceCents;
  const limits = readLimits(plan.limits);
  const features = readFeatures(plan.features);
  const included = FEATURE_KEYS.filter((k) => features[k]);
  const live = sub && LIVE_STATES.includes(sub.status);
  const isEffective = plan.key === data.effectivePlan.key;
  // Paying for exactly this plan and interval through the provider: nothing to buy.
  const isCurrent = Boolean(live && sub?.managedByProvider && plan.key === data.plan.key && sub.interval === interval);
  const switching = Boolean(live && sub?.managedByProvider && usesProvider(sub));
  const canBuy = ws.can("billing.manage") && data.payments.available;

  return (
    <div className={cn("flex min-w-0 flex-col rounded-lg border bg-panel p-4", isEffective ? "border-accent" : "border-line")}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-text-hi">{plan.name}</h3>
        {isEffective && <Badge tone="live">Your plan</Badge>}
      </div>
      {plan.description && <p className="mt-1 text-xs text-text-3">{plan.description}</p>}
      <div className="mt-3">
        {cents > 0 ? (
          <>
            <span className="text-2xl font-semibold tracking-[-0.02em] text-text-hi tabular-nums">{formatMoney(cents, plan.currency)}</span>
            <span className="ml-1 text-xs text-text-3">/ {interval === "year" ? "year" : "month"}</span>
            {interval === "year" && <div className="text-xs text-text-3">{formatMoney(Math.round(cents / 12), plan.currency)} a month, billed yearly</div>}
          </>
        ) : (
          <span className="text-2xl font-semibold tracking-[-0.02em] text-text-hi">{plan.monthlyPriceCents === 0 && plan.annualPriceCents === 0 ? "Free" : "—"}</span>
        )}
        {plan.trialDays > 0 && <div className="text-xs text-text-3">{plan.trialDays}-day trial for new accounts</div>}
      </div>
      <ul className="mt-3 flex flex-col gap-1 text-xs text-text-2">
        {LIMIT_KEYS.map((k) => (
          <li key={k} className="flex justify-between gap-2">
            <span className="truncate">{LIMIT_LABELS[k]}</span>
            <span className="shrink-0 text-text tabular-nums">{limitText(limits[k])}</span>
          </li>
        ))}
      </ul>
      {included.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1 border-t border-line pt-3 text-xs text-text-2">
          {included.map((k) => (
            <li key={k} className="flex items-start gap-1.5">
              <Check aria-hidden className="mt-0.5 size-3 shrink-0 text-ok" />
              {FEATURE_LABELS[k]}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-auto pt-4">
        {isCurrent ? (
          <Button className="w-full" disabled>
            Current plan
          </Button>
        ) : cents > 0 ? (
          <Button className="w-full" variant={isEffective ? "primary" : "secondary"} disabled={!canBuy} loading={pending} onClick={() => onChoose(plan)}>
            {switching ? `Switch to ${plan.name}` : isEffective ? `Subscribe to ${plan.name}` : `Choose ${plan.name}`}
          </Button>
        ) : (
          <p className="text-center text-xs text-text-3">{cents === 0 && plan.monthlyPriceCents + plan.annualPriceCents > 0 ? `No ${interval === "year" ? "yearly" : "monthly"} price` : "No payment needed"}</p>
        )}
      </div>
    </div>
  );
}

function Plans({ data }: { data: BillingOverview }) {
  const ws = useWorkspace();
  const sub = data.subscription;
  const [interval, setBillingInterval] = useState<BillingInterval>(sub?.interval ?? "month");
  const [choosing, setChoosing] = useState<PublicPlan | null>(null);
  const checkout = useApiMutation<CheckoutResult, { planKey: string; interval: BillingInterval }>({
    path: ws.path("/billing/checkout"),
    invalidate: (r) => (r.changed ? [ws.key("billing"), workspaceDetailKey(ws.id)] : []),
    onSuccess: (r) => {
      if (r.changed) toast.success("Plan change requested", { description: "It shows here once the payment provider confirms it, usually within a minute." });
      else window.location.assign(r.url);
    },
  });
  const switching = Boolean(sub?.managedByProvider && LIVE_STATES.includes(sub.status));

  const choose = (plan: PublicPlan) => {
    if (switching) setChoosing(plan);
    else checkout.mutate({ planKey: plan.key, interval });
  };

  return (
    <Card>
      <CardHeader
        icon={<Layers />}
        title="Plans"
        description={data.payments.available ? `Payments are handled by ${data.payments.provider}.` : undefined}
        actions={
          <div role="radiogroup" aria-label="Billing interval" className="inline-flex rounded-sm border border-line-strong bg-well p-0.5">
            {(["month", "year"] as const).map((i) => (
              <button
                key={i}
                type="button"
                role="radio"
                aria-checked={interval === i}
                onClick={() => setBillingInterval(i)}
                className={cn(
                  "h-6 rounded-xs px-2.5 text-xs transition-colors",
                  interval === i ? "bg-ctl-face font-medium text-text-hi shadow-sm" : "text-text-3 hover:text-text",
                )}
              >
                {i === "month" ? "Monthly" : "Yearly"}
              </button>
            ))}
          </div>
        }
      />
      <CardBody className="flex flex-col gap-4">
        {!data.payments.available && (
          <Callout tone="info" title="Online payments aren't set up on this installation">
            Plans can't be bought here yet. Contact support to change plans.
          </Callout>
        )}
        {data.payments.available && !ws.can("billing.manage") && <Callout tone="info">Only the workspace owner can change the plan.</Callout>}
        {data.plans.length ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {data.plans.map((p) => (
              <PlanCard
                key={p.key}
                plan={p}
                interval={interval}
                data={data}
                onChoose={choose}
                pending={checkout.isPending && checkout.variables?.planKey === p.key}
              />
            ))}
          </div>
        ) : (
          <p className="text-sm text-text-3">No plans are published on this installation.</p>
        )}
      </CardBody>
      <ConfirmDialog
        open={Boolean(choosing)}
        onOpenChange={(open) => !open && setChoosing(null)}
        tone="default"
        title={`Switch to ${choosing?.name} (${interval === "year" ? "yearly" : "monthly"})?`}
        description={`${data.payments.provider ?? "The payment provider"} changes your existing subscription and prorates the difference on your next invoice. The new plan applies once it confirms the change.`}
        confirmLabel="Switch plan"
        onConfirm={() => choosing && checkout.mutateAsync({ planKey: choosing.key, interval })}
      />
    </Card>
  );
}

function Invoices({ data }: { data: BillingOverview }) {
  const f = useFormat();
  if (!data.invoices.length) return null;
  return (
    <Card>
      <CardHeader icon={<Receipt />} title="Invoices" description="The latest 50, as recorded by the payment provider." />
      <div className={table.wrap}>
        <table className={table.table}>
          <thead>
            <tr>
              <th className={table.th}><ColumnLabel icon={COL.invoice}>Invoice</ColumnLabel></th>
              <th className={table.th}><ColumnLabel icon={COL.created}>Issued</ColumnLabel></th>
              <th className={table.th}><ColumnLabel icon={COL.status}>Status</ColumnLabel></th>
              <th className={cn(table.th, "text-right")}><ColumnLabel icon={COL.amount}>Amount</ColumnLabel></th>
              <th className={table.th}>
                <span className="sr-only">Links</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {data.invoices.map((i) => (
              <tr key={i.id}>
                <td className={cn(table.td, "font-medium")}>{i.number || "—"}</td>
                <td className={cn(table.td, "whitespace-nowrap text-text-2")}>{f.date(i.issuedAt)}</td>
                <td className={table.td}>
                  <StatusBadge value={i.status} />
                </td>
                <td className={cn(table.td, "text-right tabular-nums")}>{formatMoney(i.amountDueCents, i.currency.toUpperCase())}</td>
                <td className={cn(table.td, "text-right whitespace-nowrap")}>
                  <span className="inline-flex gap-1">
                    {i.hostedUrl && (
                      <Button size="sm" variant="ghost" href={i.hostedUrl} external icon={<ExternalLink />}>
                        View
                      </Button>
                    )}
                    {i.pdfUrl && (
                      <Button size="sm" variant="ghost" href={i.pdfUrl} external icon={<FileText />}>
                        PDF
                      </Button>
                    )}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

type DetailsInput = { name: string; billingEmail: string; country: string; taxId: string; address: string };

function BillingDetails({ data }: { data: BillingOverview }) {
  const ws = useWorkspace();
  const a = data.account;
  const initial: DetailsInput = { name: a.name, billingEmail: a.billingEmail, country: a.country, taxId: a.taxId, address: a.address };
  const [v, setV] = useState<DetailsInput>(initial);
  const save = useApiMutation<{ ok: true }, DetailsInput>({
    method: "PATCH",
    path: ws.path("/billing/details"),
    invalidate: [ws.key("billing")],
    success: "Billing details saved",
    errorToast: false,
  });
  const fields = save.error?.fields ?? {};
  const set = (k: keyof DetailsInput) => (e: { target: { value: string } }) => setV((s) => ({ ...s, [k]: e.target.value }));
  const country = v.country.trim().toUpperCase();
  const countryLabel = country ? countryName(country) : null;
  const countryError = country && !countryLabel ? "Use a two-letter country code, such as US, GB or DE." : undefined;
  const dirty = (Object.keys(initial) as (keyof DetailsInput)[]).some((k) => v[k].trim() !== initial[k]);

  if (!ws.can("billing.manage")) {
    return (
      <Card>
        <CardHeader icon={<Landmark />} title="Billing details" description="Shown on invoices." />
        <CardBody>
          <KeyValueList
            items={[
              { label: "Billed to", value: a.name },
              { label: "Billing email", value: a.billingEmail },
              { label: "Country", value: a.country ? (countryName(a.country) ?? a.country) : null },
              { label: "Tax ID", value: a.taxId },
              { label: "Address", value: a.address ? <span className="whitespace-pre-line">{a.address}</span> : null },
            ]}
          />
        </CardBody>
      </Card>
    );
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (countryError) return;
    save.mutate({ name: v.name.trim(), billingEmail: v.billingEmail.trim(), country, taxId: v.taxId.trim(), address: v.address.trim() });
  }

  return (
    <Card>
      <CardHeader icon={<Landmark />} title="Billing details" description="Shown on invoices. The billing email is used for checkout and payment notices." />
      <form onSubmit={submit} noValidate>
        <CardBody className="grid gap-4 sm:grid-cols-2">
          <FormError className="sm:col-span-2" error={save.error && !Object.keys(fields).length ? save.error.message : null} />
          <Field label="Billed to" error={fields.name} hint="Company or person name.">
            <Input value={v.name} onChange={set("name")} maxLength={200} />
          </Field>
          <Field label="Billing email" error={fields.billingEmail} hint="Leave empty to use the account owner's email.">
            <Input type="email" value={v.billingEmail} onChange={set("billingEmail")} />
          </Field>
          <Field label="Country" error={countryError ?? fields.country} hint={countryLabel ?? "Two-letter code, such as US."}>
            <Input value={v.country} onChange={(e) => setV((s) => ({ ...s, country: e.target.value.toUpperCase() }))} maxLength={2} className="uppercase" autoComplete="off" />
          </Field>
          <Field label="Tax ID" error={fields.taxId} hint="VAT, GST or similar, if you have one.">
            <Input value={v.taxId} onChange={set("taxId")} maxLength={60} />
          </Field>
          <Field label="Address" error={fields.address} className="sm:col-span-2">
            <Textarea rows={3} value={v.address} onChange={set("address")} maxLength={1000} />
          </Field>
        </CardBody>
        <CardFooter>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!dirty || Boolean(countryError)}>
            Save details
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

/** What coming back from hosted checkout looks like (?checkout=success|canceled on the return URL). */
function CheckoutReturn() {
  const params = useSearchParams();
  const result = params.get("checkout");
  if (result === "success") {
    return (
      <Callout tone="ok" title="Checkout complete" className="mb-5">
        Your new plan shows here as soon as the payment provider confirms the payment, usually within a minute.
      </Callout>
    );
  }
  if (result === "canceled") {
    return (
      <Callout tone="info" className="mb-5">
        Checkout was canceled. Your plan has not changed.
      </Callout>
    );
  }
  return null;
}

/** Settings → Plan & billing. */
export function BillingSettings() {
  const ws = useWorkspace();
  const params = useSearchParams();
  const awaitingProvider = params.get("checkout") === "success";
  // Right after checkout the webhook may still be on its way, so look again every few seconds.
  const overview = useApiQuery<BillingOverview>(ws.key("billing"), ws.path("/billing"), { refetchInterval: awaitingProvider ? 5_000 : false });

  return (
    <RequirePermission permission="billing.read">
      <PageHeader icon={<EntityTile of="billing" />} title="Plan & billing" description="Your plan, what it allows, and how you pay for it." />
      <CheckoutReturn />
      <QueryState query={overview} loading={<SkeletonText lines={8} />}>
        {(data) => (
          <div className="flex flex-col gap-5">
            <CurrentPlan data={data} />
            <Usage data={data} />
            <Plans data={data} />
            <Invoices data={data} />
            {/* Billing details and invoices cover the whole account: only its owner is sent them. */}
            {data.scope === "account" && <BillingDetails data={data} />}
          </div>
        )}
      </QueryState>
    </RequirePermission>
  );
}
