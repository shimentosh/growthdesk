import type { ReactNode, TdHTMLAttributes, ThHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

/*
 * The plain data table these screens share: a hairline-ruled table that
 * scrolls sideways on a phone rather than squeezing its columns.
 */

export function Table({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn("overflow-x-auto", className)}>
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  );
}

export function Th({ className, align, ...rest }: ThHTMLAttributes<HTMLTableCellElement> & { align?: "left" | "right" }) {
  return (
    <th
      scope="col"
      {...rest}
      className={cn(
        "border-b border-line px-4 py-2 text-xs font-medium whitespace-nowrap text-text-3",
        align === "right" ? "text-right" : "text-left",
        className,
      )}
    />
  );
}

export function Td({ className, align, ...rest }: TdHTMLAttributes<HTMLTableCellElement> & { align?: "left" | "right" }) {
  return <td {...rest} className={cn("border-b border-line px-4 py-2.5 align-middle", align === "right" && "text-right tabular-nums", className)} />;
}
