"use client";

import { FEATURE_LABELS, LIMIT_LABELS, type FeatureKey, type LimitKey } from "@growthdesk/shared";
import { Sparkles } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";
import type { ApiError, PlanLimitDetails } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useOptionalWorkspace } from "@/lib/session";
import { closeUpgrade, upgradeStore } from "@/lib/upgrade";
import { Button } from "./Button";
import { Modal } from "./Dialog";
import { Meter } from "./Meter";

/*
 * What a 402 `plan_limit` error looks like to a person: which limit, how much
 * is used, what the plan allows, and the way to more.
 *
 *   - Inline (a page whose data is gated):   <UpgradePrompt error={query.error} />
 *     ErrorState does this for you when it is handed a plan-limit error.
 *   - After an action (create, invite, launch): nothing to do — useApiMutation
 *     opens the upgrade dialog for every 402 automatically.
 *   - By hand: showUpgrade(error) from src/lib/upgrade.ts.
 */

function describe(details: PlanLimitDetails) {
  if (details.feature) {
    const label = FEATURE_LABELS[details.feature as FeatureKey] ?? details.feature;
    return { title: `${label} isn't included in your plan`, label };
  }
  if (details.limit) {
    const label = LIMIT_LABELS[details.limit as LimitKey] ?? details.limit;
    return { title: `You've reached your plan's limit for ${label.toLowerCase()}`, label };
  }
  return { title: "Your plan doesn't cover this", label: "" };
}

export function UpgradePrompt({
  error,
  details,
  message,
  bare,
  className,
}: {
  /** The ApiError from a 402 (its `details` carry the numbers). */
  error?: ApiError | null;
  /** Or the details directly. */
  details?: PlanLimitDetails;
  /** Overrides the server's sentence. */
  message?: string;
  /** No card chrome (inside a dialog). */
  bare?: boolean;
  className?: string;
}) {
  const ws = useOptionalWorkspace();
  const d: PlanLimitDetails = details ?? (error?.details as PlanLimitDetails | undefined) ?? {};
  const { title, label } = describe(d);
  const text = message ?? error?.message;
  const canBilling = ws?.can("billing.read") ?? false;
  const hasNumbers = typeof d.used === "number" && typeof d.allowed === "number";

  return (
    <div className={cn(!bare && "rounded-lg border border-line bg-panel p-5", className)}>
      <div className="flex items-start gap-3">
        <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-hi">
          <Sparkles className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-text-hi">{title}</h3>
          {text && <p className="mt-1 text-sm text-text-2">{text}</p>}
          {hasNumbers && <Meter className="mt-3 max-w-sm" label={label} value={d.used as number} max={d.allowed as number} />}
          {d.plan && <p className="mt-2 text-xs text-text-3">Current plan: {d.plan}</p>}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {ws && canBilling ? (
              <Button variant="primary" href={ws.href("/billing")} onClick={closeUpgrade}>
                See plans and upgrade
              </Button>
            ) : (
              <p className="text-xs text-text-3">Ask the workspace owner to upgrade the plan.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const subscribe = upgradeStore.subscribe;
const getSnapshot = upgradeStore.get;
const getServerSnapshot = () => null;

/** Renders the dialog opened by showUpgrade(). Mounted once by the workspace shell. */
export function UpgradeDialogHost() {
  const error = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  useEffect(() => upgradeStore.registerHost(), []);
  return (
    <Modal open={Boolean(error)} onOpenChange={(open) => !open && closeUpgrade()} title="Upgrade to continue" size="md">
      {error && <UpgradePrompt error={error} bare />}
    </Modal>
  );
}
