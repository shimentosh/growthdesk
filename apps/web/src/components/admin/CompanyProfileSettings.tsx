"use client";

import { useState, type FormEvent } from "react";
import { Building2, Mail } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/Card";
import { Field, FormError } from "@/components/ui/Field";
import { EntityTile } from "@/components/ui/icons";
import { Input, Textarea } from "@/components/ui/Input";
import { PageHeader } from "@/components/ui/PageHeader";
import { useApiMutation } from "@/lib/query";
import { useWorkspace, workspaceDetailKey } from "@/lib/session";
import type { WorkspaceDetail } from "@/lib/types";

type Profile = WorkspaceDetail["profile"];

/**
 * The company behind the workspace. Marketing emails print the legal name and
 * postal address in their footer (CAN-SPAM and most inbox providers require a
 * physical address), and use the From name / Reply-To when a campaign sets none.
 */
export function CompanyProfileSettings() {
  const ws = useWorkspace();
  const saved = ws.detail.profile;
  const [draft, setDraft] = useState<Profile>(saved);
  const set = <K extends keyof Profile>(k: K, v: Profile[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const save = useApiMutation<WorkspaceDetail, Partial<Profile>>({
    method: "PATCH",
    path: ws.path(),
    invalidate: [workspaceDetailKey(ws.id)],
    success: "Company profile saved",
    errorToast: false,
  });
  const fields = save.error?.fields ?? {};
  const trimmed: Profile = {
    legalName: draft.legalName.trim(),
    postalAddress: draft.postalAddress.trim(),
    marketingFromName: draft.marketingFromName.trim(),
    marketingReplyTo: draft.marketingReplyTo.trim(),
  };
  const dirty = (Object.keys(trimmed) as (keyof Profile)[]).some((k) => trimmed[k] !== saved[k]);

  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate(trimmed);
  }

  return (
    <>
      <PageHeader icon={<EntityTile of="company" />} title="Company profile" description="Who sends your marketing emails. The legal name and postal address appear in every marketing email footer." />
      <form onSubmit={submit} noValidate className="flex flex-col gap-5">
        <Card>
          <CardHeader icon={<Building2 />} title="Business details" description="Required before a marketing email can be sent." />
          <CardBody className="grid gap-4">
            <FormError error={save.error && !Object.keys(fields).length ? save.error.message : null} />
            <Field label="Legal company name" error={fields.legalName} hint="As registered, e.g. Acme Growth Ltd.">
              <Input value={draft.legalName} onChange={(e) => set("legalName", e.target.value)} maxLength={200} placeholder={ws.name} autoComplete="organization" />
            </Field>
            <Field label="Postal address" error={fields.postalAddress} hint="A street address or registered PO box. Shown as written, line by line.">
              <Textarea
                value={draft.postalAddress}
                onChange={(e) => set("postalAddress", e.target.value)}
                maxLength={500}
                rows={4}
                placeholder={"1 Main Street\nSpringfield, IL 62701\nUnited States"}
                autoComplete="street-address"
              />
            </Field>
          </CardBody>
        </Card>
        <Card>
          <CardHeader icon={<Mail />} title="Marketing email defaults" description="Used when a marketing campaign does not set its own." />
          <CardBody className="grid gap-4 sm:grid-cols-2">
            <Field label="From name" error={fields.marketingFromName} hint="What subscribers see as the sender.">
              <Input value={draft.marketingFromName} onChange={(e) => set("marketingFromName", e.target.value)} maxLength={120} placeholder={ws.name} />
            </Field>
            <Field label="Reply-to address" error={fields.marketingReplyTo} hint="Where replies go. Leave empty to use the sending address.">
              <Input type="email" value={draft.marketingReplyTo} onChange={(e) => set("marketingReplyTo", e.target.value)} maxLength={254} placeholder="hello@yourbrand.com" autoComplete="email" />
            </Field>
          </CardBody>
          <CardFooter>
            <Button type="submit" variant="primary" loading={save.isPending} disabled={!dirty}>
              Save changes
            </Button>
          </CardFooter>
        </Card>
      </form>
    </>
  );
}
