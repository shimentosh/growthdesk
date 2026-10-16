import { initials } from "@/lib/format";
import { cn } from "@/lib/cn";

const SIZES = {
  xs: "size-5 text-[9px]",
  sm: "size-6 text-[10px]",
  md: "size-8 text-xs",
  lg: "size-10 text-sm",
} as const;

/** A stable hue per person, so the same name always gets the same colour. */
const HUES = ["blue", "purple", "teal", "orange", "pink", "indigo", "green", "cyan", "red", "brown"] as const;
export function hueOf(seed: string): (typeof HUES)[number] {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return HUES[Math.abs(h) % HUES.length]!;
}

/**
 * Initials in a neutral circle (or, with `colored`, a soft circle in the person's own hue). Decorative by default (the name is almost
 * always written beside it); pass `labelled` when it stands alone.
 */
export function Avatar({
  name,
  email,
  size = "md",
  labelled,
  colored,
  className,
}: {
  name?: string | null;
  email?: string | null;
  size?: keyof typeof SIZES;
  labelled?: boolean;
  colored?: boolean;
  className?: string;
}) {
  const text = initials(name, email);
  const who = name || email || "Unknown";
  const hue = colored ? hueOf(who.toLowerCase()) : null;
  return (
    <span
      {...(labelled ? { role: "img", "aria-label": who } : { "aria-hidden": true })}
      title={who}
      style={hue ? { color: `var(--tint-${hue})`, backgroundColor: `color-mix(in srgb, var(--tint-${hue}) 16%, transparent)` } : undefined}
      className={cn("inline-flex shrink-0 items-center justify-center rounded-full font-semibold select-none", !hue && "bg-s-5 text-text-2", SIZES[size], className)}
    >
      {text}
    </span>
  );
}
