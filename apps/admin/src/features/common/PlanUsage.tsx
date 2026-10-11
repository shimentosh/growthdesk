"use client";

import { Check, Minus, Package } from "lucide-react";
import { FEATURE_KEYS, FEATURE_LABELS, LIMIT_KEYS } from "@growthdesk/shared";
import { StatusBadge } from "@/components/ui/Badge";
import { Callout } from "@/components/ui/Callout";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { KeyValueList } from "@/components/ui/KeyValue";
import { Meter } from "@/components/ui/Meter";
import { useFormat } from "@/lib/session";
import type { AdminPlanSummary } from "@/features/common/types";
import { providerLabel } from "@/features/common/platform";

/**
 * A billing account's plan, subscription and usage against limits — what
 * EntitlementsService decides, so it is exactly what the customer is held to.
 */
export function PlanUsage({ plan, workspaces, actions }: { plan: AdminPlanSummary; workspaces: number; actions?: React.ReactNode }) {
  const f = useFormat();
  const sub = plan.subscription;
  const fallback = plan.effectiveKey !== plan.key;
  return (
    <Card>
      <CardHeader
        icon={<Package />}
        title="Plan & usage"
        description={`Limits apply to the whole billing account — ${workspaces} workspace${workspaces === 1 ? "" : "s"}.`}
        actions={actions}
      />
      <CardBody className="flex flex-col gap-5">
        {plan.reason && (
          <Callout tone={plan.access === "restricted" ? "bad" : "warn"} title={plan.access === "restricted" ? "Restricted access" : undefined}>
            {plan.reason}
          </Callout>
        )}
        <KeyValueList
          columns={2}
          items={[
            { label: "Plan", value: fallback ? `${plan.name} (limits of ${plan.effectiveName} apply)` : plan.name },
            { label: "State", value: plan.state === "none" ? "No subscription" : <StatusBadge value={plan.state} /> },
            { label: "Paid through", value: sub ? providerLabel(sub.provider) : "—" },
            { label: "Interval", value: sub ? (sub.interval === "year" ? "Annual" : "Monthly") : "—" },
            { label: "Trial ends", value: sub?.trialEndsAt ? f.dateTime(sub.trialEndsAt) : null },
            { label: "Period ends", value: sub?.currentPeriodEnd ? f.dateTime(sub.currentPeriodEnd) : null, hint: sub?.cancelAtPeriodEnd ? "Cancels at period end" : undefined },
            { label: "Grace until", value: sub?.graceUntil ? f.dateTime(sub.graceUntil) : null },
            { label: "Provider subscription", value: sub?.providerSubscriptionId ? <span className="font-mono text-xs">{sub.providerSubscriptionId}</span> : null },
          ]}
        />
        <div className="grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2">
          {LIMIT_KEYS.map((k) => {
            const u = plan.usage[k];
            return u ? <Meter key={k} label={u.label} value={u.used} max={u.limit} /> : null;
          })}
        </div>
        <div>
          <div className="mb-1.5 text-xs font-medium text-text-2">Features</div>
          <ul className="grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
            {FEATURE_KEYS.map((k) => (
              <li key={k} className={plan.features[k] ? "flex items-center gap-1.5 text-text" : "flex items-center gap-1.5 text-text-3 line-through"}>
                {plan.features[k] ? <Check aria-hidden className="size-3.5 shrink-0 text-ok-ink" /> : <Minus aria-hidden className="size-3.5 shrink-0" />}
                {FEATURE_LABELS[k]}
              </li>
            ))}
          </ul>
        </div>
      </CardBody>
    </Card>
  );
}
