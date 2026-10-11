"use client";

import Link from "next/link";
import { AtSign, Inbox, Tag, Type } from "lucide-react";
import { fill } from "@growthdesk/shared";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { Input, NativeSelect } from "@/components/ui/Input";
import { PREVIEW_VARS, useMarketingSetup } from "@/components/marketing/common";
import { useWorkspace } from "@/lib/session";
import type { SectionProps } from "./CampaignEditor";
import type { Draft } from "./editor";

/** Name, subject and preheader, and who it comes from, with an inbox-row preview beside them. */
export function DetailsSection({ value, set, disabled, errors }: SectionProps) {
  const ws = useWorkspace();
  const setup = useMarketingSetup();
  const domains = setup.data?.domains ?? [];
  const usable = domains.filter((d) => d.status === "verified" && !d.pausedAt);
  const current = domains.find((d) => d.id === value.sendingDomainId);
  const options = [
    { value: "", label: "Choose a domain" },
    ...domains.map((d) => ({
      value: d.id,
      label: d.pausedAt ? `${d.domain} (paused)` : d.status === "verified" ? d.domain : `${d.domain} (not verified)`,
      disabled: d.id !== value.sendingDomainId && (d.status !== "verified" || Boolean(d.pausedAt)),
    })),
  ];
  const domainHint =
    setup.data && !usable.length ? (
      <>
        No verified domain yet.{" "}
        <Link href={ws.href("/settings/sending-domains")} className="text-accent-ink hover:underline">
          Set one up in Sending domains
        </Link>
        .
      </>
    ) : current && current.status !== "verified" ? (
      "This domain is not verified, so the campaign cannot be sent from it yet."
    ) : current?.pausedAt ? (
      `Sending from this domain is paused: ${current.pausedReason}`
    ) : (
      "Recipients see this address. Replies go to the reply-to address."
    );

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader icon={<Tag />} title="Campaign" />
          <CardBody>
            <Field label="Name" required error={errors.name} hint="Only your team sees this.">
              <Input value={value.name} maxLength={120} disabled={disabled} onChange={(e) => set("name", e.target.value)} />
            </Field>
          </CardBody>
        </Card>
        <Card>
          <CardHeader icon={<Type />} title="Subject line" description="Personalise with tokens like {{first_name|there}}." />
          <CardBody className="flex flex-col gap-4">
            <Field label="Subject" error={errors.subject} labelAction={<Counter n={value.subject.length} max={250} soft={60} />}>
              <Input value={value.subject} maxLength={250} disabled={disabled} placeholder="What's new this month" onChange={(e) => set("subject", e.target.value)} />
            </Field>
            <Field
              label="Preheader"
              error={errors.preheader}
              hint="The short line inboxes show after the subject. Leave it empty to show the start of the email."
              labelAction={<Counter n={value.preheader.length} max={250} soft={100} />}
            >
              <Input value={value.preheader} maxLength={250} disabled={disabled} placeholder="Three updates and an invitation" onChange={(e) => set("preheader", e.target.value)} />
            </Field>
          </CardBody>
        </Card>
        <Card>
          <CardHeader icon={<AtSign />} title="Sender" />
          <CardBody className="flex flex-col gap-4">
            <Field label="From name" error={errors.fromName} hint="Usually your company or a person people know.">
              <Input value={value.fromName} maxLength={120} disabled={disabled} placeholder={ws.name} onChange={(e) => set("fromName", e.target.value)} />
            </Field>
            <Field label="From address" error={errors.fromLocalPart ?? errors.sendingDomainId} hint={domainHint}>
              <div className="grid grid-cols-[minmax(0,2fr)_auto_minmax(0,3fr)] items-center gap-2">
                <Input
                  aria-label="Address before the @"
                  value={value.fromLocalPart}
                  maxLength={64}
                  disabled={disabled}
                  placeholder="news"
                  onChange={(e) => set("fromLocalPart", e.target.value.toLowerCase().replace(/\s/g, ""))}
                />
                <span aria-hidden className="text-sm text-text-3">
                  @
                </span>
                <NativeSelect
                  aria-label="Sending domain"
                  value={value.sendingDomainId ?? ""}
                  disabled={disabled || setup.isPending}
                  options={options}
                  onChange={(e) => set("sendingDomainId", e.target.value || null)}
                />
              </div>
            </Field>
            <Field label="Reply-to" error={errors.replyTo} hint="Where replies go. Leave empty to use the From address.">
              <Input type="email" value={value.replyTo} maxLength={254} disabled={disabled} placeholder="hello@yourcompany.com" onChange={(e) => set("replyTo", e.target.value.trim())} />
            </Field>
          </CardBody>
        </Card>
      </div>
      <InboxPreview value={value} domain={current?.domain} />
    </div>
  );
}

function Counter({ n, max, soft }: { n: number; max: number; soft: number }) {
  return (
    <span className={n > soft ? "text-xs text-warn-ink tabular-nums" : "text-xs text-text-3 tabular-nums"} title={n > soft ? `Inboxes often cut it off after about ${soft} characters` : undefined}>
      {n}/{max}
    </span>
  );
}

/** First words of the email, which inboxes show when there is no preheader. */
function opening(value: Draft): string {
  const b = value.blocks.find((x) => (x.type === "text" || x.type === "heading") && x.text.trim());
  if (!b || (b.type !== "text" && b.type !== "heading")) return "";
  return fill(b.text, PREVIEW_VARS)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Roughly how the message sits in an inbox list, with the sample recipient's details filled in. */
function InboxPreview({ value, domain }: { value: Draft; domain?: string }) {
  const from = value.fromName.trim() || "Your name";
  const subject = fill(value.subject, PREVIEW_VARS).trim();
  const pre = fill(value.preheader, PREVIEW_VARS).trim() || opening(value);
  return (
    <Card className="lg:sticky lg:top-4">
      <CardHeader icon={<Inbox />} title="In the inbox" description="With sample details for Alex Rivera." />
      <CardBody>
        <div className="rounded-lg border border-line bg-well p-3">
          <div className="flex items-start gap-3">
            <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-sm font-semibold text-accent-ink">
              {from.charAt(0).toUpperCase()}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-sm font-semibold text-text-hi">{from}</span>
                <span className="shrink-0 text-xs text-text-3">Now</span>
              </div>
              <p className={subject ? "truncate text-sm text-text" : "truncate text-sm text-text-3 italic"}>{subject || "No subject yet"}</p>
              <p className="line-clamp-2 text-xs text-text-3">{pre || "Your preheader shows here."}</p>
            </div>
          </div>
        </div>
        <p className="mt-3 text-xs break-words text-text-3">
          From {value.fromLocalPart || "…"}@{domain ?? "your-domain"}
          {value.replyTo ? ` · replies to ${value.replyTo}` : ""}
        </p>
      </CardBody>
    </Card>
  );
}
