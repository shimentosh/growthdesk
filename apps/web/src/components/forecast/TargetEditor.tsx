"use client";

import { useState } from "react";
import { Target } from "lucide-react";
import { TARGET_METRICS, TARGET_METRIC_LABELS, type PeriodType, type TargetMetric } from "@growthdesk/shared";
import { useMembers } from "@/components/pickers/Pickers";
import { Button } from "@/components/ui/Button";
import { Card, CardFooter, CardHeader } from "@/components/ui/Card";
import { QueryState } from "@/components/ui/ErrorState";
import { Input } from "@/components/ui/Input";
import { SkeletonText } from "@/components/ui/Skeleton";
import { toast } from "@/components/ui/Toast";
import { api } from "@/lib/api";
import { useApiQuery, useInvalidate } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import type { SalesTarget, TargetsResponse } from "@/lib/types/forecast";

/*
 * Targets (quotas) for one period: the workspace's, each team's and each
 * member's, for revenue won, deals won and meetings booked. Edited as a grid and saved together —
 * PUT /targets per changed cell, DELETE for a cleared one. Needs
 * targets.manage. Revenue is in the workspace currency.
 */

/** Whose target a row holds: "ws" (the workspace), "t:<teamId>" or "u:<userId>". */
const ownerKey = (t: { userId: string | null; teamId: string | null }) => (t.userId ? `u:${t.userId}` : t.teamId ? `t:${t.teamId}` : "ws");
const cellKey = (owner: string, metric: TargetMetric) => `${owner}|${metric}`;
/** The input id the rep and team tables' "Edit target" focuses. */
export const targetInputId = (owner: { userId?: string | null; teamId?: string | null }) => `target-${ownerKey({ userId: owner.userId ?? null, teamId: owner.teamId ?? null })}-revenue_won`.replace(":", "-");

function draftOf(items: SalesTarget[]): Record<string, string> {
  return Object.fromEntries(items.map((t) => [cellKey(ownerKey(t), t.metric), String(t.target)]));
}

export function TargetEditor({ periodType, periodStart, label, currency }: { periodType: PeriodType; periodStart: string; label: string; currency: string }) {
  const ws = useWorkspace();
  const query = useApiQuery<TargetsResponse>(ws.key("forecast", "targets"), ws.path("/targets"), { query: { periodType, periodStart } });
  return (
    <Card id="targets">
      <CardHeader icon={<Target />} title={`Targets · ${label}`} description={`Revenue in ${currency}. Leave a box empty for no target. The workspace's and a team's own target, when set, are what their totals are measured against; otherwise their reps' targets add up.`} />
      <QueryState query={query} loading={<SkeletonText lines={4} className="p-4" />}>
        {(data) => <TargetGrid key={`${periodType}:${periodStart}:${data.items.map((t) => `${t.id}${t.target}`).join()}`} data={data} periodType={periodType} periodStart={periodStart} />}
      </QueryState>
    </Card>
  );
}

function TargetGrid({ data, periodType, periodStart }: { data: TargetsResponse; periodType: PeriodType; periodStart: string }) {
  const ws = useWorkspace();
  const members = useMembers();
  const invalidate = useInvalidate();
  const initial = draftOf(data.items);
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const changed = Object.keys({ ...initial, ...draft }).filter((k) => (draft[k] ?? "").trim() !== (initial[k] ?? ""));
  const invalid = changed.filter((k) => {
    const v = (draft[k] ?? "").trim();
    if (!v) return false;
    const n = Number(v);
    return !Number.isFinite(n) || n < 0 || (!k.endsWith("|revenue_won") && !Number.isInteger(n));
  });

  const rows: { owner: string; userId: string | null; teamId: string | null; name: string; group?: string }[] = [
    { owner: "ws", userId: null, teamId: null, name: "Whole workspace" },
    ...data.teams.map((t) => ({ owner: `t:${t.id}`, userId: null, teamId: t.id, name: t.name, group: "Team" })),
    ...(members.data?.members ?? []).filter((m) => !m.deactivatedAt).map((m) => ({ owner: `u:${m.userId}`, userId: m.userId, teamId: null, name: m.name || m.email })),
    // Targets for people who have since left (or been paused) still show, so they can be cleared.
    ...data.items.filter((t) => t.userId).map((t) => ({ owner: `u:${t.userId}`, userId: t.userId, teamId: null, name: t.user?.name ?? "Former member" })),
  ].filter((p, i, all) => all.findIndex((x) => x.owner === p.owner) === i);

  const save = async () => {
    setSaving(true);
    let failed = 0;
    for (const k of changed) {
      const [who, metric] = k.split("|") as [string, TargetMetric];
      const userId = who.startsWith("u:") ? who.slice(2) : null;
      const teamId = who.startsWith("t:") ? who.slice(2) : null;
      const value = (draft[k] ?? "").trim();
      const existing = data.items.find((t) => cellKey(ownerKey(t), t.metric) === k);
      try {
        if (!value) {
          if (existing) await api(ws.path(`/targets/${existing.id}`), { method: "DELETE" });
        } else {
          await api(ws.path("/targets"), { method: "PUT", body: { userId, teamId, periodType, periodStart, metric, target: Number(value) } });
        }
      } catch (e) {
        failed += 1;
        toast.error(e);
      }
    }
    setSaving(false);
    await invalidate(ws.key("forecast"));
    if (!failed) toast.success("Targets saved");
  };

  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <thead className="border-b border-line bg-well">
            <tr>
              <th className="px-3 py-2 text-left text-xs font-medium text-text-3">Who</th>
              {TARGET_METRICS.map((m) => (
                <th key={m} className="px-3 py-2 text-left text-xs font-medium text-text-3">
                  {TARGET_METRIC_LABELS[m]}
                  {m === "revenue_won" && ` (${data.currency})`}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((p) => (
              <tr key={p.owner}>
                <td className={p.userId ? "px-3 py-1.5 text-text" : "px-3 py-1.5 font-medium text-text-hi"}>
                  {p.name}
                  {p.group && <span className="ml-1.5 text-xs font-normal text-text-3">{p.group}</span>}
                </td>
                {TARGET_METRICS.map((m) => {
                  const k = cellKey(p.owner, m);
                  return (
                    <td key={m} className="px-3 py-1.5">
                      <Input
                        id={m === "revenue_won" ? targetInputId(p) : undefined}
                        size="sm"
                        type="number"
                        inputMode={m === "revenue_won" ? "decimal" : "numeric"}
                        min={0}
                        step={m === "revenue_won" ? "0.01" : 1}
                        aria-label={`${TARGET_METRIC_LABELS[m]} target for ${p.name}`}
                        placeholder="—"
                        value={draft[k] ?? ""}
                        invalid={invalid.includes(k)}
                        onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <CardFooter>
        {invalid.length > 0 && <span className="mr-auto text-xs text-bad-ink">Targets are zero or more; deal and meeting targets are whole numbers.</span>}
        {changed.length > 0 && (
          <Button onClick={() => setDraft(initial)} disabled={saving}>
            Discard
          </Button>
        )}
        <Button variant="primary" onClick={() => void save()} disabled={!changed.length || invalid.length > 0} loading={saving}>
          Save targets
        </Button>
      </CardFooter>
    </>
  );
}
