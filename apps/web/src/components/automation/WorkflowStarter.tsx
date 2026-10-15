"use client";

import { ArrowRight, ChevronLeft, Handshake, Megaphone, Plus } from "lucide-react";
import { TRIGGER_KIND, WORKFLOW_TEMPLATES, type WorkflowKind, type WorkflowTemplate, type WorkflowTrigger } from "@growthdesk/shared";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { IconTile, type Tint } from "@/components/ui/IconTile";
import { cn } from "@/lib/cn";
import { ACTION_LABELS, triggerLabel } from "@/lib/types/automation";
import { ActionGlyph, TriggerTile } from "./glyphs";

/*
 * The first two steps of a new workflow: what kind (sales or email
 * marketing), then a template of that kind or a blank one. Both are plain
 * buttons; the page keeps the step in the URL (?kind=, ?template=) so Back
 * works.
 */

export const KIND_META: Record<WorkflowKind, { label: string; short: string; tint: Tint; icon: typeof Handshake; description: string; examples: string[] }> = {
  sales: {
    label: "Sales automation",
    short: "Sales",
    tint: "green",
    icon: Handshake,
    description: "Leads, replies, meetings, deals and tasks: who owns what and what happens next.",
    examples: ["Speed to lead: call within 15 minutes", "New lead → outreach sequence", "Deal won → customer onboarding"],
  },
  marketing: {
    label: "Email marketing",
    short: "Marketing",
    tint: "purple",
    icon: Megaphone,
    description: "Subscribers and campaigns: list joins, opens, clicks and unsubscribes.",
    examples: ["Clicked pricing → hand to sales", "New subscriber → tag and welcome", "Opened an email → tag Engaged"],
  },
};

export const triggersOf = (kind: WorkflowKind) => (Object.keys(TRIGGER_KIND) as WorkflowTrigger[]).filter((t) => TRIGGER_KIND[t] === kind);

function KindCard({ kind, onPick }: { kind: WorkflowKind; onPick: () => void }) {
  const m = KIND_META[kind];
  const Icon = m.icon;
  const count = WORKFLOW_TEMPLATES.filter((t) => t.kind === kind).length;
  return (
    <button
      type="button"
      onClick={onPick}
      className="group flex flex-col gap-3 rounded-xl border border-line bg-panel p-5 text-left transition-colors hover:border-accent/50 hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent"
    >
      <div className="flex items-center gap-3">
        <IconTile icon={<Icon />} tint={m.tint} size="lg" />
        <div className="min-w-0">
          <div className="text-base font-semibold text-text-hi">{m.label}</div>
          <div className="text-xs text-text-3">{count} ready-made templates</div>
        </div>
        <ArrowRight aria-hidden className="ml-auto size-4 text-text-3 transition-transform group-hover:translate-x-0.5 group-hover:text-text" />
      </div>
      <p className="text-sm text-text-2">{m.description}</p>
      <ul className="flex flex-col gap-1 text-xs text-text-3">
        {m.examples.map((e) => (
          <li key={e}>· {e}</li>
        ))}
      </ul>
    </button>
  );
}

/** Step 1: sales or email marketing. */
export function KindChooser({ onPick }: { onPick: (kind: WorkflowKind) => void }) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-text-2">What should this workflow work on? Each kind shows only its own triggers and actions, and starts from a template.</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <KindCard kind="sales" onPick={() => onPick("sales")} />
        <KindCard kind="marketing" onPick={() => onPick("marketing")} />
      </div>
    </div>
  );
}

export function TemplateCard({ template: t, onPick, inUse }: { template: WorkflowTemplate; onPick: () => void; inUse?: boolean }) {
  return (
    <button
      type="button"
      onClick={onPick}
      className="flex flex-col gap-2.5 rounded-xl border border-line bg-panel p-4 text-left transition-colors hover:border-accent/50 hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent"
    >
      <div className="flex items-start gap-2.5">
        <TriggerTile trigger={t.trigger} />
        <div className="min-w-0">
          <div className="text-sm font-semibold text-text-hi">{t.name}</div>
          <div className="text-xs text-text-3">When: {triggerLabel(t.trigger)}</div>
        </div>
      </div>
      <p className="text-xs text-text-2">{t.summary}</p>
      <div className="mt-auto flex flex-wrap items-center gap-1.5">
        {t.actions.map((a, i) => (
          <span key={i} className="inline-flex items-center gap-1 rounded-sm bg-s-2 px-1.5 py-0.5 text-2xs text-text-2">
            <ActionGlyph type={a.type} className="size-3" />
            {ACTION_LABELS[a.type].label}
          </span>
        ))}
        {t.todo && (
          <Badge tone="warn" quiet>
            You choose: {t.todo.toLowerCase()}
          </Badge>
        )}
        {inUse && (
          <Badge tone="ok" quiet>
            Already added
          </Badge>
        )}
      </div>
    </button>
  );
}

/** Step 2: a template of the chosen kind, or a blank workflow. */
export function TemplateGallery({ kind, onPick, onBack }: { kind: WorkflowKind; onPick: (templateId: string) => void; onBack: () => void }) {
  const m = KIND_META[kind];
  const templates = WORKFLOW_TEMPLATES.filter((t) => t.kind === kind);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <IconTile icon={<m.icon />} tint={m.tint} size="md" />
          <div>
            <div className="text-sm font-semibold text-text-hi">{m.label}</div>
            <div className="text-xs text-text-3">Pick a template — everything is filled in and can be changed before saving.</div>
          </div>
        </div>
        <Button size="sm" variant="ghost" icon={<ChevronLeft />} onClick={onBack}>
          Change type
        </Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {templates.map((t) => (
          <TemplateCard key={t.id} template={t} onPick={() => onPick(t.id)} />
        ))}
        <button
          type="button"
          onClick={() => onPick("blank")}
          className={cn(
            "flex min-h-32 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line-strong p-4 text-center text-text-2 transition-colors",
            "hover:border-accent/50 hover:bg-hover hover:text-text focus-visible:outline-2 focus-visible:outline-accent",
          )}
        >
          <Plus aria-hidden className="size-5" />
          <span className="text-sm font-medium">Start from scratch</span>
          <span className="text-xs text-text-3">An empty {m.short.toLowerCase()} workflow.</span>
        </button>
      </div>
    </div>
  );
}
