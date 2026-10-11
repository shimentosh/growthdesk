"use client";

import { useEffect, useState, type ReactNode } from "react";
import { CircleAlert, Send, UsersRound, Workflow, UserCheck } from "lucide-react";
import { PLATFORM_MARKETING_VARIABLES, type PlatformBroadcastStatus, type PlatformTemplateVariable } from "@growthdesk/shared";
import { Badge, type Tone } from "@/components/ui/Badge";
import { Callout } from "@/components/ui/Callout";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { IconTile, type Tint } from "@/components/ui/IconTile";
import { Spinner } from "@/components/ui/Skeleton";
import { post } from "@/lib/api";
import { cn } from "@/lib/cn";
import { formatNumber, formatPercent } from "@/lib/format";
import { BlockEditor, TokenInput, TokenScope, VariablePicker } from "@/features/email/BlockEditor";
import type { EmailFunnel, MarketingContent, MarketingPreview } from "./types";

/*
 * Pieces the Growth screens share: their tiles, status badges, the content
 * editor (subject, preheader, blocks — the block editor is the email
 * templates' own, features/email/BlockEditor) with a live preview rendered by
 * the API's marketing renderer, and the delivery funnel.
 */

const TILES = {
  audiences: { icon: UsersRound, tint: "purple" },
  broadcasts: { icon: Send, tint: "pink" },
  sequences: { icon: Workflow, tint: "indigo" },
  subscribers: { icon: UserCheck, tint: "green" },
} as const satisfies Record<string, { icon: typeof Send; tint: Tint }>;

export type GrowthSection = keyof typeof TILES;

export function GrowthTile({ of, size = "lg" }: { of: GrowthSection; size?: "sm" | "md" | "lg" | "xl" }) {
  const { icon: Icon, tint } = TILES[of];
  return <IconTile icon={<Icon />} tint={tint} size={size} />;
}

export function growthEmpty(of: GrowthSection) {
  const { icon: Icon, tint } = TILES[of];
  return { icon: <Icon />, tint };
}

const STATUS: Record<PlatformBroadcastStatus, { label: string; tone: Tone }> = {
  draft: { label: "Draft", tone: "mute" },
  scheduled: { label: "Scheduled", tone: "info" },
  sending: { label: "Sending", tone: "live" },
  sent: { label: "Sent", tone: "ok" },
  canceled: { label: "Canceled", tone: "warn" },
  failed: { label: "Failed", tone: "bad" },
};

export function BroadcastStatusBadge({ status }: { status: PlatformBroadcastStatus }) {
  const s = STATUS[status] ?? { label: status, tone: "mute" as Tone };
  return (
    <Badge tone={s.tone} dot={status === "sending" || status === "scheduled"}>
      {s.label}
    </Badge>
  );
}

export const MARKETING_VARIABLES: PlatformTemplateVariable[] = PLATFORM_MARKETING_VARIABLES.map((v) => ({ key: v.key, label: v.label, sample: v.sample }));

/** "after 2 days", "right away", "after 5 hours". */
export function delayLabel(hours: number, first: boolean): string {
  if (hours <= 0) return first ? "Right away" : "Right after the previous step";
  const days = hours % 24 === 0 ? hours / 24 : null;
  const span = days ? `${days} day${days === 1 ? "" : "s"}` : `${hours} hour${hours === 1 ? "" : "s"}`;
  return first ? `${span} after the trigger` : `${span} after the previous step`;
}

/** Debounced render of the draft by the API (same renderer as the real send, sample values). */
export function useMarketingPreview(draft: MarketingContent | null) {
  const [state, setState] = useState<{ data: MarketingPreview | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: false });
  const body = draft ? JSON.stringify(draft) : null;
  useEffect(() => {
    if (!body) return;
    const ctrl = new AbortController();
    setState((s) => ({ ...s, loading: true }));
    const timer = setTimeout(() => {
      post<MarketingPreview>("/admin/growth/preview", JSON.parse(body), { signal: ctrl.signal })
        .then((data) => setState({ data, error: null, loading: false }))
        .catch((e: unknown) => {
          if (ctrl.signal.aborted) return;
          setState((s) => ({ ...s, error: e instanceof Error ? e.message : String(e), loading: false }));
        });
    }, 400);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [body]);
  return state;
}

export function PreviewPane({ preview, height = 620 }: { preview: ReturnType<typeof useMarketingPreview>; height?: number }) {
  const [mode, setMode] = useState<"html" | "text">("html");
  const p = preview.data;
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <div className="flex items-center gap-2 text-sm font-semibold text-text-hi">
          Preview
          {preview.loading && <Spinner size="sm" label="Rendering" />}
        </div>
        <div role="tablist" aria-label="Preview format" className="inline-flex rounded-md border border-line-strong bg-ctl-face p-0.5 text-xs">
          {(["html", "text"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              onClick={() => setMode(m)}
              className={cn("rounded px-2 py-0.5", mode === m ? "bg-accent/12 font-medium text-accent-ink" : "text-text-2 hover:text-text")}
            >
              {m === "html" ? "Email" : "Plain text"}
            </button>
          ))}
        </div>
      </div>
      {p && (
        <div className="border-b border-line bg-well px-3 py-2 text-xs">
          <div className="truncate">
            <span className="text-text-3">Subject </span>
            <span className="font-medium text-text">{p.subject || "—"}</span>
          </div>
        </div>
      )}
      {preview.error && (
        <Callout tone="bad" className="m-3">
          {preview.error}
        </Callout>
      )}
      {p && p.problems.length > 0 && <ProblemList problems={p.problems} className="border-b border-line" />}
      <div className="bg-[#f5f5f7]">
        {!p ? (
          <div className="flex items-center justify-center text-sm text-[#6e6e73]" style={{ height }}>
            {preview.loading ? "Rendering…" : "—"}
          </div>
        ) : mode === "html" ? (
          <iframe title="Email preview" sandbox="" srcDoc={p.html} className="block w-full border-0 bg-[#f5f5f7]" style={{ height }} />
        ) : (
          <pre className="overflow-auto bg-panel px-4 py-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-text" style={{ height }}>
            {p.text}
          </pre>
        )}
      </div>
    </Card>
  );
}

export function ProblemList({ problems, className }: { problems: string[]; className?: string }) {
  return (
    <div className={cn("bg-warn-wash px-3 py-2", className)}>
      <ul className="flex flex-col gap-1 text-xs text-warn-ink">
        {problems.map((x) => (
          <li key={x} className="flex gap-1.5">
            <CircleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            {x}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Subject, preheader, variables and blocks on the left; the live preview on the right. */
export function ContentEditor({ value, onChange, disabled, aside }: { value: MarketingContent; onChange: (v: MarketingContent) => void; disabled?: boolean; aside?: ReactNode }) {
  const preview = useMarketingPreview(value);
  return (
    <TokenScope>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] 2xl:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <Card>
            <CardHeader title="Message" description="Variables are filled per recipient; the preview uses sample values." />
            <CardBody className="flex flex-col gap-3">
              <Field label="Subject" required>
                <TokenInput value={value.subject} onChange={(subject) => onChange({ ...value, subject })} maxLength={300} disabled={disabled} placeholder="What's new in {{product_name}}" />
              </Field>
              <Field label="Preheader" hint="The grey line inbox lists show after the subject. Optional.">
                <TokenInput value={value.preheader} onChange={(preheader) => onChange({ ...value, preheader })} maxLength={300} disabled={disabled} />
              </Field>
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-text-2">Insert a variable at the cursor</span>
                <VariablePicker variables={MARKETING_VARIABLES} required={[]} disabled={disabled} />
              </div>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Content" description="Every email gets a footer with the product name, support address and an unsubscribe link, plus one-click unsubscribe headers." />
            <CardBody>
              <BlockEditor blocks={value.blocks} onChange={(blocks) => onChange({ ...value, blocks })} hasActionUrl={false} disabled={disabled} />
            </CardBody>
          </Card>
          {aside}
        </div>
        <div className="min-w-0 lg:sticky lg:top-4 lg:self-start">
          <PreviewPane preview={preview} />
        </div>
      </div>
    </TokenScope>
  );
}

const pct = (n: number, of: number) => (of > 0 ? n / of : 0);

/** Delivery funnel as horizontal bars, each as a share of the emails sent. */
export function FunnelBars({ email, unsubscribes }: { email: EmailFunnel; unsubscribes: number }) {
  const base = email.sent || email.total;
  const rows: { label: string; value: number; tone: string; hint?: string }[] = [
    { label: "Sent", value: email.sent, tone: "bg-accent" },
    { label: "Delivered", value: email.delivered, tone: "bg-ok" },
    { label: "Opened", value: email.opened, tone: "bg-accent", hint: "Opens are a weak signal: image proxies and privacy features open mail without a person reading." },
    { label: "Clicked", value: email.clicked, tone: "bg-accent" },
    { label: "Bounced", value: email.bounced, tone: "bg-warn" },
    { label: "Complained", value: email.complained, tone: "bg-bad" },
    { label: "Unsubscribed", value: unsubscribes, tone: "bg-warn" },
    { label: "Failed", value: email.failed, tone: "bg-bad" },
  ];
  return (
    <div className="flex flex-col gap-2.5">
      {rows.map((r) => (
        <div key={r.label} className="grid grid-cols-[6.5rem_minmax(0,1fr)_5.5rem] items-center gap-3 text-sm" title={r.hint}>
          <span className="text-text-2">{r.label}</span>
          <div className="h-2.5 overflow-hidden rounded-full bg-well" role="presentation">
            <div className={cn("h-full rounded-full transition-[width]", r.tone)} style={{ width: `${Math.max(r.value > 0 ? 1.5 : 0, pct(r.value, base) * 100)}%` }} />
          </div>
          <span className="text-right tabular-nums text-text">
            {formatNumber(r.value)}
            {r.label !== "Sent" && base > 0 && <span className="ml-1 text-xs text-text-3">{formatPercent(pct(r.value, base), 0)}</span>}
          </span>
        </div>
      ))}
      {email.queued > 0 && <p className="text-xs text-text-3">{formatNumber(email.queued)} still queued.</p>}
    </div>
  );
}

/** A thin multi-segment bar: sent / failed / skipped / canceled / pending. */
export function ProgressBar({ progress, className }: { progress: { sent: number; failed: number; skipped: number; canceled: number; pending: number; total: number }; className?: string }) {
  const t = progress.total || 1;
  const seg = [
    { n: progress.sent, c: "bg-ok", label: "sent" },
    { n: progress.failed, c: "bg-bad", label: "failed" },
    { n: progress.skipped, c: "bg-s-6", label: "skipped" },
    { n: progress.canceled, c: "bg-warn", label: "canceled" },
  ];
  return (
    <div className={cn("flex h-1.5 w-full overflow-hidden rounded-full bg-well", className)} aria-label={seg.map((s) => `${s.n} ${s.label}`).join(", ") + `, ${progress.pending} pending`}>
      {seg.map((s) => (s.n > 0 ? <div key={s.label} className={s.c} style={{ width: `${(s.n / t) * 100}%` }} /> : null))}
    </div>
  );
}

