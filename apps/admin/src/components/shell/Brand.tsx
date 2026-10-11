import { ShieldCheck } from "lucide-react";
import { IconTile } from "@/components/ui/IconTile";
import { cn } from "@/lib/cn";

/*
 * The operator console's mark: the Growthdesk name with a "Console" tag on an
 * indigo shield tile, so it never reads as the customer app (blue chart tile).
 */

export function ConsoleTile({ size = "md", className }: { size?: "sm" | "md" | "lg" | "xl"; className?: string }) {
  return <IconTile icon={<ShieldCheck />} tint="indigo" size={size} className={className} />;
}

export function ConsoleWordmark({ className, subtitle }: { className?: string; subtitle?: string }) {
  return (
    <span className={cn("flex min-w-0 flex-col leading-tight", className)}>
      <span className="flex items-center gap-1.5 truncate text-sm font-semibold tracking-[-0.01em] text-text-hi">
        Growthdesk
        <span className="rounded-xs bg-s-4 px-1 py-px text-2xs font-semibold tracking-wide text-text-2 uppercase">Console</span>
      </span>
      {subtitle && <span className="truncate text-2xs text-text-3">{subtitle}</span>}
    </span>
  );
}
