"use client";

import { useState } from "react";
import { Eye, Mail } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Dialog";
import { ErrorState } from "@/components/ui/ErrorState";
import { NativeSelect } from "@/components/ui/Input";
import { SkeletonText } from "@/components/ui/Skeleton";
import { Switch } from "@/components/ui/Switch";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";

/* GET/PUT /digest/settings and GET /digest/preview — apps/api/src/digest/digest.controller.ts */
type Frequency = "daily" | "weekly";
type DigestSettings = { enabled: boolean; frequency: Frequency; hour: number; lastSentAt: string | null; timezone: string; nextSendAt: string | null };
type DigestPreview = { title: string; body: string; inApp: string; data: { empty: boolean; period: { label: string } } };

const FREQUENCIES: { value: Frequency; label: string }[] = [
  { value: "daily", label: "Daily (yesterday)" },
  { value: "weekly", label: "Weekly (Mondays, last 7 days)" },
];

const hourLabel = (h: number) => `${String(h).padStart(2, "0")}:00`;
const HOURS = Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: hourLabel(h) }));

/** "• 3 overdue tasks: https://…" → the text, linked. */
const LINKED = /^(.*?):\s(https?:\/\/\S+)$/;

/** The digest body as the email shows it: **headings**, then one line per number, each linked into the app. */
function DigestBody({ text }: { text: string }) {
  return (
    <div className="flex flex-col gap-3 text-sm text-text">
      {text.split(/\n{2,}/).map((block, i) => (
        <div key={i} className="flex flex-col gap-1">
          {block.split("\n").map((line, j) => {
            const heading = /^\*\*(.+)\*\*$/.exec(line);
            if (heading) return <h3 key={j} className="text-xs font-semibold tracking-wide text-text-3 uppercase">{heading[1]}</h3>;
            const linked = LINKED.exec(line);
            return (
              <p key={j} className="break-words text-text-2">
                {linked ? (
                  <a href={linked[2]} className="hover:text-accent-hi hover:underline">
                    {linked[1]}
                  </a>
                ) : (
                  line
                )}
              </p>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function PreviewModal({ open, onOpenChange, frequency }: { open: boolean; onOpenChange: (v: boolean) => void; frequency: Frequency }) {
  const ws = useWorkspace();
  const preview = useApiQuery<DigestPreview>(ws.key("digest", "preview"), open ? ws.path("/digest/preview") : null, { query: { frequency } });
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      icon={<Mail className="size-5 text-text-2" />}
      title={preview.data?.title ?? "Digest preview"}
      description="What owners, admins and managers would get by email right now. Nothing is sent."
      footer={
        <Button variant="secondary" onClick={() => onOpenChange(false)}>
          Close
        </Button>
      }
    >
      {preview.isPending ? (
        <SkeletonText lines={8} />
      ) : preview.isError ? (
        <ErrorState error={preview.error as never} onRetry={() => void preview.refetch()} />
      ) : (
        <>
          {preview.data.data.empty && <p className="mb-3 text-sm text-text-3">Nothing to report for {preview.data.data.period.label} — no digest would be sent.</p>}
          <DigestBody text={preview.data.body} />
        </>
      )}
    </Modal>
  );
}

/** The daily digest's settings, at the top of Team activity (people with analytics.team; changing it needs settings.manage). */
export function DigestCard() {
  const ws = useWorkspace();
  const f = useFormat();
  const visible = ws.can("analytics.team");
  const canEdit = ws.can("settings.manage");
  const [previewing, setPreviewing] = useState(false);
  const settings = useApiQuery<DigestSettings>(ws.key("digest", "settings"), visible ? ws.path("/digest/settings") : null);
  const save = useApiMutation<DigestSettings, Partial<Pick<DigestSettings, "enabled" | "frequency" | "hour">>>({
    method: "PUT",
    path: ws.path("/digest/settings"),
    invalidate: [ws.key("digest")],
    success: "Digest settings saved",
  });
  if (!visible) return null;
  const s = save.isPending && save.variables ? { ...settings.data!, ...save.variables } : settings.data;
  const locked = !canEdit || save.isPending || !s;

  return (
    <Card className="mb-4 p-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="flex min-w-0 flex-1 items-start gap-2.5">
          <Mail aria-hidden className="mt-0.5 size-4 shrink-0 text-text-2" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold text-text-hi">Daily digest</h2>
              {s && <Badge tone={s.enabled ? "ok" : "mute"}>{s.enabled ? "On" : "Off"}</Badge>}
            </div>
            <p className="mt-0.5 text-xs text-text-3">
              {s
                ? s.enabled
                  ? `Owners, admins and managers get a summary by email and in the bell at ${hourLabel(s.hour)} (${s.timezone})${s.nextSendAt ? ` — next ${f.dateTime(s.nextSendAt)}` : ""}.`
                  : "Owners, admins and managers get no digest."
                : "Owners, admins and managers get a summary of the team's work by email and in the bell."}
              {s?.lastSentAt ? ` Last sent ${f.dateTime(s.lastSentAt)}.` : ""}
              {!canEdit && " Only people who can change workspace settings can change this."}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Switch aria-label="Send the digest" checked={s?.enabled ?? false} disabled={locked} onCheckedChange={(enabled) => save.mutate({ enabled })} />
          <NativeSelect
            aria-label="How often"
            size="sm"
            className="w-auto min-w-44"
            value={s?.frequency ?? "daily"}
            disabled={locked}
            onChange={(e) => save.mutate({ frequency: e.target.value as Frequency })}
            options={FREQUENCIES}
          />
          <NativeSelect
            aria-label={`Hour (${s?.timezone ?? f.timeZone})`}
            size="sm"
            className="w-auto min-w-24"
            value={String(s?.hour ?? 8)}
            disabled={locked}
            onChange={(e) => save.mutate({ hour: Number(e.target.value) })}
            options={HOURS}
          />
          <Button size="sm" variant="secondary" icon={<Eye />} onClick={() => setPreviewing(true)} disabled={!s}>
            Preview
          </Button>
        </div>
      </div>
      {settings.isError && <p className="mt-2 text-xs text-bad-ink">Could not load the digest settings.</p>}
      <PreviewModal open={previewing} onOpenChange={setPreviewing} frequency={s?.frequency ?? "daily"} />
    </Card>
  );
}
