import { TINTS, type Tint } from "@/components/ui/IconTile";
import { cn } from "@/lib/cn";
import type { DealStageRef } from "@/lib/types/pipeline";

/*
 * A pipeline stage's colour. Stages store a colour name ("gray", "blue",
 * "violet", …; see DEFAULT_STAGES in the API), mapped here onto the system
 * tints. Won and Lost read green and red even when left grey.
 */

const ALIASES: Record<string, Tint> = { slate: "gray", zinc: "gray", neutral: "gray", stone: "gray", violet: "purple", fuchsia: "purple", amber: "yellow", lime: "green", emerald: "green", sky: "cyan", rose: "pink" };

export function stageTint(stage: Pick<DealStageRef, "color" | "kind">): Tint {
  const c = (stage.color ?? "").toLowerCase();
  const tint: Tint = (TINTS as readonly string[]).includes(c) ? (c as Tint) : (ALIASES[c] ?? "gray");
  if (tint === "gray" && stage.kind === "won") return "green";
  if (tint === "gray" && stage.kind === "lost") return "red";
  return tint;
}

/** A small dot in the stage's colour, before its name. */
export function StageDot({ stage, className }: { stage: Pick<DealStageRef, "color" | "kind">; className?: string }) {
  return <span aria-hidden className={cn("inline-block size-2 shrink-0 rounded-full", className)} style={{ backgroundColor: `var(--tint-${stageTint(stage)})` }} />;
}
