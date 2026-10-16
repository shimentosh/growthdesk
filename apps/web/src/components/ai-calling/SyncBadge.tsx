"use client";

import { Badge } from "@/components/ui/Badge";
import { Tooltip } from "@/components/ui/Tooltip";
import type { AiAgent } from "@/lib/types/ai-calling";

/** Whether the agent's latest version is saved on Cartesia; when not, why (on hover — callers also show it in text). */
export function SyncBadge({ sync }: { sync: AiAgent["sync"] }) {
  if (sync.saved) return <Badge tone="ok">Saved to Cartesia</Badge>;
  return (
    <Tooltip content={sync.error || "Not saved to Cartesia yet. It is saved again before its next call."}>
      <span className="inline-flex">
        <Badge tone="warn" dot>
          Not saved
        </Badge>
      </span>
    </Tooltip>
  );
}
