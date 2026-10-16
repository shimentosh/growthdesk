"use client";

import type { ReactNode } from "react";
import { Ban, CircleCheck, CircleX, Clock, Eye, FilePlus2, Send, ShieldAlert, ShieldCheck } from "lucide-react";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { cn } from "@/lib/cn";
import { useFormat } from "@/lib/session";
import type { QuoteDetail } from "@/lib/types/quotes";

function Step({ icon, done, title, children }: { icon: ReactNode; done: boolean; title: ReactNode; children?: ReactNode }) {
  return (
    <li className="relative flex gap-3 pb-4 last:pb-0">
      <span
        aria-hidden
        className={cn("relative z-10 flex size-6 shrink-0 items-center justify-center rounded-full border [&_svg]:size-3.5", done ? "border-transparent bg-solid text-on-solid" : "border-line-strong bg-panel text-text-3")}
      >
        {icon}
      </span>
      <div className="min-w-0 pt-0.5">
        <div className={cn("text-sm", done ? "text-text" : "text-text-3")}>{title}</div>
        {children && <div className="mt-0.5 text-xs text-text-3">{children}</div>}
      </div>
    </li>
  );
}

/** Where the quote has got to — created, sent, viewed, then accepted (with who signed and the document fingerprint), declined, expired or void. */
export function QuoteTimeline({ quote }: { quote: QuoteDetail }) {
  const f = useFormat();
  const a = quote.acceptance;
  return (
    <Card>
      <CardHeader icon={<Clock />} title="Progress" />
      <CardBody>
        <ol className="relative before:absolute before:top-3 before:bottom-3 before:left-3 before:w-px before:bg-line">
          <Step icon={<FilePlus2 />} done title="Created">
            {f.dateTime(quote.createdAt)}
            {quote.createdBy ? ` by ${quote.createdBy.name || quote.createdBy.email}` : ""}
          </Step>
          <Step icon={<Send />} done={Boolean(quote.sentAt)} title={quote.sentAt ? "Sent" : "Not sent yet"}>
            {quote.sentAt ? `Last sent ${f.dateTime(quote.sentAt)}` : "Send it by email, or copy its link."}
          </Step>
          <Step icon={<Eye />} done={Boolean(quote.firstViewedAt)} title={quote.firstViewedAt ? `Viewed ${quote.viewCount} time${quote.viewCount === 1 ? "" : "s"}` : "Not viewed yet"}>
            {quote.firstViewedAt && (
              <>
                First {f.dateTime(quote.firstViewedAt)}
                {quote.lastViewedAt && quote.viewCount > 1 ? ` · last ${f.relative(quote.lastViewedAt)}` : ""}
              </>
            )}
          </Step>
          {quote.status === "declined" ? (
            <Step icon={<CircleX />} done title="Declined">
              {quote.declinedAt && f.dateTime(quote.declinedAt)}
              {quote.declineReason && <span className="mt-1 block text-text-2">“{quote.declineReason}”</span>}
            </Step>
          ) : quote.status === "void" ? (
            <Step icon={<Ban />} done title="Void">
              Withdrawn; the buyer can no longer accept it.
            </Step>
          ) : quote.status === "expired" ? (
            <Step icon={<Clock />} done title="Expired">
              Past its valid-until date. Change the date and send it again to reopen it.
            </Step>
          ) : (
            <Step icon={<CircleCheck />} done={Boolean(a)} title={a ? "Accepted and signed" : "Not accepted yet"}>
              {a && quote.acceptedAt && (
                <span className="flex flex-col gap-1.5">
                  <span>
                    {a.signerName}
                    {a.signerTitle ? `, ${a.signerTitle}` : ""} · {a.signerEmail}
                    <br />
                    {f.dateTime(quote.acceptedAt)} · {a.signatureType === "drawn" ? "drawn" : "typed"} signature
                  </span>
                  {a.signatureType === "drawn" ? (
                    // eslint-disable-next-line @next/next/no-img-element -- the signer's drawing, a data: URL
                    <img src={a.signature} alt={`Signature of ${a.signerName}`} className="h-12 w-auto self-start rounded-xs border border-line" style={{ background: "#fff" }} />
                  ) : null}
                  <span className={cn("flex items-center gap-1", a.hashMatches ? "text-ok-ink" : "text-bad-ink")}>
                    {a.hashMatches ? <ShieldCheck aria-hidden className="size-3.5" /> : <ShieldAlert aria-hidden className="size-3.5" />}
                    {a.hashMatches ? "Content unchanged since signing" : "The content no longer matches what was signed"}
                  </span>
                  <code className="font-mono text-[11px] break-all text-text-2">sha256 {a.documentHash}</code>
                  <span>
                    IP {a.signerIp || "unknown"} · <span title={a.signerUserAgent}>{a.signerUserAgent.slice(0, 60) || "browser unknown"}</span>
                  </span>
                </span>
              )}
            </Step>
          )}
        </ol>
      </CardBody>
    </Card>
  );
}
