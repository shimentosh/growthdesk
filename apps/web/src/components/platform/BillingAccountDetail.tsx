"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Building2, ExternalLink, PackageCheck, Receipt, Wallet, Webhook } from "lucide-react";
import { formatMoney } from "@growthdesk/shared";
import { StatusBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { QueryState } from "@/components/ui/ErrorState";
import { Field, FormError } from "@/components/ui/Field";
import { Input, NativeSelect, Textarea } from "@/components/ui/Input";
import { KeyValueList } from "@/components/ui/KeyValue";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { SkeletonText } from "@/components/ui/Skeleton";
import { cn } from "@/lib/cn";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useFormat } from "@/lib/session";
import type { AdminBillingAccountDetail } from "@/lib/types/platform";
import { PersonCell, PlatformTile, platformKey, table, usePlatform } from "./common";
import { PlanUsage } from "./PlanUsage";

type AssignBody = { planKey: string; interval: "month" | "year"; status: "active" | "trialing"; periodEnd: string | null; reason: string };

function AssignPlanDialog({ account, open, onOpenChange }: { account: AdminBillingAccountDetail; open: boolean; onOpenChange: (v: boolean) => void }) {
  const [planKey, setPlanKey] = useState(account.plan.key);
  const [interval, setBillingInterval] = useState<"month" | "year">(account.plan.subscription?.interval ?? "month");
  const [status, setStatus] = useState<"active" | "trialing">("active");
  const [periodEnd, setPeriodEnd] = useState("");
  const [reason, setReason] = useState("");
  const assign = useApiMutation<AdminBillingAccountDetail, AssignBody>({
    path: `/admin/billing-accounts/${account.id}/assign-plan`,
    invalidate: [platformKey("billing-accounts"), platformKey("workspaces"), platformKey("overview")],
    success: "Plan assigned",
    errorToast: false,
    onSuccess: () => {
      setReason("");
      onOpenChange(false);
    },
  });
  const fields = assign.error?.fields ?? {};
  const submit = (e: FormEvent) => {
    e.preventDefault();
    assign.mutate({ planKey, interval, status, periodEnd: periodEnd ? new Date(`${periodEnd}T23:59:59Z`).toISOString() : null, reason: reason.trim() });
  };
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Assign a plan manually"
      description="For invoiced customers and your own workspaces. The subscription is marked as paid manually — Growthdesk takes no payment for it; bill the customer yourself."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="assign-plan" loading={assign.isPending} disabled={!reason.trim()}>
            Assign plan
          </Button>
        </>
      }
    >
      <form id="assign-plan" onSubmit={submit} className="flex flex-col gap-4">
        <FormError error={assign.error && !Object.keys(fields).length ? assign.error.message : null} />
        <Field label="Plan" error={fields.planKey}>
          <NativeSelect
            value={planKey}
            onChange={(e) => setPlanKey(e.target.value)}
            options={account.plans.map((p) => ({ value: p.key, label: `${p.name}${!p.isActive ? " (inactive)" : !p.isPublic ? " (hidden)" : ""}` }))}
          />
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="State">
            <NativeSelect
              value={status}
              onChange={(e) => setStatus(e.target.value as "active" | "trialing")}
              options={[
                { value: "active", label: "Active" },
                { value: "trialing", label: "Trial" },
              ]}
            />
          </Field>
          <Field label="Interval">
            <NativeSelect
              value={interval}
              onChange={(e) => setBillingInterval(e.target.value as "month" | "year")}
              options={[
                { value: "month", label: "Monthly" },
                { value: "year", label: "Annual" },
              ]}
            />
          </Field>
        </div>
        <Field
          label={status === "trialing" ? "Trial ends" : "Paid until (for your records)"}
          error={fields.periodEnd}
          hint={
            status === "trialing"
              ? "When the trial ends without a plan, the free allowance applies. Empty: 14 days from now."
              : "Shown on the account only — a manual plan stays active until it is changed here."
          }
        >
          <Input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} className="sm:max-w-48" />
        </Field>
        <Field label="Reason" error={fields.reason} hint="Recorded in the audit log of every workspace on this account.">
          <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="e.g. Annual contract, invoiced by bank transfer" />
        </Field>
      </form>
    </Modal>
  );
}

/** /admin/billing/:id */
export function BillingAccountDetail() {
  const { accountId } = useParams<{ accountId: string }>();
  const f = useFormat();
  const { canChange } = usePlatform();
  const q = useApiQuery<AdminBillingAccountDetail>(platformKey("billing-accounts", accountId), `/admin/billing-accounts/${accountId}`);
  const [assignOpen, setAssignOpen] = useState(false);

  return (
    <Page width="capped">
      <QueryState query={q} loading={<SkeletonText lines={10} />}>
        {(a) => (
          <>
            <PageHeader back={{ href: "/admin/billing", label: "Billing accounts" }} icon={<PlatformTile of="billing" />} title={a.name} description={a.billingEmail || undefined} />
            <div className="flex flex-col gap-4">
              <PlanUsage
                plan={a.plan}
                workspaces={a.workspaces.length}
                actions={
                  canChange && (
                    <Button size="sm" icon={<PackageCheck />} disabled={!a.manualAssign.allowed} title={a.manualAssign.reason || undefined} onClick={() => setAssignOpen(true)}>
                      Assign plan
                    </Button>
                  )
                }
              />
              {canChange && !a.manualAssign.allowed && <Callout tone="info">{a.manualAssign.reason}</Callout>}

              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <Card>
                  <CardHeader icon={<Wallet />} title="Account" />
                  <CardBody>
                    <KeyValueList
                      items={[
                        { label: "Owner", value: <PersonCell person={a.owner} /> },
                        { label: "Billing email", value: a.billingEmail },
                        { label: "Country", value: a.country },
                        { label: "Tax id", value: a.taxId },
                        { label: "Address", value: a.address ? <span className="whitespace-pre-line">{a.address}</span> : null },
                        { label: "Created", value: f.dateTime(a.createdAt) },
                        { label: "Provider customer", value: a.plan.subscription?.providerCustomerId ? <span className="font-mono text-xs">{a.plan.subscription.providerCustomerId}</span> : null },
                        { label: "Account id", value: <span className="font-mono text-xs">{a.id}</span> },
                      ]}
                    />
                  </CardBody>
                </Card>
                <Card>
                  <CardHeader icon={<Building2 />} title="Workspaces" />
                  {a.workspaces.length ? (
                    <ul>
                      {a.workspaces.map((w) => (
                        <li key={w.id} className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5 text-sm last:border-b-0">
                          <Link href={`/admin/workspaces/${w.id}`} className="min-w-0 truncate font-medium hover:underline">
                            {w.name}
                          </Link>
                          <StatusBadge value={w.status} />
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <EmptyState compact icon={<Building2 />} title="No workspaces" />
                  )}
                </Card>
              </div>

              <Card>
                <CardHeader icon={<Receipt />} title="Invoices" description="Mirrored from the payment provider." />
                {a.invoices.length ? (
                  <div className={table.wrap}>
                    <table className={table.table}>
                      <thead>
                        <tr>
                          <th className={table.th}>Invoice</th>
                          <th className={table.th}>Issued</th>
                          <th className={table.th}>Status</th>
                          <th className={table.th}>Due</th>
                          <th className={table.th}>Paid</th>
                          <th className={table.th} />
                        </tr>
                      </thead>
                      <tbody>
                        {a.invoices.map((i) => (
                          <tr key={i.id}>
                            <td className={table.td}>{i.number || <span className="text-text-3">—</span>}</td>
                            <td className={cn(table.td, "text-text-2")}>{f.date(i.issuedAt)}</td>
                            <td className={table.td}>
                              <StatusBadge value={i.status} />
                            </td>
                            <td className={cn(table.td, "tabular-nums")}>{formatMoney(i.amountDueCents, i.currency)}</td>
                            <td className={cn(table.td, "tabular-nums")}>{formatMoney(i.amountPaidCents, i.currency)}</td>
                            <td className={cn(table.td, "text-right")}>
                              {i.hostedUrl && (
                                <Button size="sm" variant="ghost" href={i.hostedUrl} external iconRight={<ExternalLink />}>
                                  View
                                </Button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <EmptyState compact icon={<Receipt />} title="No invoices" />
                )}
              </Card>

              <Card>
                <CardHeader icon={<Webhook />} title="Payment provider events" description="The 20 most recent webhooks for this account." />
                {a.billingEvents.length ? (
                  <div className={table.wrap}>
                    <table className={table.table}>
                      <thead>
                        <tr>
                          <th className={table.th}>Received</th>
                          <th className={table.th}>Event</th>
                          <th className={table.th}>Processed</th>
                          <th className={table.th}>Error</th>
                        </tr>
                      </thead>
                      <tbody>
                        {a.billingEvents.map((e) => (
                          <tr key={e.id}>
                            <td className={cn(table.td, "whitespace-nowrap text-text-2")}>{f.dateTime(e.receivedAt)}</td>
                            <td className={cn(table.td, "font-mono text-xs")}>
                              {e.provider}: {e.type}
                            </td>
                            <td className={cn(table.td, "text-text-2")}>{e.processedAt ? f.dateTime(e.processedAt) : `Not yet (${e.attempts} attempt${e.attempts === 1 ? "" : "s"})`}</td>
                            <td className={cn(table.td, "max-w-80 text-xs text-bad-ink")}>{e.error || <span className="text-text-3">—</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <EmptyState compact icon={<Webhook />} title="No provider events" />
                )}
              </Card>
            </div>
            {canChange && <AssignPlanDialog key={a.plan.key} account={a} open={assignOpen} onOpenChange={setAssignOpen} />}
          </>
        )}
      </QueryState>
    </Page>
  );
}
