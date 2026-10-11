"use client";

import { useState } from "react";
import { ANALYTICS_MAX_DAYS, RANGE_PRESETS, localDayDiff, matchPreset, presetRange, type RangePreset } from "@growthdesk/shared";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";

export type DayRange = { from: string; to: string };

/**
 * Report range: presets, or two calendar days. Days are the workspace's own
 * (`today` is today in its time zone), so "Last 7 days" means the same thing
 * for everyone on the team.
 */
export function RangePicker({ value, today, onChange }: { value: DayRange; today: string; onChange: (range: DayRange) => void }) {
  const preset = matchPreset(value, today);
  const [custom, setCustom] = useState(preset === null);
  const [draft, setDraft] = useState<DayRange>(value);
  const span = localDayDiff(draft.from, draft.to);
  const problem = !draft.from || !draft.to ? "Pick both days" : span < 0 ? "The end is before the start" : span + 1 > ANALYTICS_MAX_DAYS ? `At most ${ANALYTICS_MAX_DAYS} days` : null;

  const setDay = (key: keyof DayRange, day: string) => {
    const next = { ...draft, [key]: day };
    setDraft(next);
    const s = localDayDiff(next.from, next.to);
    if (next.from && next.to && s >= 0 && s + 1 <= ANALYTICS_MAX_DAYS) onChange(next);
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select<RangePreset | "custom">
        aria-label="Date range"
        className="w-40"
        value={custom ? "custom" : (preset ?? "custom")}
        onValueChange={(v) => {
          if (v === "custom") {
            setDraft(value);
            setCustom(true);
            return;
          }
          setCustom(false);
          onChange(presetRange(v, today));
        }}
        options={[...RANGE_PRESETS.map((p) => ({ value: p.key, label: p.label })), { value: "custom" as const, label: "Custom range" }]}
      />
      {custom && (
        <>
          <Input type="date" aria-label="From" className="w-36" value={draft.from} max={today} onChange={(e) => setDay("from", e.target.value)} />
          <span aria-hidden className="text-xs text-text-3">
            to
          </span>
          <Input type="date" aria-label="To" className="w-36" value={draft.to} max={today} onChange={(e) => setDay("to", e.target.value)} />
          {problem && (
            <span role="status" className="text-xs text-bad-ink">
              {problem}
            </span>
          )}
        </>
      )}
    </div>
  );
}
