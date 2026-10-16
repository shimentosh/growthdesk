"use client";

import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileSignature, PenLine, Printer, ShieldCheck, Type, X } from "lucide-react";
import type { QuoteAcceptInputT, QuotePublicView } from "@growthdesk/shared";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Checkbox } from "@/components/ui/Checkbox";
import { Modal } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Input, Textarea } from "@/components/ui/Input";
import { LoadingBlock } from "@/components/ui/Skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { ApiError, fieldsOf, get, messageOf, post } from "@/lib/api";
import { QuoteDocument, QuoteStatusBadge } from "./common";
import { SignaturePad } from "./SignaturePad";

/*
 * The buyer's quote page (/q/:token). The visitor is the person the quote was
 * sent to, not a Growthdesk user: nothing here asks them to sign in. Opening
 * the page tells the seller it was viewed; "Accept and sign" takes a name,
 * email, optional title, a typed or drawn signature and an explicit "I agree",
 * and POSTs /public/quotes/:token/accept. "Download PDF" is the browser's
 * print dialog, with a print stylesheet that leaves only the A4 document.
 */

/** Fixed, not theme tokens: a typed signature should look like ink on paper in every theme. */
const SCRIPT = { fontFamily: "'Snell Roundhand', 'Segoe Script', 'Bradley Hand', 'Brush Script MT', cursive" };

/** Print: the document alone, light, on A4. The theme tokens are reset to the light values inside the sheet. */
const PRINT_CSS = `
@page { size: A4; margin: 14mm; }
@media print {
  html, body { background: #fff !important; }
  [data-print="hide"] { display: none !important; }
  [data-print="plain"] { padding: 0 !important; background: #fff !important; min-height: 0 !important; }
  .quote-sheet, .quote-sheet * {
    --mat-panel: #fff; --text: #1d1d1f; --text-2: #48484c; --text-3: #6e6e73; --text-hi: #000;
    --line: rgba(0,0,0,.12); --line-strong: rgba(0,0,0,.25);
  }
  .quote-sheet { box-shadow: none !important; border: 0 !important; padding: 0 !important; }
  .quote-frame { box-shadow: none !important; border: 0 !important; }
}
`;

function Signature({ type, data, className }: { type: "typed" | "drawn"; data: string; className?: string }) {
  if (type === "drawn") {
    // eslint-disable-next-line @next/next/no-img-element -- a data: URL the signer drew
    return <img src={data} alt="Signature" className={className ?? "h-16 w-auto"} />;
  }
  return (
    <span style={SCRIPT} className={className ?? "text-3xl text-text-hi"}>
      {data}
    </span>
  );
}

function AcceptedBlock({ a }: { a: NonNullable<QuotePublicView["acceptance"]> }) {
  const at = new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeStyle: "short", timeZone: "UTC" }).format(new Date(a.acceptedAt));
  return (
    <section className="grid gap-4 border-t border-line-strong pt-5 break-inside-avoid sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div>
        <h2 className="mb-2 text-2xs font-medium tracking-wide text-text-3 uppercase">Accepted and signed</h2>
        <div className="flex min-h-16 items-end border-b border-line-strong pb-1">
          <Signature type={a.signatureType} data={a.signature} />
        </div>
        <div className="mt-1.5 text-sm text-text">
          {a.signerName}
          {a.signerTitle && <span className="text-text-3">, {a.signerTitle}</span>}
        </div>
        <div className="text-xs text-text-3">
          {a.signerEmail} · {at} UTC
        </div>
      </div>
      <div className="text-xs text-text-3 sm:self-end">
        <div className="flex items-center gap-1.5 font-medium text-text-2">
          <ShieldCheck aria-hidden className="size-3.5" />
          Document fingerprint (SHA-256)
        </div>
        <code className="mt-1 block font-mono text-[11px] break-all text-text-2">{a.documentHash}</code>
        <p className="mt-1">Identifies exactly the content above as it was accepted.</p>
      </div>
    </section>
  );
}

function AcceptForm({ token, view, onDone }: { token: string; view: QuotePublicView; onDone: (v: QuotePublicView) => void }) {
  const [name, setName] = useState(view.to.name);
  const [email, setEmail] = useState(view.to.email);
  const [title, setTitle] = useState("");
  const [mode, setMode] = useState<"typed" | "drawn">("typed");
  const [typed, setTyped] = useState(view.to.name);
  const [drawn, setDrawn] = useState<string | null>(null);
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const fields = fieldsOf(error);
  const signature = mode === "typed" ? typed.trim() : drawn;
  const ready = Boolean(name.trim() && email.trim() && signature && agree);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready || !signature) return;
    setBusy(true);
    setError(null);
    try {
      const body: QuoteAcceptInputT = { signerName: name.trim(), signerEmail: email.trim(), signerTitle: title.trim() || undefined, signature: { type: mode, data: signature }, agree: true };
      onDone(await post<QuotePublicView>(`/public/quotes/${encodeURIComponent(token)}/accept`, body, { noAuthRedirect: true }));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card id="accept" data-print="hide">
      <CardHeader icon={<FileSignature />} title="Accept and sign" description={`Accepting confirms you agree to quote ${view.number}, ${view.totals.summary}, and its terms.`} />
      <CardBody>
        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
          <FormError error={error && !Object.keys(fields).length ? messageOf(error) : null} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Full name" required error={fields.signerName}>
              <Input
                value={name}
                maxLength={120}
                autoComplete="name"
                onChange={(e) => {
                  // Keep the typed signature in step until they change it themselves.
                  if (typed === name) setTyped(e.target.value);
                  setName(e.target.value);
                }}
              />
            </Field>
            <Field label="Email" required error={fields.signerEmail}>
              <Input type="email" value={email} maxLength={254} autoComplete="email" onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Field label="Title" hint="Optional, e.g. CEO" error={fields.signerTitle} className="sm:col-span-2">
              <Input value={title} maxLength={120} autoComplete="organization-title" onChange={(e) => setTitle(e.target.value)} />
            </Field>
          </div>
          <Tabs value={mode} onValueChange={(v) => setMode(v as "typed" | "drawn")}>
            <TabsList aria-label="How to sign">
              <TabsTrigger value="typed">
                <Type aria-hidden />
                Type
              </TabsTrigger>
              <TabsTrigger value="drawn">
                <PenLine aria-hidden />
                Draw
              </TabsTrigger>
            </TabsList>
            <TabsContent value="typed" keepMounted>
              <Field label="Signature" error={fields["signature.data"]}>
                <Input value={typed} maxLength={120} onChange={(e) => setTyped(e.target.value)} placeholder="Type your name" />
              </Field>
              <div className="mt-2 flex h-20 items-end rounded-md border border-line-strong px-4 pb-2" style={{ background: "#fff" }}>
                <span style={{ ...SCRIPT, color: "#111827" }} className="truncate text-3xl">
                  {typed.trim() || " "}
                </span>
              </div>
            </TabsContent>
            <TabsContent value="drawn" keepMounted>
              <SignaturePad onChange={setDrawn} disabled={busy} />
              {fields["signature.data"] && <p className="mt-1 text-xs text-bad-ink">{fields["signature.data"]}</p>}
            </TabsContent>
          </Tabs>
          <Checkbox
            checked={agree}
            onCheckedChange={setAgree}
            label="I agree to this quote and its terms"
            description="Typing or drawing my name above is my electronic signature. The time, my IP address and browser are recorded with it."
          />
          <Button variant="primary" type="submit" icon={<FileSignature />} loading={busy} disabled={!ready} className="w-full sm:w-auto sm:self-end">
            Accept and sign
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}

function DeclineDialog({ token, open, onOpenChange, onDone }: { token: string; open: boolean; onOpenChange: (o: boolean) => void; onDone: (v: QuotePublicView) => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function decline() {
    setBusy(true);
    setError(null);
    try {
      onDone(await post<QuotePublicView>(`/public/quotes/${encodeURIComponent(token)}/decline`, { reason: reason.trim() }, { noAuthRedirect: true }));
      onOpenChange(false);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Decline this quote?"
      description="The sender is told. You can still ask them for a revised quote."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="danger" loading={busy} onClick={() => void decline()}>
            Decline quote
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <FormError error={error} />
        <Field label="Reason" hint="Optional — it helps them send something that fits.">
          <Textarea rows={4} value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Over our budget for this quarter" />
        </Field>
      </div>
    </Modal>
  );
}

/** What the page says above the document in each state. */
function StatusNotice({ view }: { view: QuotePublicView }) {
  const sender = view.from.senderName || view.from.workspaceName;
  switch (view.status) {
    case "accepted":
      return (
        <Callout tone="ok" title="Accepted">
          {view.acceptance ? `${view.acceptance.signerName} accepted this quote. A copy is below — use Download PDF to keep one.` : "This quote has been accepted."}
        </Callout>
      );
    case "declined":
      return <Callout tone="bad" title="Declined">This quote was declined. Contact {sender} if you would like a revised one.</Callout>;
    case "expired":
      return <Callout tone="warn" title="Expired">This quote is past its valid-until date and can no longer be accepted. Ask {sender} for a new one.</Callout>;
    default:
      return null;
  }
}

export function PublicQuote({ token }: { token: string }) {
  const qc = useQueryClient();
  const key = ["public-quote", token];
  const query = useQuery<QuotePublicView, ApiError>({
    queryKey: key,
    queryFn: ({ signal }) => get<QuotePublicView>(`/public/quotes/${encodeURIComponent(token)}`, { signal, noAuthRedirect: true }),
    retry: false,
    refetchOnWindowFocus: false,
  });
  const [declining, setDeclining] = useState(false);
  const update = (v: QuotePublicView) => {
    qc.setQueryData(key, v);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  if (query.isPending) return <LoadingBlock label="Opening the quote…" className="min-h-dvh" />;

  if (query.isError) {
    return (
      <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-4 py-10">
        <Card>
          <CardBody className="flex flex-col gap-4 px-6 py-7 text-center">
            <h1 className="text-xl font-semibold tracking-[-0.02em] text-text-hi">{query.error.isNotFound ? "This quote can't be found" : "Couldn't open this quote"}</h1>
            <p className="text-sm text-text-3">{query.error.isNotFound ? "The link is incomplete, or the quote was deleted. Ask the sender for a new link." : query.error.message}</p>
            {!query.error.isNotFound && (
              <Button variant="primary" onClick={() => void query.refetch()}>
                Try again
              </Button>
            )}
          </CardBody>
        </Card>
      </div>
    );
  }

  const view = query.data;
  const sender = view.from.senderName || view.from.workspaceName;
  const open = view.status === "sent" || view.status === "viewed";

  // Withdrawn, or being revised: who it is from, not its content.
  if (view.status === "void" || view.status === "draft") {
    return (
      <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-4 py-10">
        <Card>
          <CardBody className="flex flex-col gap-2 px-6 py-7 text-center">
            <div className="text-xs text-text-3">
              {view.number} from {view.from.legalName || view.from.workspaceName}
            </div>
            <h1 className="text-xl font-semibold tracking-[-0.02em] text-text-hi">{view.status === "void" ? "This quote was withdrawn" : "This quote is being updated"}</h1>
            <p className="text-sm text-text-3">
              {view.status === "void" ? `${sender} withdrew it, so it can no longer be accepted.` : `${sender} is making changes. You'll get the new version shortly — this link will show it.`}
            </p>
          </CardBody>
        </Card>
      </div>
    );
  }

  return (
    <div data-print="plain" className="min-h-dvh bg-bg-deep px-3 py-6 sm:px-6 sm:py-10">
      <style>{PRINT_CSS}</style>
      <div className="mx-auto flex max-w-[860px] flex-col gap-4">
        <div data-print="hide" className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-semibold text-text-hi">{view.from.workspaceName}</span>
            <QuoteStatusBadge status={view.status} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button icon={<Printer />} onClick={() => window.print()}>
              Download PDF
            </Button>
            {open && (
              <>
                <Button variant="ghost" icon={<X />} onClick={() => setDeclining(true)}>
                  Decline
                </Button>
                <Button variant="primary" icon={<FileSignature />} onClick={() => document.getElementById("accept")?.scrollIntoView({ behavior: "smooth", block: "start" })}>
                  Accept and sign
                </Button>
              </>
            )}
          </div>
        </div>

        <div data-print="hide">
          <StatusNotice view={view} />
        </div>

        <Card className="quote-frame overflow-hidden">
          <QuoteDocument doc={view} footer={view.acceptance ? <AcceptedBlock a={view.acceptance} /> : undefined} />
        </Card>

        {open && <AcceptForm token={token} view={view} onDone={update} />}

        <p data-print="hide" className="pb-4 text-center text-xs text-text-3">
          Questions? Reply to the email this link came in{view.from.senderEmail ? `, or write to ${view.from.senderEmail}` : ""}. Sent with {view.productName}.
        </p>
      </div>
      <DeclineDialog token={token} open={declining} onOpenChange={setDeclining} onDone={update} />
    </div>
  );
}
