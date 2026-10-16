"use client";

import Link from "next/link";
import { ClipboardPen, LoaderCircle } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { isFinalCallStatus, labelOf, type AiCallInterest, type TranscriptTurn } from "@growthdesk/shared";
import { Badge, StatusBadge, type Tone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Drawer } from "@/components/ui/Drawer";
import { QueryState } from "@/components/ui/ErrorState";
import { EntityTile } from "@/components/ui/icons";
import { KeyValueList, type KeyValueItem } from "@/components/ui/KeyValue";
import { SkeletonText } from "@/components/ui/Skeleton";
import { cn } from "@/lib/cn";
import { formatDuration } from "@/lib/format";
import { useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import type { CallRow } from "@/lib/types/calls";

/** Cartesia's end reasons in words (packages/shared/src/ai-calling.ts CARTESIA_END_REASONS). */
const END_REASONS: Record<string, string> = {
  agent_hangup: "The agent ended the call",
  voicemail_detected: "Reached voicemail",
  client_hangup: "The person hung up",
  api_cancelled: "Canceled before it connected",
  max_duration: "Reached the agent's time limit",
  call_inactivity: "Nobody spoke for too long",
  client_inactivity: "The person stopped responding",
  client_disconnected: "The line dropped",
  dial_no_answer: "Nobody answered",
  dial_busy: "The line was busy",
  dial_failed: "The call could not be placed",
  dial_timeout: "Nobody answered in time",
  concurrency_limit: "Too many calls at once on the Cartesia account",
  agent_error: "The agent ran into an error",
  network_error: "A network error ended the call",
  config_error: "The agent's setup has an error",
  error: "An error ended the call",
};

export const endReasonText = (reason: string) => END_REASONS[reason] ?? labelOf(reason);

const INTEREST_TONE: Record<AiCallInterest, Tone> = { hot: "ok", warm: "warn", cold: "mute", unknown: "mute" };

/** Whether an AI call's result is still to come: on the line, or ended and not judged yet. */
const awaiting = (c: CallRow) => c.provider === "cartesia" && (!isFinalCallStatus(c.status) || !c.processedAt);

/**
 * One call as GET /calls/:id answers it, mostly for AI calls: who and which
 * agent, how it ended, what the judge made of it (interest, meeting, callback,
 * answers), the summary and the transcript. Polls while the call is live or
 * still being judged. `onRecord` offers "Record outcome" for calls a person
 * placed or logged (AI calls are judged on their own).
 */
export function AiCallDetail({ callId, open, onOpenChange, onRecord }: { callId: string | null; open: boolean; onOpenChange: (open: boolean) => void; onRecord?: (call: CallRow) => void }) {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const key = ws.key("calls", "one", callId);
  const cached = qc.getQueryData<CallRow>(key);
  const call = useApiQuery<CallRow>(key, open && callId ? ws.path(`/calls/${callId}`) : null, {
    refetchInterval: cached && awaiting(cached) ? 4000 : false,
  });
  const c = call.data;
  const who = c?.contact ? c.contact.fullName || c.contact.email || c.contact.phone || "Unnamed contact" : (c?.toNumber ?? "Call");

  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      width="lg"
      icon={<EntityTile of="calls" size="md" />}
      title={c ? who : "Call"}
      description={c ? `${c.provider === "cartesia" ? "AI call" : c.provider === "twilio" ? "Twilio call" : "Logged call"} · ${c.toNumber || "no number"}` : undefined}
      footer={
        c && onRecord && c.provider !== "cartesia" && ws.can("calls.make") ? (
          <Button icon={<ClipboardPen />} onClick={() => onRecord(c)}>
            {c.outcome ? "Edit outcome" : "Record outcome"}
          </Button>
        ) : undefined
      }
    >
      <QueryState query={call} loading={<SkeletonText lines={8} />}>
        {(data) => <CallBody call={data} />}
      </QueryState>
    </Drawer>
  );
}

function CallBody({ call: c }: { call: CallRow }) {
  const ws = useWorkspace();
  const f = useFormat();
  const ai = c.provider === "cartesia";
  const final = isFinalCallStatus(c.status);
  const a = c.analysis;
  const summary = c.summary || a?.summary || "";
  const items: KeyValueItem[] = [
    {
      label: "Contact",
      value: c.contact ? (
        <Link href={ws.href(`/contacts/${c.contact.id}`)} className="text-text hover:text-accent-hi">
          {c.contact.fullName || c.contact.email || c.contact.phone}
        </Link>
      ) : null,
      hint: c.toNumber || undefined,
    },
    ai
      ? {
          label: "AI agent",
          value: c.agent ? (
            <Link href={ws.href(`/ai-agents/${c.agent.id}`)} className="text-text hover:text-accent-hi">
              {c.agent.name}
            </Link>
          ) : null,
        }
      : { label: "By", value: c.user?.name },
    { label: "When", value: c.startedAt || c.createdAt ? f.dateTime(c.startedAt ?? c.createdAt) : null },
    { label: "Length", value: c.durationSec ? formatDuration(c.durationSec) : null },
    ...(ai ? [{ label: "How it ended", value: c.endReason ? endReasonText(c.endReason) : null }] : []),
    ...(c.campaignId
      ? [
          {
            label: "Campaign",
            value: (
              <Link href={ws.href(`/campaigns/${c.campaignId}`)} className="text-text hover:text-accent-hi">
                Open campaign
              </Link>
            ),
          },
        ]
      : []),
    ...(c.deal
      ? [
          {
            label: "Deal",
            value: (
              <Link href={ws.href(`/deals/${c.deal.id}`)} className="text-text hover:text-accent-hi">
                {c.deal.name}
              </Link>
            ),
          },
        ]
      : []),
  ];
  const callbackAt = a?.callbackAt ?? c.callbackAt;
  const findings: KeyValueItem[] = [
    ...(a?.meetingTime ? [{ label: "Meeting", value: a.meetingTime }] : []),
    ...(callbackAt ? [{ label: "Call back", value: f.dateTime(callbackAt) }] : []),
    ...(a?.nextStep ? [{ label: "Next step", value: a.nextStep }] : []),
  ];

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusBadge value={c.status} />
        {c.outcome ? <StatusBadge value={c.outcome} dot={false} /> : null}
        {a && a.interest !== "unknown" && <Badge tone={INTEREST_TONE[a.interest]}>{labelOf(a.interest)} lead</Badge>}
        {a?.method === "heuristic" && (
          <Badge quiet title="No AI model was available, so the outcome was read from keywords in the transcript.">
            Judged by keywords
          </Badge>
        )}
      </div>

      {ai && !final && (
        <Callout tone="info" title="The call is under way">
          This page updates when it ends.
        </Callout>
      )}
      {ai && final && !c.processedAt && (
        <p className="flex items-center gap-2 text-sm text-text-2" role="status">
          <LoaderCircle aria-hidden className="size-4 animate-spin text-text-3" />
          Judging the call…
        </p>
      )}

      <KeyValueList items={items} />

      {summary && (
        <section className="flex flex-col gap-1.5">
          <h3 className="text-xs font-medium text-text-3">Summary</h3>
          <p className="text-sm whitespace-pre-wrap text-text">{summary}</p>
        </section>
      )}

      {findings.length > 0 && <KeyValueList items={findings} />}

      {a && a.answers.length > 0 && (
        <section className="flex flex-col gap-1.5">
          <h3 className="text-xs font-medium text-text-3">Answers</h3>
          <dl className="flex flex-col gap-2">
            {a.answers.map((x, i) => (
              <div key={i} className="rounded-sm border border-line px-3 py-2">
                <dt className="text-xs text-text-3">{x.question}</dt>
                <dd className="text-sm text-text">{x.answer || <span className="text-text-3">No answer</span>}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {c.notes && (
        <section className="flex flex-col gap-1.5">
          <h3 className="text-xs font-medium text-text-3">Notes</h3>
          <p className="text-sm whitespace-pre-wrap text-text">{c.notes}</p>
        </section>
      )}

      {ai && (
        <section className="flex flex-col gap-1.5">
          <h3 className="text-xs font-medium text-text-3">Transcript</h3>
          {c.transcript.length ? (
            <Transcript turns={c.transcript} agent={c.agent?.name ?? "Agent"} person={c.contact?.fullName || "Person"} />
          ) : (
            <p className="text-xs text-text-3">{final ? "Nothing was said on this call." : "The transcript appears when the call ends."}</p>
          )}
        </section>
      )}
    </div>
  );
}

/** What was said, as chat bubbles: the agent on the left, the person on the right, timestamps from the start of the call. */
function Transcript({ turns, agent, person }: { turns: TranscriptTurn[]; agent: string; person: string }) {
  return (
    <ol className="flex flex-col gap-2">
      {turns.map((t, i) =>
        t.role === "system" ? (
          <li key={i} className="text-center text-xs text-text-3 italic">
            {t.text}
          </li>
        ) : (
          <li key={i} className={cn("flex max-w-[85%] flex-col gap-0.5", t.role === "user" ? "items-end self-end" : "items-start self-start")}>
            <span className="text-2xs text-text-3">
              {t.role === "assistant" ? agent : person}
              {typeof t.start === "number" ? ` · ${formatDuration(t.start)}` : ""}
            </span>
            <span className={cn("rounded-md px-3 py-2 text-sm whitespace-pre-wrap", t.role === "assistant" ? "bg-well text-text" : "bg-accent-soft text-text")}>{t.text}</span>
          </li>
        ),
      )}
    </ol>
  );
}
