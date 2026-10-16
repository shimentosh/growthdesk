"use client";

import { formatNumber, formatPercent } from "@/lib/format";
import type { FunnelStage } from "@/lib/types/analytics";

/**
 * Stage funnel as a list of horizontal bars: how many of the cohort reached
 * each stage (or a later one), and the step conversion from the stage above.
 * Bar length is relative to the whole cohort; every number is printed.
 */
export function Funnel({ stages, cohort, compact }: { stages: FunnelStage[]; cohort: number; compact?: boolean }) {
  if (compact) return <CompactFunnel stages={stages} cohort={cohort} />;
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

/** For a narrow card: the name and numbers on one line, the bar under them at full width. */
function CompactFunnel({ stages, cohort }: { stages: FunnelStage[]; cohort: number }) {
  return (
    <ol className="flex flex-col gap-2">
      {stages.map((s) => {
        const share = cohort ? s.reached / cohort : 0;
        return (
          <li key={s.stageId} className="flex flex-col gap-0.5 text-sm">
            <span className="flex items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate text-text" title={s.name}>
                {s.name}
              </span>
              <span className="font-medium text-text-hi tabular-nums">{formatNumber(s.reached)}</span>
              <span className="w-10 text-right text-xs text-text-3 tabular-nums" title="Of the deals at the stage above">
                {s.conversion === null ? "" : formatPercent(s.conversion, 0)}
              </span>
            </span>
            <span aria-hidden className="h-1.5 overflow-hidden rounded-full bg-s-3">
              <span
                className="block h-full rounded-full"
                style={{ width: s.reached ? `max(4px, ${(share * 100).toFixed(2)}%)` : 0, background: s.kind === "won" ? "var(--ok)" : "var(--accent)" }}
              />
            </span>
          </li>
        );
      })}
    </ol>
  );
}
