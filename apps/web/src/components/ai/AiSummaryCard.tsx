"use client";

import { RefreshCw, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { SkeletonText } from "@/components/ui/Skeleton";
import { useApiMutation, useApiQuery, useInvalidate } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import type { AiSummaryResult } from "@/lib/types/ai";
import { useAiGate } from "./useAi";

/*
 * AI summary of a contact's or deal's record. Opening the page only looks for
 * a summary already made of the record as it is now (free); "Summarize" asks
 * the AI (one credit). Any change to the record means a new summary.
 */
export function AiSummaryCard({ kind, id }: { kind: "contact" | "deal"; id: string }) {
  const ws = useWorkspace();
  const gate = useAiGate();
  const invalidate = useInvalidate();
  const path = ws.path(`/ai/${kind}s/${id}/summary`);
  const readable = ws.can(kind === "contact" ? "contacts.read" : "deals.read");
  const cached = useApiQuery<AiSummaryResult>(ws.key("ai", "summary", kind, id), gate.state === "hidden" || !readable ? null : path, { staleTime: 60_000 });
  const generate = useApiMutation<AiSummaryResult, { fresh: boolean }>({
    path,
    invalidate: [ws.key("ai", "status")],
    onSuccess: async () => {
      await invalidate(ws.key("ai", "summary", kind, id));
    },
  });

  if (gate.state === "hidden" || !readable) return null;
  const summary = generate.data?.summary ?? cached.data?.summary ?? null;
  const disabled = gate.state === "disabled";

  return (
    <Card>
      <CardHeader
        icon={<Sparkles />}
        title="AI summary"
        actions={
          <Button
            size="sm"
            variant="ghost"
            icon={summary ? <RefreshCw /> : <Sparkles />}
            loading={generate.isPending}
            disabled={disabled}
            title={disabled ? (gate.reason ?? undefined) : undefined}
            onClick={() => generate.mutate({ fresh: Boolean(summary) })}
          >
            {summary ? "Refresh" : "Summarize"}
          </Button>
        }
      />
      <CardBody className="flex flex-col gap-2 text-sm">
        {cached.isLoading || generate.isPending ? (
          <SkeletonText lines={3} />
        ) : summary ? (
          <>
            <p className="whitespace-pre-wrap text-text">{summary.summary}</p>
            {summary.nextSteps.length > 0 && (
              <div>
                <div className="text-xs font-medium text-text-2">Suggested next steps</div>
                <ul className="mt-1 list-disc pl-5 text-text-2">
                  {summary.nextSteps.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              </div>
            )}
            <p className="text-2xs text-text-3">Written by AI from this {kind}&apos;s record — check before acting on it.</p>
          </>
        ) : (
          <p className="text-text-3">{disabled ? gate.reason : `Get a short summary of this ${kind}'s history and suggested next steps. Uses one AI credit.`}</p>
        )}
      </CardBody>
    </Card>
  );
}
