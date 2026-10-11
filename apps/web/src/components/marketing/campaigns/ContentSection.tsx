"use client";

import { useEffect, useRef, useState } from "react";
import { Blocks, Palette } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { ENTITY, EntityTile } from "@/components/ui/icons";
import { SkeletonText } from "@/components/ui/Skeleton";
import { BlockEditor } from "@/components/marketing/BlockEditor";
import { useMarketing } from "@/components/marketing/common";
import { DesignPreview } from "@/components/marketing/designs/DesignPreview";
import { cn } from "@/lib/cn";
import { useApiQuery } from "@/lib/query";
import { useFormat } from "@/lib/session";
import type { EmailDesign, MarketingCampaign } from "@/lib/types/marketing";
import type { SectionProps } from "./CampaignEditor";

/**
 * The block editor beside a live preview, and "Start from a design" (copies a
 * saved design's blocks in). The editor itself lists what blocks sending and
 * flags those blocks.
 */
export function ContentSection({
  value,
  set,
  disabled,
  errors,
  applyDesign,
  applying,
  contentDirty,
  revealProblem,
}: SectionProps & {
  applyDesign: (designId: string) => Promise<MarketingCampaign>;
  applying: boolean;
  contentDirty: boolean;
  /** Arrived from a readiness problem: open and focus the first block that needs fixing. */
  revealProblem?: boolean;
}) {
  const [picking, setPicking] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!revealProblem) return;
    // The editor links each "Button 3 needs…" problem to its block; follow the first one.
    const t = setTimeout(() => {
      const links = editorRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? [];
      Array.from(links)
        .find((b) => /^(Button|Image) \d+ needs/.test(b.textContent ?? ""))
        ?.click();
    }, 150);
    return () => clearTimeout(t);
  }, [revealProblem]);
  const blockErrors = Object.entries(errors).filter(([k]) => k === "blocks" || k.startsWith("blocks."));

  return (
    <div className="flex flex-col gap-4">
      {blockErrors.length > 0 && (
        <Callout tone="bad" title="The content could not be saved">
          <ul className="list-disc pl-4">
            {blockErrors.map(([k, m]) => (
              <li key={k}>{m}</li>
            ))}
          </ul>
        </Callout>
      )}
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader
            icon={<Blocks />}
            title="Email content"
            description="Top to bottom. Your company footer and unsubscribe link are added for you."
            actions={
              !disabled ? (
                <Button size="sm" icon={<Palette />} onClick={() => setPicking(true)}>
                  Start from a design
                </Button>
              ) : undefined
            }
          />
          <CardBody>
            <div ref={editorRef} className="contents">
              <BlockEditor blocks={value.blocks} onChange={(blocks) => set("blocks", blocks)} disabled={disabled} />
            </div>
          </CardBody>
        </Card>
        <DesignPreview blocks={value.blocks} preheader={value.preheader} className="h-[min(760px,calc(100dvh-8rem))] min-h-[480px] xl:sticky xl:top-4" />
      </div>
      <DesignPicker open={picking} onOpenChange={setPicking} replacesUnsaved={contentDirty} applying={applying} onApply={applyDesign} />
    </div>
  );
}

function DesignPicker({
  open,
  onOpenChange,
  replacesUnsaved,
  applying,
  onApply,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  replacesUnsaved: boolean;
  applying: boolean;
  onApply: (designId: string) => Promise<unknown>;
}) {
  const mk = useMarketing();
  const f = useFormat();
  const [chosen, setChosen] = useState("");
  const designs = useApiQuery<EmailDesign[]>(mk.key("designs", "list"), open ? mk.path("/designs") : null);
  const rows = (designs.data ?? []).filter((d) => !d.archivedAt);
  const DesignGlyph = ENTITY.designs.icon;
  const change = (next: boolean) => {
    if (!next) setChosen("");
    onOpenChange(next);
  };
  return (
    <Modal
      open={open}
      onOpenChange={change}
      title="Start from a design"
      description={
        replacesUnsaved
          ? "The design's blocks replace this campaign's content, including your unsaved edits."
          : "The design's blocks replace this campaign's content. Later changes to the design do not change this campaign."
      }
      footer={
        <>
          <Button onClick={() => change(false)} disabled={applying}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!chosen}
            loading={applying}
            onClick={() =>
              void onApply(chosen)
                .then(() => change(false))
                .catch(() => undefined)
            }
          >
            Use this design
          </Button>
        </>
      }
    >
      {designs.isPending ? (
        <SkeletonText lines={4} />
      ) : designs.isError ? (
        <p className="text-sm text-bad-ink">Designs could not be loaded: {designs.error.message}</p>
      ) : !rows.length ? (
        <EmptyState
          compact
          icon={<DesignGlyph />}
          title="No designs yet"
          description="Save reusable layouts under Designs, then start campaigns from them."
          action={
            <Button size="sm" href={mk.href("/designs")}>
              Open Designs
            </Button>
          }
        />
      ) : (
        <div role="radiogroup" aria-label="Designs" className="flex flex-col gap-2">
          {rows.map((d) => (
            <button
              key={d.id}
              type="button"
              role="radio"
              aria-checked={chosen === d.id}
              onClick={() => setChosen(d.id)}
              onDoubleClick={() => void onApply(d.id).then(() => change(false)).catch(() => undefined)}
              className={cn(
                "flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors",
                chosen === d.id ? "border-accent bg-accent-soft" : "border-line hover:bg-hover",
              )}
            >
              <EntityTile of="designs" size="sm" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-text">{d.name}</span>
                <span className="block text-xs text-text-3">
                  {d.blocks.length} block{d.blocks.length === 1 ? "" : "s"} · updated {f.relative(d.updatedAt)}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}
