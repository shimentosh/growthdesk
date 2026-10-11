"use client";

import { formatNumber, formatPercent } from "@/lib/format";
import type { FunnelStage } from "@/lib/types/analytics";

/**
 * Stage funnel as a list of horizontal bars: how many of the cohort reached
 * each stage (or a later one), and the step conversion from the stage above.
 * Bar length is relative to the whole cohort; every number is printed.
 */
export function Funnel({ stages, cohort }: { stages: FunnelStage[]; cohort: number }) {
  return (
    <ol className="flex flex-col gap-1.5">
      {stages.map((s) => {
        const share = cohort ? s.reached / cohort : 0;
        return (
          <li key={s.stageId} className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-3 text-sm sm:grid-cols-[minmax(0,12rem)_1fr_auto]">
            <span className="truncate text-text" title={s.name}>
              {s.name}
            </span>
            <span aria-hidden className="h-5 overflow-hidden rounded-xs bg-s-2">
              <span
                className="block h-full rounded-xs"
                style={{
                  width: s.reached ? `max(3px, ${(share * 100).toFixed(2)}%)` : 0,
                  background: s.kind === "won" ? "var(--ok)" : "var(--accent)",
                }}
              />
            </span>
            <span className="flex w-28 items-baseline justify-end gap-2 tabular-nums">
              <span className="font-medium text-text-hi">{formatNumber(s.reached)}</span>
              <span className="w-12 text-right text-xs text-text-3" title="Of the deals at the stage above">
                {s.conversion === null ? "" : formatPercent(s.conversion, 0)}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
