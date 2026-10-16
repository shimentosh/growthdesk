"use client";

import Link from "next/link";
import { localDay } from "@growthdesk/shared";
import { StatusBadge } from "@/components/ui/Badge";
import { COL, ColumnLabel } from "@/components/ui/columns";
import { useFormat, useWorkspace } from "@/lib/session";
import type { Deal } from "@/lib/types/pipeline";
import { NextStepLine, StaleBadge } from "./DealSignals";
import { StageDot } from "./StageDot";
import { formatCalendarDate } from "./utils";

const th = "px-3 py-2 text-left text-xs font-medium whitespace-nowrap text-text-3";
const td = "px-3 py-2 align-middle";

/** Deals as rows (the board's list view). Scrolls sideways on narrow screens. */
export function DealTable({ deals }: { deals: Deal[] }) {
  const ws = useWorkspace();
  const f = useFormat();
  const today = localDay(new Date(), ws.timezone);
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[880px] text-sm">
        <thead className="border-b border-line bg-well">
          <tr>
            <th className={th}>
              <ColumnLabel icon={COL.name}>Deal</ColumnLabel>
            </th>
            <th className={th}>
              <ColumnLabel icon={COL.stage}>Stage</ColumnLabel>
            </th>
            <th className={`${th} text-right`}>
              <ColumnLabel icon={COL.amount}>Value</ColumnLabel>
            </th>
            <th className={th}>
              <ColumnLabel icon={COL.status}>Status</ColumnLabel>
            </th>
            <th className={th}>
              <ColumnLabel icon={COL.person}>Contact / company</ColumnLabel>
            </th>
            <th className={th}>
              <ColumnLabel icon={COL.owner}>Owner</ColumnLabel>
            </th>
            <th className={th}>
              <ColumnLabel icon={COL.due}>Expected close</ColumnLabel>
            </th>
            <th className={th}>
              <ColumnLabel icon={COL.updated}>Updated</ColumnLabel>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {deals.map((d) => (
            <tr key={d.id} className="hover:bg-hover">
              <td className={td}>
                <span className="flex items-center gap-2">
                  <Link href={ws.href(`/deals/${d.id}`)} className="font-medium text-text hover:text-accent-hi">
                    {d.name}
                  </Link>
                  <StaleBadge deal={d} />
                </span>
                {d.status === "open" && <NextStepLine deal={d} today={today} className="mt-0.5 max-w-80" />}
              </td>
              <td className={`${td} text-text-2`}>
                <span className="flex items-center gap-2 whitespace-nowrap">
                  <StageDot stage={d.stage} />
                  {d.stage.name}
                </span>
              </td>
              <td className={`${td} text-right text-text tabular-nums`}>{f.money(d.value, d.currency)}</td>
              <td className={td}>
                <StatusBadge value={d.status} />
              </td>
              <td className={`${td} max-w-64`}>
                {d.contact && (
                  <Link href={ws.href(`/contacts/${d.contact.id}`)} className="block truncate text-text-2 hover:text-text">
                    {d.contact.fullName || d.contact.email || "Unnamed contact"}
                  </Link>
                )}
                {d.company && (
                  <Link href={ws.href(`/companies/${d.company.id}`)} className="block truncate text-xs text-text-3 hover:text-text">
                    {d.company.name}
                  </Link>
                )}
                {!d.contact && !d.company && <span className="text-text-3">—</span>}
              </td>
              <td className={`${td} text-text-2`}>{d.owner?.name || <span className="text-text-3">—</span>}</td>
              <td className={`${td} whitespace-nowrap text-text-2`}>{formatCalendarDate(d.expectedCloseDate)}</td>
              <td className={`${td} whitespace-nowrap text-text-3`}>{f.relative(d.updatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
