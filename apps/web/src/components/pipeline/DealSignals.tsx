"use client";

import { CornerDownRight } from "lucide-react";
import { FORECAST_CATEGORIES, FORECAST_CATEGORY_LABELS, type ForecastCategory } from "@growthdesk/shared";
import { Badge, type Tone } from "@/components/ui/Badge";
import { cn } from "@/lib/cn";
import { useFormat } from "@/lib/session";
import type { Deal } from "@/lib/types/pipeline";
import { formatCalendarDate } from "./utils";

/*
 * The small signals a deal carries on the board, in the list and on its page:
 * stale (no progress for longer than its stage allows — computed by the API,
 * see apps/api/src/forecast/progress.ts), its next step, and its forecast
 * category.
 */

/** "Stale · 16d" — only for a deal the API marked stale. */
export function StaleBadge({ deal, className }: { deal: Pick<Deal, "stale" | "stage">; className?: string }) {
  const f = useFormat();
  if (!deal.stale) return null;
  return (
    <Badge
      tone="warn"
      dot
      className={className}
      title={`No progress since ${f.date(deal.stale.since)}${deal.stage.rotDays ? ` — ${deal.stage.name} flags deals after ${deal.stage.rotDays} days` : ""}`}
    >
      Stale · {deal.stale.days}d
    </Badge>
  );
}

/** Next step dates are calendar dates (UTC midnight): overdue once that day has passed in the workspace's zone. */
export function nextStepOverdue(deal: Pick<Deal, "nextStepAt" | "status">, today: string): boolean {
  return deal.status === "open" && Boolean(deal.nextStepAt) && deal.nextStepAt!.slice(0, 10) < today;
}

/** The next step on one line, with its date (red once it is past). Nothing when there is none. `today`: localDay(now, workspace zone). */
export function NextStepLine({ deal, today, className }: { deal: Pick<Deal, "nextStep" | "nextStepAt" | "status">; today: string; className?: string }) {
  if (!deal.nextStep && !deal.nextStepAt) return null;
  const overdue = nextStepOverdue(deal, today);
  return (
    <span className={cn("flex min-w-0 items-center gap-1 text-xs text-text-2", className)} title={deal.nextStep || undefined}>
      <CornerDownRight aria-hidden className="size-3.5 shrink-0 text-text-3" />
      <span className="truncate">{deal.nextStep || "Next step"}</span>
      {deal.nextStepAt && <span className={cn("shrink-0", overdue ? "text-bad-ink" : "text-text-3")}>· {overdue ? "was due " : ""}{formatCalendarDate(deal.nextStepAt)}</span>}
    </span>
  );
}

const CATEGORY_TONE: Record<ForecastCategory, Tone> = { commit: "ok", best_case: "live", pipeline: "mute", omitted: "mute" };

export function ForecastCategoryBadge({ category, className }: { category: ForecastCategory; className?: string }) {
  return (
    <Badge tone={CATEGORY_TONE[category]} quiet={category === "omitted"} className={className}>
      {FORECAST_CATEGORY_LABELS[category]}
    </Badge>
  );
}

export const FORECAST_CATEGORY_OPTIONS = FORECAST_CATEGORIES.map((c) => ({ value: c, label: FORECAST_CATEGORY_LABELS[c] }));
