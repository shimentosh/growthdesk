"use client";

import Link from "next/link";
import { StatusBadge } from "@/components/ui/Badge";
import { useFormat, useWorkspace } from "@/lib/session";
import type { Deal } from "@/lib/types/pipeline";
import { StageDot } from "./StageDot";
import { formatCalendarDate } from "./utils";

const th = "px-3 py-2 text-left text-xs font-medium whitespace-nowrap text-text-3";
const td = "px-3 py-2 align-middle";

/** Deals as rows (the board's list view). Scrolls sideways on narrow screens. */
export function DealTable({ deals }: { deals: Deal[] }) {
  const ws = useWorkspace();
  const f = useFormat();
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[880px] text-sm">
        <thead className="border-b border-line bg-well">
          <tr>
            <th className={th}>Deal</th>
            <th className={th}>Stage</th>
            <th className={`${th} text-right`}>Value</th>
            <th className={th}>Status</th>
            <th className={th}>Contact / company</th>
            <th className={th}>Owner</th>
            <th className={th}>Expected close</th>
            <th className={th}>Updated</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {deals.map((d) => (
            <tr key={d.id} className="hover:bg-hover">
              <td className={td}>
                <Link href={ws.href(`/deals/${d.id}`)} className="font-medium text-text hover:text-accent-hi">
                  {d.name}
                </Link>
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
