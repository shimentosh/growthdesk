"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FileSignature, Plus } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { ErrorState } from "@/components/ui/ErrorState";
import { SkeletonText } from "@/components/ui/Skeleton";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import type { QuoteDetail, QuoteRow } from "@/lib/types/quotes";
import { QuoteStatusBadge, money } from "./common";

/**
 * A deal's quotes (GET /deals/:dealId/quotes): number, status, total and how
 * far each got, plus "New quote", which starts a draft prefilled from the
 * deal (its contact, company, owner, currency and name) and opens it.
 * Renders nothing for a role without quotes.read.
 */
export function DealQuotesPanel({ dealId }: { dealId: string }) {
  const ws = useWorkspace();
  const f = useFormat();
  const router = useRouter();
  const canRead = ws.can("quotes.read");
  const quotes = useApiQuery<QuoteRow[]>(ws.key("quotes", "deal", dealId), canRead ? ws.path(`/deals/${dealId}/quotes`) : null);
  const create = useApiMutation<QuoteDetail, void>({
    path: ws.path("/quotes"),
    body: () => ({ dealId }),
    invalidate: [ws.key("quotes")],
    onSuccess: (q) => router.push(ws.href(`/quotes/${q.id}`)),
  });
  if (!canRead) return null;
  const rows = quotes.data ?? [];

  return (
    <Card>
      <CardHeader
        icon={<FileSignature />}
        title="Quotes"
        description={rows.length ? undefined : "Send a quote the buyer can accept and sign online."}
        actions={
          ws.can("quotes.write") ? (
            <Button size="sm" icon={<Plus />} loading={create.isPending} onClick={() => create.mutate()}>
              New quote
            </Button>
          ) : undefined
        }
      />
      {quotes.isPending ? (
        <CardBody>
          <SkeletonText lines={2} />
        </CardBody>
      ) : quotes.isError ? (
        <ErrorState error={quotes.error} onRetry={() => void quotes.refetch()} />
      ) : rows.length ? (
        <ul className="divide-y divide-line">
          {rows.map((q) => {
            const step = q.acceptedAt
              ? `Accepted ${f.smart(q.acceptedAt)}${q.signerName ? ` by ${q.signerName}` : ""}`
              : q.lastViewedAt
                ? `Viewed ${f.smart(q.lastViewedAt)}`
                : q.sentAt
                  ? `Sent ${f.smart(q.sentAt)}`
                  : `Created ${f.smart(q.createdAt)}`;
            return (
              <li key={q.id}>
                <Link href={ws.href(`/quotes/${q.id}`)} className="flex items-start justify-between gap-3 px-4 py-2.5 hover:bg-hover">
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-text">
                      <span className="text-text-3 tabular-nums">{q.numberLabel}</span> {q.title}
                    </span>
                    <span className="block truncate text-xs text-text-3">{step}</span>
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-1">
                    <span className="text-sm text-text tabular-nums">{money(q.total, q.currency)}</span>
                    <QuoteStatusBadge status={q.status} />
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      ) : (
        <CardBody className="py-3 text-xs text-text-3">No quotes on this deal yet.</CardBody>
      )}
    </Card>
  );
}
