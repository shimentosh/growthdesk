"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { FORECAST_CATEGORY_LABELS, FORECAST_CATEGORY_ORDER, type ForecastCategory, type ForecastFigures } from "@growthdesk/shared";
import { ForecastCategoryBadge, FORECAST_CATEGORY_OPTIONS } from "@/components/pipeline/DealSignals";
import { StageDot } from "@/components/pipeline/StageDot";
import { formatCalendarDate } from "@/components/pipeline/utils";
import { NativeSelect } from "@/components/ui/Input";
import { cn } from "@/lib/cn";
import { formatCurrency, formatNumber, formatPercent } from "@/lib/format";
import { useApiMutation } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import type { ForecastDeal, ForecastOwnerRow, ForecastTeamRow } from "@/lib/types/forecast";
import { ForecastBar } from "./ForecastBar";

const th = "px-3 py-2 text-left text-xs font-medium whitespace-nowrap text-text-3";
const thNum = `${th} text-right`;
const td = "px-3 py-2 align-middle";
const tdNum = `${td} text-right tabular-nums whitespace-nowrap`;

/** "3 / 5" against a count target, or just the count. */
const ofTarget = (actual: number, target: number | null) => (target === null ? formatNumber(actual) : `${formatNumber(actual)} / ${formatNumber(target)}`);

function FiguresHead({ first }: { first: string }) {
  return (
    <thead className="border-b border-line bg-well">
      <tr>
        <th className={th}>{first}</th>
        <th className={`${th} w-64`}>Attainment</th>
        <th className={thNum}>Target</th>
        <th className={thNum}>Won</th>
        <th className={thNum}>Commit</th>
        <th className={thNum}>Best case</th>
        <th className={thNum}>Pipeline</th>
        <th className={thNum} title="Open deals × their stage's probability">
          Weighted
        </th>
        <th className={thNum}>Gap</th>
        <th className={thNum}>Deals won</th>
        <th className={thNum}>Meetings</th>
      </tr>
    </thead>
  );
}

/** One line of figures: who, the attainment bar, the money, and the count targets. */
function FiguresRow({ name, figures: r, currency, action, sub, className }: { name: ReactNode; figures: ForecastFigures; currency: string; action?: ReactNode; sub?: boolean; className?: string }) {
  const money = (v: number | null) => (v === null ? "—" : formatCurrency(v, currency));
  return (
    <tr className={cn("hover:bg-hover", className)}>
      <td className={cn(td, "max-w-56", sub && "pl-8")}>
        <span className={cn("block truncate", sub ? "text-text-2" : "font-medium text-text")}>{name}</span>
        {action}
      </td>
      <td className={td}>
        <div className="flex items-center gap-2">
          <ForecastBar figures={r} currency={currency} size="sm" className="min-w-0 flex-1" />
          <span className="w-10 text-right text-xs text-text-2 tabular-nums">{r.attainment === null ? "—" : formatPercent(r.attainment, 0)}</span>
        </div>
      </td>
      <td className={cn(tdNum, "text-text-2")}>{money(r.target)}</td>
      <td className={cn(tdNum, "font-medium text-text-hi")}>{money(r.won)}</td>
      <td className={cn(tdNum, "text-text")}>{money(r.commit)}</td>
      <td className={cn(tdNum, "text-text")}>{money(r.bestCase)}</td>
      <td className={cn(tdNum, "text-text-2")}>{money(r.pipeline)}</td>
      <td className={cn(tdNum, "text-text-2")}>{money(r.weighted)}</td>
      <td className={cn(tdNum, r.gap !== null && r.gap <= 0 ? "text-ok-ink" : "text-text-2")}>{r.gap === null ? "—" : r.gap <= 0 ? `+${formatCurrency(-r.gap, currency)}` : money(r.gap)}</td>
      <td className={cn(tdNum, "text-text-2")}>{ofTarget(r.dealsWon, r.dealsWonTarget)}</td>
      <td className={cn(tdNum, "text-text-2")}>{ofTarget(r.meetingsBooked, r.meetingsBookedTarget)}</td>
    </tr>
  );
}

const hasTarget = (r: ForecastFigures) => r.target !== null || r.dealsWonTarget !== null || r.meetingsBookedTarget !== null;

function TargetLink({ figures, onClick }: { figures: ForecastFigures; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="text-xs text-accent-ink hover:text-accent-hi">
      {hasTarget(figures) ? "Edit target" : "Set target"}
    </button>
  );
}

const ownerName = (r: ForecastOwnerRow) =>
  r.owner ? (
    <>
      {r.owner.name}
      {r.deactivated && <span className="ml-1.5 text-xs font-normal text-text-3">Deactivated</span>}
    </>
  ) : (
    <span className="text-text-3">No owner</span>
  );

/** One row per rep (and one for unowned deals). */
export function OwnerTable({ rows, currency, onEditTarget }: { rows: ForecastOwnerRow[]; currency: string; onEditTarget?: (row: ForecastOwnerRow) => void }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1080px] text-sm">
        <FiguresHead first="Rep" />
        <tbody className="divide-y divide-line">
          {rows.map((r) => (
            <FiguresRow
              key={r.ownerId ?? "none"}
              name={ownerName(r)}
              figures={r}
              currency={currency}
              action={onEditTarget && r.ownerId ? <TargetLink figures={r} onClick={() => onEditTarget(r)} /> : undefined}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Each team against its target, with its members' rows under it. A person in
 * two teams shows under both; a deactivated member's wins count for the team,
 * their open deals do not.
 */
export function TeamTable({ teams, owners, currency, onEditTarget }: { teams: ForecastTeamRow[]; owners: ForecastOwnerRow[]; currency: string; onEditTarget?: (team: ForecastTeamRow) => void }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1080px] text-sm">
        <FiguresHead first="Team" />
        {teams.map((t) => (
          <tbody key={t.team.id} className="divide-y divide-line border-b border-line last:border-b-0">
            <FiguresRow
              name={
                <span className="flex items-center gap-2">
                  <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ backgroundColor: `var(--tint-${t.team.color})` }} />
                  {t.team.name}
                </span>
              }
              figures={t}
              currency={currency}
              className="bg-well/40"
              action={onEditTarget ? <TargetLink figures={t} onClick={() => onEditTarget(t)} /> : undefined}
            />
            {owners
              .filter((o) => o.ownerId && t.memberIds.includes(o.ownerId))
              .map((o) => (
                <FiguresRow key={o.ownerId} sub name={ownerName(o)} figures={o} currency={currency} />
              ))}
          </tbody>
        ))}
      </table>
    </div>
  );
}

type Group = { key: "won" | ForecastCategory; label: string; deals: ForecastDeal[] };

/** The deals behind the numbers: won first, then open deals by category (most certain first), omitted last. */
export function groupDeals(deals: ForecastDeal[]): Group[] {
  const groups: Group[] = [
    { key: "won", label: "Won", deals: deals.filter((d) => d.status === "won") },
    ...FORECAST_CATEGORY_ORDER.map((c) => ({ key: c, label: FORECAST_CATEGORY_LABELS[c], deals: deals.filter((d) => d.status === "open" && d.forecastCategory === c) })),
  ];
  return groups.filter((g) => g.deals.length);
}

export function DealsByCategory({ deals, currency }: { deals: ForecastDeal[]; currency: string }) {
  const ws = useWorkspace();
  const f = useFormat();
  const canWrite = ws.can("deals.write");
  const setCategory = useApiMutation<unknown, { deal: ForecastDeal; category: ForecastCategory }>({
    method: "PATCH",
    path: (v) => ws.path(`/deals/${v.deal.id}`),
    body: (v) => ({ forecastCategory: v.category }),
    invalidate: [ws.key("forecast"), ws.key("deals")],
    success: (_, v) => `“${v.deal.name}” → ${FORECAST_CATEGORY_LABELS[v.category]}`,
  });
  const sum = (list: ForecastDeal[]) => {
    const same = list.filter((d) => d.currency === currency).reduce((a, d) => a + d.value, 0);
    const others = list.filter((d) => d.currency !== currency).length;
    return `${formatCurrency(same, currency)}${others ? ` + ${others} in other currencies` : ""}`;
  };
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[920px] text-sm">
        <thead className="border-b border-line bg-well">
          <tr>
            <th className={th}>Deal</th>
            <th className={th}>Owner</th>
            <th className={th}>Stage</th>
            <th className={th}>Closes</th>
            <th className={thNum}>Value</th>
            <th className={thNum} title="Value × the stage's probability">
              Weighted
            </th>
            <th className={`${th} w-40`}>Category</th>
          </tr>
        </thead>
        {groupDeals(deals).map((g) => (
          <tbody key={g.key} className="divide-y divide-line border-b border-line last:border-b-0">
            <tr className="bg-well/60">
              <th scope="rowgroup" colSpan={7} className="px-3 py-1.5 text-left text-xs font-semibold text-text-2">
                {g.label}
                <span className="ml-2 font-normal text-text-3 tabular-nums">
                  {formatNumber(g.deals.length)} · {sum(g.deals)}
                  {g.key === "omitted" && " · not counted"}
                </span>
              </th>
            </tr>
            {g.deals.map((d) => (
              <tr key={d.id} className="hover:bg-hover">
                <td className={`${td} max-w-72`}>
                  <Link href={ws.href(`/deals/${d.id}`)} className="block truncate font-medium text-text hover:text-accent-hi">
                    {d.name}
                  </Link>
                  {(d.contact || d.company) && <span className="block truncate text-xs text-text-3">{d.contact?.fullName || d.company?.name}</span>}
                </td>
                <td className={`${td} text-text-2`}>{d.owner?.name ?? <span className="text-text-3">—</span>}</td>
                <td className={`${td} text-text-2`}>
                  <span className="flex items-center gap-2 whitespace-nowrap">
                    <StageDot stage={d.stage} />
                    {d.stage.name}
                    {d.status === "open" && <span className="text-xs text-text-3 tabular-nums">{d.stage.probability}%</span>}
                  </span>
                </td>
                <td className={`${td} whitespace-nowrap text-text-2`}>{d.status === "won" ? f.date(d.closedAt) : formatCalendarDate(d.expectedCloseDate)}</td>
                <td className={cn(tdNum, "text-text")}>{formatCurrency(d.value, d.currency)}</td>
                <td className={cn(tdNum, "text-text-2")}>{d.weighted === null ? <span className="text-text-3">—</span> : formatCurrency(d.weighted, currency)}</td>
                <td className={td}>
                  {d.status === "open" && canWrite ? (
                    <NativeSelect
                      size="sm"
                      aria-label={`Forecast category for ${d.name}`}
                      value={d.forecastCategory}
                      options={FORECAST_CATEGORY_OPTIONS}
                      disabled={setCategory.isPending && setCategory.variables?.deal.id === d.id}
                      onChange={(e) => setCategory.mutate({ deal: d, category: e.target.value as ForecastCategory })}
                    />
                  ) : d.status === "open" ? (
                    <ForecastCategoryBadge category={d.forecastCategory} />
                  ) : (
                    <span className="text-xs text-text-3">Closed</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </div>
  );
}
