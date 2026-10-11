"use client";

import { useState, type FormEvent } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { ArrowRight, CalendarClock, CircleAlert, CircleCheck, ClipboardCheck, FileText, FlaskConical, MailCheck, MailX, Send } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { KeyValueList } from "@/components/ui/KeyValue";
import { SkeletonText } from "@/components/ui/Skeleton";
import { useMarketing, useMarketingLists, useMarketingSetup } from "@/components/marketing/common";
import type { ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";
import { formatNumber, utcToZonedInput, zoneAbbreviation, zonedInputToUtc } from "@/lib/format";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useFormat, useMe, useWorkspace } from "@/lib/session";
import type { SavedView } from "@/lib/types/crm";
import type { CampaignReadiness, MarketingCampaign, TestSendResult } from "@/lib/types/marketing";
import { audienceSummary, plural } from "./common";
import { SECTION_LABEL, problemHome, type EditableSection, type ProblemHome } from "./editor";

type Check = { home: ProblemHome; label: string; okText: string };
const CHECKS: Check[] = [
  { home: "details", label: "Sender and subject", okText: "From address, name and subject are set." },
  { home: "audience", label: "Audience", okText: "At least one list, with people who can receive it." },
  { home: "content", label: "Content", okText: "Text, and full links on every button and image." },
  { home: "setup", label: "Sending setup", okText: "Email service connected and the domain verified." },
  { home: "profile", label: "Company profile", okText: "Legal name and postal address for the footer." },
  { home: "plan", label: "Plan", okText: "" },
];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The last step: what is still missing (GET readiness, grouped by where it is
 * fixed), a summary, a test send, and send now or schedule.
 */
export function ReviewSection({
  campaign,
  readiness,
  dirtySections,
  saving,
  onSaveAll,
  goTo,
  onSent,
}: {
  campaign: MarketingCampaign;
  readiness: UseQueryResult<CampaignReadiness, ApiError>;
  dirtySections: EditableSection[];
  saving: boolean;
  onSaveAll: () => Promise<unknown>;
  goTo: (section: EditableSection) => void;
  onSent: (c: MarketingCampaign) => void;
}) {
  const ws = useWorkspace();
  const canSend = ws.can("marketing.send");
  const r = readiness.data;
  const dirty = dirtySections.length > 0;

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="flex flex-col gap-4">
        {dirty && (
          <Callout
            tone="warn"
            title="You have unsaved changes"
            action={
              ws.can("marketing.write") ? (
                <Button size="sm" variant="primary" loading={saving} onClick={() => void onSaveAll().catch(() => undefined)}>
                  Save all
                </Button>
              ) : undefined
            }
          >
            In {dirtySections.map((s) => SECTION_LABEL[s]).join(", ")}. The checks, tests and the send use the saved version.
          </Callout>
        )}
        <Checklist readiness={readiness} goTo={goTo} />
        <Summary campaign={campaign} recipients={r?.recipients} />
      </div>
      <div className="flex flex-col gap-4">
        {canSend ? (
          <>
            <TestSend campaign={campaign} dirty={dirty} onSaveAll={onSaveAll} />
            <SendCard campaign={campaign} readiness={r} blocked={dirty} onSent={onSent} />
          </>
        ) : (
          <Callout tone="info" title="Sending needs another role">
            Your role can prepare campaigns but not send them. Ask someone with the Send permission for marketing to review and send it.
          </Callout>
        )}
      </div>
    </div>
  );
}

function Checklist({ readiness, goTo }: { readiness: UseQueryResult<CampaignReadiness, ApiError>; goTo: (s: EditableSection) => void }) {
  const ws = useWorkspace();
  if (readiness.isPending)
    return (
      <Card className="p-4">
        <SkeletonText lines={5} />
      </Card>
    );
  if (readiness.isError) return <Callout tone="bad">Could not check whether the campaign is ready: {readiness.error.message}</Callout>;
  const r = readiness.data;
  const by = (home: ProblemHome) => r.problems.filter((p) => problemHome(p) === home);
  const fix = (home: ProblemHome) => {
    if (home === "setup") return { label: "Sending domains", href: ws.href("/settings/sending-domains") };
    if (home === "profile") return { label: "Company profile", href: ws.href("/settings/company") };
    if (home === "plan") return ws.can("billing.read") ? { label: "Plans", href: ws.href("/billing") } : null;
    return { label: home === "content" ? "Edit content" : `Edit ${SECTION_LABEL[home].toLowerCase()}`, section: home };
  };
  return (
    <Card>
      <CardHeader
        icon={r.ready ? <CircleCheck className="text-ok-ink" /> : <ClipboardCheck />}
        title={r.ready ? "Ready to send" : "Before you send"}
        description={r.ready ? "Everything the send checks is in place." : `${plural(r.problems.length, "thing")} to fix. Sending is refused until then.`}
      />
      <ul className="divide-y divide-line border-t border-line">
        {CHECKS.map((c) => {
          const problems = by(c.home);
          if (c.home === "plan" && !problems.length) return null;
          const ok = problems.length === 0;
          const action = ok ? null : fix(c.home);
          return (
            <li key={c.home} className="flex items-start gap-3 px-4 py-3">
              {ok ? <CircleCheck aria-label="Done" className="mt-0.5 size-4 shrink-0 text-ok-ink" /> : <CircleAlert aria-label="To fix" className="mt-0.5 size-4 shrink-0 text-bad-ink" />}
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-text">{c.label}</p>
                {ok ? (
                  <p className="text-xs text-text-3">{c.okText}</p>
                ) : (
                  <ul className="mt-0.5 flex flex-col gap-0.5 text-sm text-text-2">
                    {problems.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                )}
              </div>
              {action &&
                ("section" in action ? (
                  <Button size="sm" iconRight={<ArrowRight />} onClick={() => goTo(action.section as EditableSection)}>
                    {action.label}
                  </Button>
                ) : (
                  <Button size="sm" iconRight={<ArrowRight />} href={action.href}>
                    {action.label}
                  </Button>
                ))}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function Summary({ campaign: c, recipients }: { campaign: MarketingCampaign; recipients?: number }) {
  const ws = useWorkspace();
  const lists = useMarketingLists(true);
  const views = useApiQuery<SavedView[]>(ws.key("views", "contact"), ws.path("/views"), { query: { entity: "contact" } });
  const none = <span className="text-text-3">Not set</span>;
  return (
    <Card>
      <CardHeader icon={<FileText />} title="Summary" />
      <CardBody>
        <KeyValueList
          items={[
            { label: "Subject", value: c.subject || none },
            { label: "Preheader", value: c.preheader || <span className="text-text-3">None (inboxes show the start of the email)</span> },
            { label: "From", value: c.fromEmail ? `${c.fromName || "—"} <${c.fromEmail}>` : none },
            { label: "Reply-to", value: c.replyTo || <span className="text-text-3">The From address</span> },
            {
              label: "Audience",
              value: (
                <>
                  {audienceSummary(c.audience, lists.data, views.data?.find((v) => v.id === c.audience.viewId)?.name)}
                  {recipients !== undefined && <span className="block text-xs text-text-3">{plural(recipients, "person", "people")} right now</span>}
                </>
              ),
            },
            { label: "Tracking", value: c.trackOpens && c.trackClicks ? "Opens and clicks" : c.trackOpens ? "Opens" : c.trackClicks ? "Clicks" : "Off" },
          ]}
        />
      </CardBody>
    </Card>
  );
}

function TestSend({ campaign, dirty, onSaveAll }: { campaign: MarketingCampaign; dirty: boolean; onSaveAll: () => Promise<unknown> }) {
  const mk = useMarketing();
  const me = useMe();
  const setup = useMarketingSetup();
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState("");
  const value = text ?? me.data?.user.email ?? "";
  const test = useApiMutation<TestSendResult, string[]>({
    path: mk.path(`/campaigns/${campaign.id}/test`),
    body: (emails) => ({ emails }),
    errorToast: false,
    onError: (e) => setError(e.fields?.emails ?? e.message),
  });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    const emails = [...new Set(value.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean))];
    if (!emails.length) return setError("Enter at least one email address.");
    if (emails.length > 5) return setError("Send to five addresses at most.");
    const bad = emails.find((x) => !EMAIL_RE.test(x));
    if (bad) return setError(`“${bad}” is not an email address.`);
    try {
      if (dirty) await onSaveAll();
      test.mutate(emails);
    } catch {
      /* the save shows its own error */
    }
  };
  const results = test.data?.results;
  const isMailpit = setup.data?.esp?.provider === "smtp_relay" && /^(127\.0\.0\.1|localhost)$/.test(setup.data.esp.host);
  return (
    <Card>
      <CardHeader icon={<FlaskConical />} title="Send a test" description="Up to five addresses. The subject starts with [Test] and the unsubscribe link does nothing." />
      <CardBody>
        <form onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-3">
          <Field label="Send to" error={error || undefined} hint={isMailpit ? "This workspace sends through a local test inbox (Mailpit)." : "Separate addresses with commas."}>
            <div className="flex gap-2">
              <Input value={value} onChange={(e) => setText(e.target.value)} placeholder="you@company.com, colleague@company.com" className="min-w-0 flex-1" invalid={Boolean(error)} />
              <Button type="submit" icon={<Send />} loading={test.isPending}>
                {dirty ? "Save and send test" : "Send test"}
              </Button>
            </div>
          </Field>
          {results && (
            <ul className="flex flex-col gap-1.5 rounded-md border border-line bg-well p-3 text-sm" aria-live="polite">
              {results.map((x) => (
                <li key={x.email} className="flex items-start gap-2">
                  {x.sent ? <MailCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-ok-ink" /> : <MailX aria-hidden className="mt-0.5 size-4 shrink-0 text-bad-ink" />}
                  <span className="min-w-0">
                    <span className="text-text">{x.email}</span>
                    <span className={cn("block text-xs", x.sent ? "text-text-3" : "text-bad-ink")}>{x.sent ? "Sent" : x.error || "Not sent"}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </form>
      </CardBody>
    </Card>
  );
}

function SendCard({
  campaign,
  readiness,
  blocked,
  onSent,
}: {
  campaign: MarketingCampaign;
  readiness?: CampaignReadiness;
  blocked: boolean;
  onSent: (c: MarketingCampaign) => void;
}) {
  const mk = useMarketing();
  const f = useFormat();
  const [mode, setMode] = useState<"now" | "later">("now");
  const [at, setAt] = useState(() => utcToZonedInput(new Date(Date.now() + 60 * 60_000), f.timeZone));
  const [confirm, setConfirm] = useState(false);
  const scheduledAt = mode === "later" ? zonedInputToUtc(at, f.timeZone) : null;
  const tooSoon = mode === "later" && (!scheduledAt || new Date(scheduledAt).getTime() < Date.now() + 2 * 60_000);
  const send = useApiMutation<MarketingCampaign, void>({
    path: mk.path(`/campaigns/${campaign.id}/send`),
    body: () => (scheduledAt ? { scheduledAt } : {}),
    invalidate: [mk.key("campaigns", "list")],
    errorToast: false,
    success: (c) => (c.status === "scheduled" ? "Campaign scheduled" : "Sending started"),
    onSuccess: (c) => onSent(c),
  });
  const n = readiness?.recipients ?? 0;
  const ready = Boolean(readiness?.ready);
  const disabled = !ready || blocked || tooSoon;
  return (
    <Card>
      <CardHeader icon={<Send />} title="Send" description="The recipients are fixed when sending starts. You can pause or cancel while it sends." />
      <CardBody className="flex flex-col gap-4">
        <div role="radiogroup" aria-label="When" className="grid grid-cols-2 gap-2">
          {(
            [
              ["now", "Send now", "Starts within a minute", Send],
              ["later", "Schedule", "Pick a date and time", CalendarClock],
            ] as const
          ).map(([v, label, hint, Icon]) => (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={mode === v}
              onClick={() => setMode(v)}
              className={cn(
                "flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors",
                mode === v ? "border-accent bg-accent-soft" : "border-line hover:bg-hover",
              )}
            >
              <Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", mode === v ? "text-accent-ink" : "text-text-3")} />
              <span>
                <span className="block text-sm font-medium text-text">{label}</span>
                <span className="block text-xs text-text-3">{hint}</span>
              </span>
            </button>
          ))}
        </div>
        {mode === "later" && (
          <Field
            label="Send at"
            hint={`${f.timeZone} (${zoneAbbreviation(f.timeZone)}), the workspace time zone.`}
            error={at && tooSoon ? "Pick a time at least a few minutes from now." : undefined}
          >
            <Input type="datetime-local" value={at} min={utcToZonedInput(new Date(), f.timeZone)} onChange={(e) => setAt(e.target.value)} />
          </Field>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
          <p className="text-sm text-text-2">
            {readiness ? (
              <>
                <strong className="font-semibold text-text-hi tabular-nums">{formatNumber(n)}</strong> {n === 1 ? "person" : "people"} will get this email
              </>
            ) : (
              "Checking…"
            )}
          </p>
          <Button variant="primary" icon={mode === "now" ? <Send /> : <CalendarClock />} disabled={disabled} onClick={() => setConfirm(true)}>
            {mode === "now" ? "Send now" : "Schedule"}
          </Button>
        </div>
        {readiness && !ready && <p className="-mt-2 text-xs text-text-3">Fix the items in “Before you send” first.</p>}
        {blocked && ready && <p className="-mt-2 text-xs text-text-3">Save your changes first.</p>}
      </CardBody>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        tone="default"
        title={mode === "now" ? `Send “${campaign.name}” now?` : `Schedule “${campaign.name}”?`}
        confirmLabel={mode === "now" ? `Send to ${plural(n, "person", "people")}` : "Schedule"}
        description={
          mode === "now"
            ? `It goes to ${plural(n, "person", "people")} from ${campaign.fromEmail ?? "your sending domain"}. Once an email is sent it cannot be taken back.`
            : `It goes out ${f.dateTime(scheduledAt)} to the ${plural(n, "person", "people")} who can receive it then. Until then you can pause or cancel it.`
        }
        onConfirm={() => send.mutateAsync()}
      />
    </Card>
  );
}
