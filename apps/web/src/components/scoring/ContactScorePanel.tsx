"use client";

import Link from "next/link";
import { Gauge } from "lucide-react";
import type { ScoreBand, ScoreBreakdownItem } from "@growthdesk/shared";
import { Badge, type Tone } from "@/components/ui/Badge";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { ErrorState } from "@/components/ui/ErrorState";
import { SkeletonText } from "@/components/ui/Skeleton";
import { cn } from "@/lib/cn";
import { useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";

/*
 * The contact page's lead score (GET /scoring/contacts/:id): a ring with the
 * score and its hot / warm / cold band, the fit and engagement parts, the
 * rules that gave points, and when it last changed. With scoring off, a
 * score set by hand (or by the lead API) is shown as such.
 */

type ContactScore = {
  enabled: boolean;
  hot: number;
  warm: number;
  score: number | null;
  band: ScoreBand | null;
  fit: number | null;
  engagement: number | null;
  breakdown: ScoreBreakdownItem[];
  updatedAt: string | null;
};

const BAND: Record<ScoreBand, { label: string; tone: Tone; ring: string }> = {
  hot: { label: "Hot", tone: "bad", ring: "text-bad" },
  warm: { label: "Warm", tone: "warn", ring: "text-warn" },
  cold: { label: "Cold", tone: "info", ring: "text-accent" },
};

const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : "0");

function ScoreRing({ score, band }: { score: number | null; band: ScoreBand | null }) {
  const r = 26;
  const c = 2 * Math.PI * r;
  const value = Math.max(0, Math.min(100, score ?? 0));
  return (
    <div className="relative size-16 shrink-0" role="img" aria-label={score === null ? "Not scored" : `Lead score ${score} of 100`}>
      <svg viewBox="0 0 64 64" className="size-16 -rotate-90">
        <circle cx="32" cy="32" r={r} fill="none" strokeWidth="6" className="stroke-current text-s-4" />
        {score !== null && (
          <circle cx="32" cy="32" r={r} fill="none" strokeWidth="6" strokeLinecap="round" strokeDasharray={`${(value / 100) * c} ${c}`} className={cn("stroke-current transition-[stroke-dasharray]", band ? BAND[band].ring : "text-text-3")} />
        )}
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-lg font-semibold text-text-hi tabular-nums">{score ?? "—"}</span>
    </div>
  );
}

export function ContactScorePanel({ contactId }: { contactId: string }) {
  const ws = useWorkspace();
  const f = useFormat();
  // Under the contact's key, so saving the contact refreshes it too.
  const q = useApiQuery<ContactScore>(ws.key("contacts", "score", contactId), ws.path(`/scoring/contacts/${contactId}`));
  const settingsLink = ws.can("contacts.read") ? (
    <Link href={ws.href("/settings/lead-scoring")} className="text-xs text-accent-hi hover:underline">
      Scoring rules
    </Link>
  ) : undefined;

  return (
    <Card>
      <CardHeader icon={<Gauge />} title="Lead score" actions={settingsLink} />
      {q.isPending ? (
        <CardBody>
          <SkeletonText lines={3} />
        </CardBody>
      ) : q.isError ? (
        <ErrorState compact error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <ScoreBody s={q.data} updated={q.data.updatedAt ? f.relative(q.data.updatedAt) : null} />
      )}
    </Card>
  );
}

function ScoreBody({ s, updated }: { s: ContactScore; updated: string | null }) {
  const band = s.band ? BAND[s.band] : null;
  if (!s.enabled && s.score === null) {
    return (
      <CardBody>
        <p className="text-xs text-text-3">Lead scoring is off for this workspace. Turn it on in Settings → Lead scoring to score every contact automatically.</p>
      </CardBody>
    );
  }
  const total = s.fit !== null && s.engagement !== null ? Math.max(1, Math.abs(s.fit) + Math.abs(s.engagement)) : 1;
  return (
    <CardBody className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <ScoreRing score={s.score} band={s.band} />
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-center gap-2">
            {band ? (
              <Badge tone={band.tone} dot>
                {band.label}
              </Badge>
            ) : (
              <Badge>Not scored yet</Badge>
            )}
            <span className="text-xs text-text-3">of 100</span>
          </div>
          {s.enabled ? (
            <span className="text-xs text-text-3">
              Hot from {s.hot}, warm from {s.warm}
              {updated ? ` · updated ${updated}` : ""}
            </span>
          ) : (
            <span className="text-xs text-text-3">Set by hand or by the lead API (automatic scoring is off).</span>
          )}
        </div>
      </div>

      {s.enabled && s.fit !== null && s.engagement !== null && (
        <div className="flex flex-col gap-1.5">
          <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-s-4" aria-hidden>
            <div className="h-full bg-accent" style={{ width: `${(Math.max(0, s.fit) / total) * 100}%` }} />
            <div className="h-full bg-ok" style={{ width: `${(Math.max(0, s.engagement) / total) * 100}%` }} />
          </div>
          <div className="flex justify-between text-xs text-text-3">
            <span>
              <span className="mr-1 inline-block size-2 rounded-full bg-accent" aria-hidden />
              Fit <span className="text-text tabular-nums">{signed(s.fit)}</span>
            </span>
            <span>
              <span className="mr-1 inline-block size-2 rounded-full bg-ok" aria-hidden />
              Engagement <span className="text-text tabular-nums">{signed(s.engagement)}</span>
            </span>
          </div>
        </div>
      )}

      {s.enabled &&
        (s.breakdown.length ? (
          <ul className="flex flex-col divide-y divide-line border-t border-line">
            {s.breakdown.map((b) => (
              <li key={b.ruleId} className="flex items-center justify-between gap-2 py-1.5 text-sm">
                <span className="min-w-0 truncate text-text">{b.name}</span>
                <span className={cn("shrink-0 text-xs font-medium tabular-nums", b.points < 0 ? "text-bad-ink" : "text-ok-ink")}>{signed(b.points)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-text-3">{s.score === null ? "Scored within a minute or so of the next change." : "No rule gives this contact points yet."}</p>
        ))}
    </CardBody>
  );
}
