import type { ReactNode } from "react";
import { BILLING_PERIOD_LABELS, PERIOD_SUFFIX, type BillingPeriod, type QuotePublicView, type QuoteStatus } from "@growthdesk/shared";
import { Badge, type Tone } from "@/components/ui/Badge";
import { cn } from "@/lib/cn";
import { formatCurrency } from "@/lib/format";

/*
 * Pieces the quote screens share: the status chip, money from the API's
 * decimal strings, and the quote document itself — the same component draws
 * the editor's live preview and the buyer's page (/q/<token>), so what the
 * seller previews is what the buyer reads and signs.
 */

const STATUS: Record<QuoteStatus, { tone: Tone; label: string }> = {
  draft: { tone: "mute", label: "Draft" },
  sent: { tone: "live", label: "Sent" },
  viewed: { tone: "info", label: "Viewed" },
  accepted: { tone: "ok", label: "Accepted" },
  declined: { tone: "bad", label: "Declined" },
  expired: { tone: "warn", label: "Expired" },
  void: { tone: "mute", label: "Void" },
};

export const QUOTE_STATUS_LABEL = (s: QuoteStatus) => STATUS[s]?.label ?? s;

export function QuoteStatusBadge({ status, className }: { status: QuoteStatus; className?: string }) {
  const s = STATUS[status] ?? STATUS.draft;
  return (
    <Badge tone={s.tone} dot className={className}>
      {s.label}
    </Badge>
  );
}

/** A decimal string from the API ("1200.50") as money, always with cents. */
export const money = (amount: string | number, currency: string) => formatCurrency(Number(amount), currency, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "12.50" → "12.5", "3.00" → "3": quantities and percentages read without trailing zeros. */
export const plain = (amount: string) => {
  const n = Number(amount);
  return Number.isFinite(n) ? String(n) : amount;
};

export const periodLabel = (p: BillingPeriod) => BILLING_PERIOD_LABELS[p] ?? p;
export const periodSuffix = (p: BillingPeriod) => (p === "one_time" ? "" : PERIOD_SUFFIX[p]);

/** The document the buyer reads: what the seller previews and what the public page prints. */
export type QuoteDocumentModel = Pick<QuotePublicView, "number" | "title" | "currency" | "validUntil" | "sentAt" | "intro" | "terms" | "from" | "to" | "lineItems" | "totals">;

const dateOf = (iso: string | null) => (iso ? new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: "UTC" }).format(new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso)) : null);

function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-2xs font-medium tracking-wide text-text-3 uppercase">{label}</dt>
      <dd className="mt-0.5 text-sm break-words text-text">{children}</dd>
    </div>
  );
}

function Prose({ text, className }: { text: string; className?: string }) {
  return <div className={cn("text-sm leading-relaxed whitespace-pre-line text-text-2", className)}>{text}</div>;
}

export function QuoteDocument({ doc, footer, className }: { doc: QuoteDocumentModel; footer?: ReactNode; className?: string }) {
  const c = doc.currency;
  const anyDiscount = doc.lineItems.some((l) => Number(l.discountPercent) > 0);
  const anyTax = doc.lineItems.some((l) => Number(l.taxRate) > 0);
  const anyRecurring = doc.lineItems.some((l) => l.billingPeriod !== "one_time");
  const fromName = doc.from.legalName || doc.from.workspaceName;
  return (
    <article className={cn("quote-sheet flex flex-col gap-7 bg-panel p-6 text-text sm:p-10", className)}>
      <header className="flex flex-wrap items-start justify-between gap-6">
        <div className="min-w-0">
          <div className="text-lg font-semibold tracking-[-0.015em] text-text-hi">{fromName || "Your company"}</div>
          {doc.from.postalAddress && <div className="mt-1 text-xs whitespace-pre-line text-text-3">{doc.from.postalAddress}</div>}
        </div>
        <div className="text-right">
          <div className="text-2xs font-medium tracking-wide text-text-3 uppercase">Quote</div>
          <div className="text-xl font-semibold tracking-[-0.02em] text-text-hi tabular-nums">{doc.number}</div>
        </div>
      </header>

      <div>
        <h1 className="text-2xl font-semibold tracking-[-0.022em] text-pretty text-text-hi">{doc.title || "Untitled quote"}</h1>
        <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Meta label="Prepared for">
            {doc.to.name || doc.to.email || "—"}
            {doc.to.company && <span className="block text-xs text-text-3">{doc.to.company}</span>}
          </Meta>
          <Meta label="Prepared by">
            {doc.from.senderName || fromName || "—"}
            {doc.from.senderEmail && <span className="block text-xs break-all text-text-3">{doc.from.senderEmail}</span>}
          </Meta>
          <Meta label="Date">{dateOf(doc.sentAt) ?? dateOf(new Date().toISOString())}</Meta>
          <Meta label="Valid until">{dateOf(doc.validUntil) ?? "No expiry"}</Meta>
        </dl>
      </div>

      {doc.intro && <Prose text={doc.intro} />}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-line-strong text-left text-xs text-text-3">
              <th scope="col" className="py-2 pr-3 font-medium">
                Item
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Qty
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Price
              </th>
              {anyDiscount && (
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  Discount
                </th>
              )}
              {anyTax && (
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  Tax
                </th>
              )}
              <th scope="col" className="py-2 pl-3 text-right font-medium">
                Amount
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {doc.lineItems.length === 0 ? (
              <tr>
                <td colSpan={6} className="py-6 text-center text-sm text-text-3">
                  No items yet.
                </td>
              </tr>
            ) : (
              doc.lineItems.map((l, i) => (
                <tr key={i} className="align-top break-inside-avoid">
                  <td className="py-2.5 pr-3">
                    <div className="font-medium text-text">{l.name || "Untitled item"}</div>
                    {l.description && <div className="mt-0.5 text-xs whitespace-pre-line text-text-3">{l.description}</div>}
                    {anyRecurring && <div className="mt-0.5 text-2xs text-text-3">{periodLabel(l.billingPeriod)}</div>}
                  </td>
                  <td className="px-3 py-2.5 text-right text-text-2 tabular-nums">{plain(l.quantity)}</td>
                  <td className="px-3 py-2.5 text-right whitespace-nowrap text-text-2 tabular-nums">
                    {money(l.unitPrice, c)}
                    {periodSuffix(l.billingPeriod)}
                  </td>
                  {anyDiscount && <td className="px-3 py-2.5 text-right text-text-2 tabular-nums">{Number(l.discountPercent) ? `${plain(l.discountPercent)}%` : "—"}</td>}
                  {anyTax && <td className="px-3 py-2.5 text-right text-text-2 tabular-nums">{Number(l.taxRate) ? `${plain(l.taxRate)}%` : "—"}</td>}
                  <td className="py-2.5 pl-3 text-right whitespace-nowrap text-text tabular-nums">
                    {money(l.total, c)}
                    {periodSuffix(l.billingPeriod)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="flex justify-end break-inside-avoid">
        <dl className="grid w-full max-w-xs grid-cols-[1fr_auto] gap-x-6 gap-y-1.5 text-sm">
          <dt className="text-text-3">Subtotal</dt>
          <dd className="text-right text-text-2 tabular-nums">{money(doc.totals.subtotal, c)}</dd>
          {Number(doc.totals.discountTotal) !== 0 && (
            <>
              <dt className="text-text-3">Discounts</dt>
              <dd className="text-right text-text-2 tabular-nums">−{money(doc.totals.discountTotal, c)}</dd>
            </>
          )}
          {Number(doc.totals.taxTotal) !== 0 && (
            <>
              <dt className="text-text-3">Tax</dt>
              <dd className="text-right text-text-2 tabular-nums">{money(doc.totals.taxTotal, c)}</dd>
            </>
          )}
          <dt className="border-t border-line-strong pt-2 font-semibold text-text-hi">Total</dt>
          <dd className="border-t border-line-strong pt-2 text-right font-semibold text-text-hi tabular-nums">{money(doc.totals.total, c)}</dd>
          {anyRecurring && doc.totals.summary && <dd className="col-span-2 text-right text-xs text-text-3">{doc.totals.summary}</dd>}
        </dl>
      </div>

      {doc.terms && (
        <section className="break-inside-avoid">
          <h2 className="mb-1.5 text-2xs font-medium tracking-wide text-text-3 uppercase">Terms</h2>
          <Prose text={doc.terms} className="text-xs" />
        </section>
      )}
      {footer}
    </article>
  );
}
