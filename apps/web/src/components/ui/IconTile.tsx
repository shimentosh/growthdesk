import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/*
 * The Apple-style icon tile: a white glyph on a rounded square of one system
 * colour, lit from above. Used where a screen or a settings section introduces
 * itself (page headers, the settings list, empty states). Inline glyphs
 * elsewhere stay monochrome — colour is reserved for these markers.
 */

export const TINTS = ["blue", "cyan", "teal", "mint", "green", "yellow", "orange", "red", "pink", "purple", "indigo", "brown", "gray"] as const;
export type Tint = (typeof TINTS)[number];

const SIZES = {
  /** Settings list rows, menus. */
  sm: "size-[22px] rounded-[6px] [&_svg]:size-3.5",
  /** Card headers, list items. */
  md: "size-8 rounded-[9px] [&_svg]:size-[18px]",
  /** Page headers. */
  lg: "size-10 rounded-[11px] [&_svg]:size-[22px]",
  /** Empty states. */
  xl: "size-14 rounded-[15px] [&_svg]:size-7",
} as const;

export function IconTile({ icon, tint = "gray", size = "md", className }: { icon: ReactNode; tint?: Tint; size?: keyof typeof SIZES; className?: string }) {
  return (
    <span
      aria-hidden
      // Lets containers that grey and resize their glyphs (menu items) leave a tile's own glyph alone.
      data-icon-tile=""
      style={{
        backgroundColor: `var(--tint-${tint})`,
        backgroundImage: "linear-gradient(180deg, rgba(255,255,255,0.22), rgba(255,255,255,0) 60%)",
      }}
      className={cn(
        "inline-flex shrink-0 items-center justify-center text-white shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.08),0_1px_2px_rgba(0,0,0,0.1)] [&_svg]:stroke-[2.25]",
        SIZES[size],
        className,
      )}
    >
      {icon}
    </span>
  );
}

/** A soft, tinted circle behind a tinted glyph — quieter than a tile, for stat cards and inline markers. */
export function IconBadge({ icon, tint = "gray", className }: { icon: ReactNode; tint?: Tint; className?: string }) {
  return (
    <span
      aria-hidden
      style={{ color: `var(--tint-${tint})`, backgroundColor: `color-mix(in srgb, var(--tint-${tint}) 13%, transparent)` }}
      className={cn("inline-flex size-7 shrink-0 items-center justify-center rounded-full [&_svg]:size-[15px]", className)}
    >
      {icon}
    </span>
  );
}
