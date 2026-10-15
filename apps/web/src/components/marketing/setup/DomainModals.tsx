"use client";

import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Modal } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { toast } from "@/components/ui/Toast";
import { useMarketing } from "@/components/marketing/common";
import { useApiMutation } from "@/lib/query";
import type { ApiError } from "@/lib/api";
import type { EspConnection, MarketingSetup, SendingDomain } from "@/lib/types/marketing";
import { formErrorOf } from "./errors";

/** "s1, s2 s3" → ["s1", "s2", "s3"]. The API lower-cases and checks each one. */
const parseSelectors = (s: string) =>
  s
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);

/** Field errors for the selector list arrive as "dkimSelectors" or "dkimSelectors.1". */
const selectorError = (e: ApiError | null) => {
  if (!e) return undefined;
  const k = Object.keys(e.fields).find((x) => x.startsWith("dkimSelectors"));
  return k ? e.fields[k] : undefined;
};

const SELECTOR_HINT = "Up to five, separated by commas. For Amazon SES, the three Easy DKIM tokens from the identity's page.";

/** Add a sending domain: the domain and, optionally, its DKIM selectors. */
export function AddDomainModal({ open, onOpenChange, esp }: { open: boolean; onOpenChange: (open: boolean) => void; esp: EspConnection | null }) {
  // Resend creates the domain and its DKIM key itself: there are no selectors to ask for.
  const managed = esp?.provider === "resend";
  const mk = useMarketing();
  const [domain, setDomain] = useState("");
  const [selectors, setSelectors] = useState("");

  const add = useApiMutation<SendingDomain, { domain: string; dkimSelectors: string[] }>({
    path: mk.path("/domains"),
    invalidate: [mk.key("setup")],
    success: (d) => (d.esp ? `${d.domain} added to Resend. Publish the records it shows, then verify.` : `${d.domain} added. Publish its DNS records, then verify.`),
    errorToast: false,
    onSuccess: () => {
      setDomain("");
      setSelectors("");
      onOpenChange(false);
    },
  });
  const fields = add.error?.fields ?? {};

  const close = (next: boolean) => {
    if (!next) add.reset();
    onOpenChange(next);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    add.mutate({ domain: domain.trim(), dkimSelectors: managed ? [] : parseSelectors(selectors) });
  };

  return (
    <Modal
      open={open}
      onOpenChange={close}
      title="Add a sending domain"
      description="Use a subdomain only for marketing, such as news.yourbrand.com, so newsletters and outreach keep separate reputations."
      footer={
        <>
          <Button onClick={() => close(false)} disabled={add.isPending}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="add-domain" icon={<Plus />} loading={add.isPending}>
            {managed ? "Add to Resend" : "Add domain"}
          </Button>
        </>
      }
    >
      <form id="add-domain" onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <FormError error={formErrorOf(add.error)} />
        <Field label="Domain" required error={fields.domain}>
          <Input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="news.yourbrand.com" autoComplete="off" autoFocus className="font-mono" />
        </Field>
        {managed ? (
          <Callout tone="info">The domain is created in your Resend account, which generates its DKIM key. Its DNS records appear here right after, ready to copy.</Callout>
        ) : (
          <Field label="DKIM selectors" hint={SELECTOR_HINT} error={selectorError(add.error)}>
            <Input value={selectors} onChange={(e) => setSelectors(e.target.value)} placeholder="s1, s2" autoComplete="off" className="font-mono" />
          </Field>
        )}
      </form>
    </Modal>
  );
}

const sameSet = (a: string[], b: string[]) => [...new Set(a)].sort().join() === [...new Set(b)].sort().join();

/**
 * Change which DKIM selectors a domain's check looks for. A changed set is
 * checked in DNS straight away (the answer is the re-checked domain), so a
 * verified domain whose new selector is not published yet fails, and its
 * campaigns pause at their next batch.
 */
export function SelectorsModal({ open, onOpenChange, domain }: { open: boolean; onOpenChange: (open: boolean) => void; domain: SendingDomain }) {
  const mk = useMarketing();
  const qc = useQueryClient();
  const [value, setValue] = useState(domain.dkimSelectors.join(", "));
  const changed = !sameSet(parseSelectors(value.toLowerCase()), domain.dkimSelectors);

  const save = useApiMutation<SendingDomain, string[]>({
    method: "PATCH",
    path: mk.path(`/domains/${domain.id}`),
    body: (dkimSelectors) => ({ dkimSelectors }),
    errorToast: false,
    onSuccess: (r) => {
      // Show the re-checked domain at once; the refetch behind it confirms.
      qc.setQueryData<MarketingSetup>(mk.key("setup"), (s) => (s ? { ...s, domains: s.domains.map((x) => (x.id === r.id ? r : x)) } : s));
      void qc.invalidateQueries({ queryKey: mk.key("setup") });
      if (domain.status === "verified" && r.status !== "verified")
        toast.warn(`${r.domain} no longer passes its checks`, { description: "Publish the new DKIM record, then verify. Sending from it is paused until then." });
      else toast.success(r.status === "verified" ? "DKIM selectors saved and checked" : "DKIM selectors saved");
      onOpenChange(false);
    },
  });
  const fieldError = selectorError(save.error);
  const formError = formErrorOf(save.error);

  const change = (next: boolean) => {
    if (next) setValue(domain.dkimSelectors.join(", "));
    else save.reset();
    onOpenChange(next);
  };

  return (
    <Modal
      open={open}
      onOpenChange={change}
      size="sm"
      title="DKIM selectors"
      description={`The selectors your email service signs ${domain.domain} with.`}
      footer={
        <>
          <Button onClick={() => change(false)} disabled={save.isPending}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form={`selectors-${domain.id}`} loading={save.isPending}>
            Save
          </Button>
        </>
      }
    >
      <form
        id={`selectors-${domain.id}`}
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(parseSelectors(value));
        }}
        className="flex flex-col gap-4"
        noValidate
      >
        <FormError error={formError} />
        <Field label="Selectors" hint={SELECTOR_HINT} error={fieldError}>
          <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder="s1, s2" autoComplete="off" autoFocus className="font-mono" />
        </Field>
        {domain.status === "verified" && changed && (
          <Callout tone="warn">
            Saving checks {domain.domain} again. If a new selector isn&apos;t in DNS yet, the domain stops passing and sending from it pauses until it verifies.
          </Callout>
        )}
      </form>
    </Modal>
  );
}
