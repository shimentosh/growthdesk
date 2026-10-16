"use client";

import { useMemo, useState, type FormEvent } from "react";
import { useParams, useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Ban, Copy, CopyPlus, Ellipsis, ExternalLink, FileSignature, Link2, ListOrdered, NotebookText, Send, Trash2 } from "lucide-react";
import { quoteTotals, describeQuoteTotals, fromUnits, hasRecurring } from "@growthdesk/shared";
import { copyText } from "@/components/integrations/Copy";
import { ContactPicker, CompanyPicker, MemberPicker, contactLabel } from "@/components/pickers/Pickers";
import { LineItemsEditor, lineKey, type LineDraft } from "@/components/quotes/LineItemsEditor";
import { QuoteTimeline } from "@/components/quotes/QuoteTimeline";
import { SendQuoteModal } from "@/components/quotes/SendQuoteModal";
import { QuoteDocument, QuoteStatusBadge, money, type QuoteDocumentModel } from "@/components/quotes/common";
import { DealPicker } from "@/components/quotes/pickers";
import { Button, IconButton } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/DropdownMenu";
import { QueryState } from "@/components/ui/ErrorState";
import { Field, FormError } from "@/components/ui/Field";
import { IconTile } from "@/components/ui/IconTile";
import { Input, Textarea } from "@/components/ui/Input";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { RequirePermission } from "@/components/ui/RequirePermission";
import { SkeletonText } from "@/components/ui/Skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { useUnsavedChanges } from "@/lib/unsaved";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import type { QuoteDetail } from "@/lib/types/quotes";

type Draft = {
  title: string;
  dealId: string | null;
  contactId: string | null;
  companyId: string | null;
  ownerId: string | null;
  currency: string;
  validUntil: string;
  intro: string;
  terms: string;
  lines: LineDraft[];
};

/** Labels for the pickers' current values, before their lists load. */
type Labels = { deal: string | null; contact: string | null; company: string | null };

const draftOf = (q: QuoteDetail): Draft => ({
  title: q.title,
  dealId: q.deal?.id ?? null,
  contactId: q.contact?.id ?? null,
  companyId: q.company?.id ?? null,
  ownerId: q.owner?.id ?? null,
  currency: q.currency,
  validUntil: q.validUntil ?? "",
  intro: q.intro,
  terms: q.terms,
  lines: q.lineItems.map((l) => ({
    key: lineKey(),
    productId: l.productId,
    name: l.name,
    description: l.description,
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    discountPercent: l.discountPercent,
    taxRate: l.taxRate,
    billingPeriod: l.billingPeriod,
  })),
});

/** The draft without the editor's row keys: what "unsaved changes" compares. */
const comparable = (d: Draft) => JSON.stringify({ ...d, lines: d.lines.map(({ key: _k, ...l }) => l) });

function Editor({ quote }: { quote: QuoteDetail }) {
  const ws = useWorkspace();
  const f = useFormat();
  const router = useRouter();
  const qc = useQueryClient();
  const [baseline, setBaseline] = useState<Draft>(() => draftOf(quote));
  const [draft, setDraft] = useState<Draft>(baseline);
  const [labels, setLabels] = useState<Labels>({ deal: quote.deal?.name ?? null, contact: quote.contact ? quote.contact.fullName || quote.contact.email : null, company: quote.company?.name ?? null });
  const [sending, setSending] = useState(false);
  const [confirm, setConfirm] = useState<"void" | "delete" | null>(null);
  const [tab, setTab] = useState("edit");
  const frozen = quote.status === "accepted" || quote.status === "void";
  const canWrite = ws.can("quotes.write");
  const editable = canWrite && !frozen;
  const dirty = comparable(baseline) !== comparable(draft);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const totals = useMemo(() => quoteTotals(draft.lines), [draft.lines]);

  useUnsavedChanges(dirty && editable, "Your changes to this quote will be lost.");

  const loaded = (q: QuoteDetail) => {
    qc.setQueryData(ws.key("quotes", q.id), q);
    const next = draftOf(q);
    setBaseline(next);
    setDraft(next);
  };
  const save = useApiMutation<QuoteDetail, Record<string, unknown>>({
    method: "PATCH",
    path: ws.path(`/quotes/${quote.id}`),
    invalidate: [ws.key("quotes", "list"), ws.key("deals")],
    success: (q) => (q.status === "draft" && quote.status !== "draft" ? "Saved — the quote is a draft again; send it to reopen it" : "Quote saved"),
    errorToast: false,
    onSuccess: loaded,
  });
  const duplicate = useApiMutation<QuoteDetail, void>({ path: ws.path(`/quotes/${quote.id}/duplicate`), invalidate: [ws.key("quotes")], success: "Duplicated as a new draft", onSuccess: (q) => router.push(ws.href(`/quotes/${q.id}`)) });
  const voidQuote = useApiMutation<QuoteDetail, void>({ path: ws.path(`/quotes/${quote.id}/void`), invalidate: [ws.key("quotes")], success: "Quote voided", errorToast: false });
  const link = useApiMutation<{ url: string; quote: QuoteDetail }, void>({
    path: ws.path(`/quotes/${quote.id}/link`),
    invalidate: [ws.key("quotes")],
    onSuccess: async (r) => {
      qc.setQueryData(ws.key("quotes", quote.id), r.quote);
      await copyText(r.url, quote.status === "draft" ? "Link copied — the quote is now marked as sent" : "Link copied");
    },
  });
  const remove = useApiMutation<unknown, void>({ method: "DELETE", path: ws.path(`/quotes/${quote.id}`), invalidate: [ws.key("quotes")], success: "Draft deleted", errorToast: false, onSuccess: () => router.push(ws.href("/quotes")) });

  const fields = save.error?.fields ?? {};
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({
      title: draft.title.trim(),
      dealId: draft.dealId,
      contactId: draft.contactId,
      companyId: draft.companyId,
      ownerId: draft.ownerId,
      currency: draft.currency.trim().toUpperCase(),
      validUntil: draft.validUntil || null,
      intro: draft.intro,
      terms: draft.terms,
      lineItems: draft.lines.map(({ key: _k, ...l }) => ({ ...l, name: l.name.trim(), quantity: l.quantity.trim() || "1", unitPrice: l.unitPrice.trim() || "0", discountPercent: l.discountPercent.trim() || "0", taxRate: l.taxRate.trim() || "0" })),
    });
  };

  const c = draft.currency || quote.currency;
  // The live preview: the draft as the buyer will see it once saved and sent.
  const preview: QuoteDocumentModel = {
    number: quote.numberLabel,
    title: draft.title,
    currency: c,
    validUntil: draft.validUntil || null,
    sentAt: quote.sentAt,
    intro: draft.intro,
    terms: draft.terms,
    from: { workspaceName: ws.name, legalName: ws.detail.profile.legalName, postalAddress: ws.detail.profile.postalAddress, senderName: "", senderEmail: "" },
    to: { name: labels.contact ?? "", email: "", company: labels.company ?? "" },
    lineItems: draft.lines.map((l, i) => ({ ...l, total: fromUnits(totals.lines[i]?.net ?? 0) })),
    totals: {
      subtotal: fromUnits(totals.subtotal),
      discountTotal: fromUnits(totals.discountTotal),
      taxTotal: fromUnits(totals.taxTotal),
      total: fromUnits(totals.total),
      oneTime: fromUnits(totals.oneTime),
      recurring: { monthly: fromUnits(totals.recurring.monthly), quarterly: fromUnits(totals.recurring.quarterly), yearly: fromUnits(totals.recurring.yearly) },
      summary: describeQuoteTotals(totals, c),
    },
  };

  const sendable = !frozen && quote.status !== "declined" && quote.status !== "expired";
  const lineErrors = Object.fromEntries(Object.entries(fields).filter(([k]) => k.startsWith("lineItems.")));

  return (
    <>
      <PageHeader
        back={{ href: ws.href("/quotes"), label: "Quotes" }}
        icon={<IconTile icon={<FileSignature />} tint="green" size="lg" />}
        title={
          <>
            <span className="text-text-3 tabular-nums">{quote.numberLabel}</span> {draft.title.trim() || quote.title}
          </>
        }
        meta={<QuoteStatusBadge status={quote.status} />}
        description={`${money(fromUnits(totals.total), c)}${hasRecurring(totals) ? ` · ${describeQuoteTotals(totals, c)}` : ""} · updated ${f.relative(quote.updatedAt)}`}
        actions={
          <>
            {dirty && editable && <span className="text-xs text-text-3">Unsaved changes</span>}
            {dirty && editable && (
              <Button onClick={() => (setDraft(baseline), save.reset())} disabled={save.isPending}>
                Discard
              </Button>
            )}
            {editable && (
              <Button variant={dirty ? "primary" : "secondary"} type="submit" form="quote-form" loading={save.isPending} disabled={!dirty}>
                Save
              </Button>
            )}
            {canWrite && sendable && (
              <>
                <Button icon={<Link2 />} loading={link.isPending} disabled={dirty || !quote.lineItems.length} onClick={() => link.mutate()} title={dirty ? "Save your changes first" : undefined}>
                  Copy link
                </Button>
                <Button variant={dirty ? "secondary" : "primary"} icon={<Send />} disabled={dirty || !quote.lineItems.length} onClick={() => setSending(true)} title={dirty ? "Save your changes first" : undefined}>
                  {quote.sentAt && quote.status !== "draft" ? "Send again" : "Send"}
                </Button>
              </>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton label="More actions" icon={<Ellipsis />} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {quote.status !== "draft" && (
                  <DropdownMenuItem icon={<ExternalLink />} onSelect={() => window.open(quote.publicUrl, "_blank", "noopener")}>
                    Open the buyer&apos;s page
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem icon={<Copy />} onSelect={() => void copyText(quote.publicUrl, "Link copied")}>
                  Copy the link only
                </DropdownMenuItem>
                {canWrite && (
                  <>
                    <DropdownMenuItem icon={<CopyPlus />} onSelect={() => duplicate.mutate()}>
                      Duplicate
                    </DropdownMenuItem>
                    {!frozen && (
                      <>
                        <DropdownMenuSeparator />
                        {quote.status === "draft" ? (
                          <DropdownMenuItem danger icon={<Trash2 />} onSelect={() => setConfirm("delete")}>
                            Delete draft
                          </DropdownMenuItem>
                        ) : (
                          <DropdownMenuItem danger icon={<Ban />} onSelect={() => setConfirm("void")}>
                            Void quote
                          </DropdownMenuItem>
                        )}
                      </>
                    )}
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />

      {quote.status === "accepted" && (
        <Callout tone="ok" className="mb-4" title="Accepted — this quote is frozen">
          What was signed cannot change. Duplicate it to make a new version.
        </Callout>
      )}
      {quote.status === "void" && (
        <Callout tone="warn" className="mb-4">
          This quote is void: its page says it was withdrawn. Duplicate it to start again.
        </Callout>
      )}
      {editable && (quote.status === "sent" || quote.status === "viewed") && (
        <Callout tone="info" className="mb-4">
          The buyer has this quote. Saving a change turns it back into a draft — their page says it is being updated — until you send it again.
        </Callout>
      )}
      {!canWrite && (
        <Callout tone="info" className="mb-4">
          You can view this quote; your role cannot change or send it.
        </Callout>
      )}

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <Tabs value={tab} onValueChange={setTab} className="min-w-0">
          <TabsList aria-label="Quote">
            <TabsTrigger value="edit">
              <ListOrdered aria-hidden />
              Edit
            </TabsTrigger>
            <TabsTrigger value="preview">
              <NotebookText aria-hidden />
              Preview
            </TabsTrigger>
          </TabsList>
          <TabsContent value="edit" keepMounted>
            <form id="quote-form" onSubmit={submit} noValidate className="min-w-0">
              <fieldset disabled={!editable} className="flex min-w-0 flex-col gap-4">
                {save.error && !save.error.isPlanLimit && (!Object.keys(fields).length || fields.lineItems) && <FormError error={save.error.message} />}
                <Card>
                  <CardBody className="grid gap-4 sm:grid-cols-2">
                    <Field label="Title" required error={fields.title} className="sm:col-span-2">
                      <Input value={draft.title} maxLength={200} onChange={(e) => set("title", e.target.value)} placeholder="Website rebuild" />
                    </Field>
                    <Field label="Deal" error={fields.dealId}>
                      <DealPicker
                        value={draft.dealId}
                        valueLabel={labels.deal}
                        disabled={!editable}
                        onChange={(id, deal) => {
                          setLabels((l) => ({ ...l, deal: deal?.name ?? null, ...(deal && !draft.contactId && deal.contact ? { contact: deal.contact.fullName || deal.contact.email } : {}), ...(deal && !draft.companyId && deal.company ? { company: deal.company.name } : {}) }));
                          setDraft((d) => ({
                            ...d,
                            dealId: id,
                            // A deal brings its contact and company along when the quote has none yet.
                            contactId: d.contactId ?? deal?.contact?.id ?? null,
                            companyId: d.companyId ?? deal?.company?.id ?? null,
                          }));
                        }}
                      />
                    </Field>
                    <Field label="Contact" error={fields.contactId} hint="Who the quote is for; Send emails them.">
                      <ContactPicker
                        value={draft.contactId}
                        valueLabel={labels.contact}
                        disabled={!editable}
                        onChange={(id, contact) => {
                          setLabels((l) => ({ ...l, contact: contact ? contactLabel(contact) : null, ...(contact?.company && !draft.companyId ? { company: contact.company.name } : {}) }));
                          setDraft((d) => ({ ...d, contactId: id, companyId: d.companyId ?? contact?.company?.id ?? null }));
                        }}
                      />
                    </Field>
                    <Field label="Company" error={fields.companyId}>
                      <CompanyPicker
                        value={draft.companyId}
                        valueLabel={labels.company}
                        disabled={!editable}
                        onChange={(id, company) => {
                          setLabels((l) => ({ ...l, company: company?.name ?? null }));
                          set("companyId", id);
                        }}
                      />
                    </Field>
                    <Field label="Owner" error={fields.ownerId}>
                      <MemberPicker value={draft.ownerId} valueLabel={quote.owner?.name} disabled={!editable} placeholder="Unassigned" onChange={(id) => set("ownerId", id)} />
                    </Field>
                    <Field label="Valid until" error={fields.validUntil} hint="After this date the buyer can no longer accept it.">
                      <Input type="date" value={draft.validUntil} onChange={(e) => set("validUntil", e.target.value)} />
                    </Field>
                    <Field label="Currency" error={fields.currency}>
                      <Input value={draft.currency} maxLength={3} onChange={(e) => set("currency", e.target.value.toUpperCase())} className="font-mono uppercase" />
                    </Field>
                  </CardBody>
                </Card>

                <Card>
                  <CardHeader icon={<ListOrdered />} title="Line items" description="Each line copies its product's price and tax; change them here for this quote only." />
                  <CardBody>
                    <LineItemsEditor lines={draft.lines} onChange={(lines) => set("lines", lines)} totals={totals} currency={c} disabled={!editable} errors={lineErrors} />
                    <dl className="mt-4 ml-auto grid w-full max-w-xs grid-cols-[1fr_auto] gap-x-6 gap-y-1 border-t border-line pt-3 text-sm">
                      <dt className="text-text-3">Subtotal</dt>
                      <dd className="text-right tabular-nums">{money(fromUnits(totals.subtotal), c)}</dd>
                      <dt className="text-text-3">Discounts</dt>
                      <dd className="text-right tabular-nums">−{money(fromUnits(totals.discountTotal), c)}</dd>
                      <dt className="text-text-3">Tax</dt>
                      <dd className="text-right tabular-nums">{money(fromUnits(totals.taxTotal), c)}</dd>
                      <dt className="font-semibold text-text-hi">Total</dt>
                      <dd className="text-right font-semibold text-text-hi tabular-nums">{money(fromUnits(totals.total), c)}</dd>
                      {hasRecurring(totals) && <dd className="col-span-2 text-right text-xs text-text-3">{describeQuoteTotals(totals, c)}</dd>}
                    </dl>
                  </CardBody>
                </Card>

                <Card>
                  <CardBody className="grid gap-4">
                    <Field label="Introduction" error={fields.intro} hint="Shown above the line items.">
                      <Textarea rows={4} value={draft.intro} maxLength={10000} onChange={(e) => set("intro", e.target.value)} placeholder="Thanks for your time last week. Here is what we discussed…" />
                    </Field>
                    <Field label="Terms" error={fields.terms} hint="Payment terms, scope, what happens on acceptance. The signature covers them.">
                      <Textarea rows={6} value={draft.terms} maxLength={20000} onChange={(e) => set("terms", e.target.value)} placeholder="Payment due within 30 days of invoice…" />
                    </Field>
                  </CardBody>
                </Card>
              </fieldset>
            </form>
          </TabsContent>
          <TabsContent value="preview">
            <Card className="overflow-hidden">
              <QuoteDocument doc={preview} />
            </Card>
            <p className="mt-2 text-xs text-text-3">The buyer&apos;s page shows this document, with Accept and Decline under it, once the quote is sent.</p>
          </TabsContent>
        </Tabs>

        <div className="flex min-w-0 flex-col gap-4 xl:pt-[45px]">
          <QuoteTimeline quote={quote} />
        </div>
      </div>

      <SendQuoteModal open={sending} onOpenChange={setSending} quote={quote} />
      <ConfirmDialog
        open={confirm === "void"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Void ${quote.numberLabel}?`}
        confirmLabel="Void quote"
        description="The buyer's page will say it was withdrawn, and it can no longer be accepted. This cannot be undone; duplicate it to start again."
        onConfirm={() => voidQuote.mutateAsync()}
      />
      <ConfirmDialog
        open={confirm === "delete"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Delete ${quote.numberLabel}?`}
        description="The draft is removed. Its number is not reused."
        onConfirm={() => remove.mutateAsync()}
      />
    </>
  );
}

export default function QuoteEditorPage() {
  const ws = useWorkspace();
  const { quoteId } = useParams<{ quoteId: string }>();
  const quote = useApiQuery<QuoteDetail>(ws.key("quotes", quoteId), ws.path(`/quotes/${quoteId}`));
  return (
    <Page width="capped">
      <RequirePermission permission="quotes.read">
        <QueryState
          query={quote}
          loading={
            <Card className="p-4">
              <SkeletonText lines={8} />
            </Card>
          }
        >
          {(q) => <Editor key={q.id} quote={q} />}
        </QueryState>
      </RequirePermission>
    </Page>
  );
}
