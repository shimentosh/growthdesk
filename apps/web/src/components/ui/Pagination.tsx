"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/cn";
import { IconButton } from "./Button";
import { NativeSelect } from "./Input";

export type PaginationProps = {
  /** 1-based, as the API's ListQuery. */
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
  pageSizes?: number[];
  className?: string;
};

/** "1–50 of 1,234" with previous/next and an optional rows-per-page choice. */
export function Pagination({ page, pageSize, total, onPageChange, onPageSizeChange, pageSizes = [25, 50, 100], className }: PaginationProps) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <nav aria-label="Pagination" className={cn("flex flex-wrap items-center justify-between gap-3 text-xs text-text-3", className)}>
      <span className="tabular-nums" aria-live="polite">
        {total === 0 ? "No results" : `${formatNumber(from)}–${formatNumber(to)} of ${formatNumber(total)}`}
      </span>
      <div className="flex items-center gap-3">
        {onPageSizeChange && (
          <label className="flex items-center gap-1.5">
            <span>Rows</span>
            <NativeSelect
              size="sm"
              className="w-16"
              aria-label="Rows per page"
              value={pageSize}
              onChange={(e) => onPageSizeChange(Number(e.target.value))}
              options={pageSizes.map((s) => ({ value: String(s), label: String(s) }))}
            />
          </label>
        )}
        <span className="tabular-nums">
          Page {formatNumber(page)} of {formatNumber(pages)}
        </span>
        <div className="flex items-center gap-1">
          <IconButton label="Previous page" size="sm" variant="secondary" icon={<ChevronLeft />} disabled={page <= 1} onClick={() => onPageChange(page - 1)} />
          <IconButton label="Next page" size="sm" variant="secondary" icon={<ChevronRight />} disabled={page >= pages} onClick={() => onPageChange(page + 1)} />
        </div>
      </div>
    </nav>
  );
}
