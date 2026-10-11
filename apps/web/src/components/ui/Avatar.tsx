import { initials } from "@/lib/format";
import { cn } from "@/lib/cn";

const SIZES = {
  xs: "size-5 text-[9px]",
  sm: "size-6 text-[10px]",
  md: "size-8 text-xs",
  lg: "size-10 text-sm",
} as const;

/**
 * Initials in a neutral circle. Decorative by default (the name is almost
 * always written beside it); pass `labelled` when it stands alone.
 */
export function Avatar({
  name,
  email,
  size = "md",
  labelled,
  className,
}: {
  name?: string | null;
  email?: string | null;
  size?: keyof typeof SIZES;
  labelled?: boolean;
  className?: string;
}) {
  const text = initials(name, email);
  const who = name || email || "Unknown";
  return (
    <span
      {...(labelled ? { role: "img", "aria-label": who } : { "aria-hidden": true })}
      title={who}
      className={cn("inline-flex shrink-0 items-center justify-center rounded-full bg-s-5 font-semibold text-text-2 select-none", SIZES[size], className)}
    >
      {text}
    </span>
  );
}
