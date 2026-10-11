import { LoaderCircle } from "lucide-react";
import type { CSSProperties } from "react";
import { cn } from "@/lib/cn";

/** A placeholder block while data loads. Size it with className (h-4 w-32 …). */
export function Skeleton({ className, style }: { className?: string; style?: CSSProperties }) {
  return <div aria-hidden className={cn("animate-pulse rounded-xs bg-s-4", className)} style={style} />;
}

/** A few lines of placeholder text. */
export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div aria-hidden className={cn("flex flex-col gap-2", className)}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className="h-3.5" style={{ width: `${i === lines - 1 ? 60 : 100 - i * 7}%` }} />
      ))}
    </div>
  );
}

const SPINNER_SIZE = { xs: "size-3", sm: "size-3.5", md: "size-4", lg: "size-6" } as const;

/** An indeterminate spinner. Pass `label` when it is the only thing telling a screen reader something is happening. */
export function Spinner({ size = "md", label, className }: { size?: keyof typeof SPINNER_SIZE; label?: string; className?: string }) {
  return (
    <span role={label ? "status" : undefined} className={cn("inline-flex items-center", className)}>
      <LoaderCircle aria-hidden className={cn("animate-spin text-text-3", SPINNER_SIZE[size])} />
      {label && <span className="sr-only">{label}</span>}
    </span>
  );
}

/** A centred spinner with a caption, for a whole section or page that is loading. */
export function LoadingBlock({ label = "Loading…", className }: { label?: string; className?: string }) {
  return (
    <div role="status" className={cn("flex min-h-40 flex-col items-center justify-center gap-2 text-xs text-text-3", className)}>
      <LoaderCircle aria-hidden className="size-5 animate-spin" />
      <span>{label}</span>
    </div>
  );
}
