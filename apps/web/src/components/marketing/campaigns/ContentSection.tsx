"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Blocks, Palette } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Callout } from "@/components/ui/Callout";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { ENTITY, EntityTile } from "@/components/ui/icons";
import { SearchInput } from "@/components/ui/SearchInput";
import { Skeleton } from "@/components/ui/Skeleton";
import { BlockEditor } from "@/components/marketing/BlockEditor";
import { useMarketing } from "@/components/marketing/common";
import { problemBlockIndex } from "@/components/marketing/designs/blocks";
import { DesignPreview } from "@/components/marketing/designs/DesignPreview";
import { DesignThumbnail } from "@/components/marketing/designs/DesignThumbnail";
import { ThemePanel } from "@/components/marketing/designs/ThemePanel";
import { cn } from "@/lib/cn";
import { useApiQuery } from "@/lib/query";
import { useFormat } from "@/lib/session";
import type { EmailDesign, MarketingCampaign } from "@/lib/types/marketing";
import type { SectionProps } from "./CampaignEditor";

/**
 * The theme and block editor beside a live preview, and "Start from a design"
 * (copies a saved design's blocks and theme in). The editor itself lists what
 * blocks sending and flags those blocks.
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
        .find((b) => problemBlockIndex(b.textContent ?? "") !== null)
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
                  {value.blocks.length ? "Switch design" : "Start from a design"}
                </Button>
              ) : undefined
            }
          />
          <CardBody className="flex flex-col gap-4">
            <ThemePanel theme={value.theme} onChange={(theme) => set("theme", theme)} disabled={disabled} className="shadow-none" />
            <div ref={editorRef} className="contents">
              <BlockEditor blocks={value.blocks} theme={value.theme} onChange={(blocks) => set("blocks", blocks)} disabled={disabled} />
            </div>
          </CardBody>
        </Card>
        <DesignPreview blocks={value.blocks} theme={value.theme} preheader={value.preheader} className="h-[min(760px,calc(100dvh-8rem))] min-h-[480px] xl:sticky xl:top-4" />
      </div>
      <DesignPicker open={picking} onOpenChange={setPicking} hasContent={value.blocks.length > 0} replacesUnsaved={contentDirty} applying={applying} onApply={applyDesign} />
    </div>
  );
}

function DesignPicker({
  open,
  onOpenChange,
  hasContent,
  replacesUnsaved,
  applying,
  onApply,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hasContent: boolean;
  replacesUnsaved: boolean;
  applying: boolean;
  onApply: (designId: string) => Promise<unknown>;
}) {
  const mk = useMarketing();
  const f = useFormat();
  const [chosen, setChosen] = useState("");
  const [q, setQ] = useState("");
  const designs = useApiQuery<EmailDesign[]>(mk.key("designs", "list"), open ? mk.path("/designs") : null);
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (designs.data ?? []).filter((d) => !d.archivedAt && (!needle || d.name.toLowerCase().includes(needle)));
  }, [designs.data, q]);
  const DesignGlyph = ENTITY.designs.icon;
  const change = (next: boolean) => {
    if (!next) {
      setChosen("");
      setQ("");
    }
    onOpenChange(next);
  };
  const apply = (id: string) =>
    void onApply(id)
      .then(() => change(false))
      .catch(() => undefined);
  const picked = rows.find((d) => d.id === chosen);
  return (
    <Modal
      open={open}
      onOpenChange={change}
      size="xl"
      title={hasContent ? "Switch design" : "Start from a design"}
      description="The design's blocks and theme are copied in. Later changes to the design do not change this campaign."
      footer={
        <>
          {picked && <span className="mr-auto truncate text-xs text-text-3">{picked.name}</span>}
          <Button onClick={() => change(false)} disabled={applying}>
            Cancel
          </Button>
          <Button variant={hasContent ? "danger" : "primary"} disabled={!chosen} loading={applying} onClick={() => apply(chosen)}>
            {hasContent ? "Replace content" : "Use this design"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {hasContent && (
          <Callout tone="warn">
            {replacesUnsaved
              ? "This replaces the campaign's current blocks and theme, including your unsaved edits."
              : "This replaces the campaign's current blocks and theme."}
          </Callout>
        )}
        {(designs.data?.length ?? 0) > 6 && <SearchInput value={q} onChange={setQ} delay={0} placeholder="Search designs" className="sm:max-w-xs" />}
        {designs.isPending ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-busy>
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="aspect-[4/3]" />
            ))}
          </div>
        ) : designs.isError ? (
          <p className="text-sm text-bad-ink">Designs could not be loaded: {designs.error.message}</p>
        ) : !rows.length ? (
          <EmptyState
            compact
            icon={<DesignGlyph />}
            title={q.trim() ? "No designs match" : "No designs yet"}
            description={q.trim() ? "Search looks at the design's name." : "Save reusable layouts under Designs, then start campaigns from them."}
            action={
              q.trim() ? undefined : (
                <Button size="sm" href={mk.href("/designs")}>
                  Open Designs
                </Button>
              )
            }
          />
        ) : (
          <div role="radiogroup" aria-label="Designs" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {rows.map((d) => (
              // A div, not a button: the thumbnail is an (inert) iframe, which a button may not contain.
              <div
                key={d.id}
                role="radio"
                tabIndex={chosen === d.id || (!chosen && d === rows[0]) ? 0 : -1}
                aria-checked={chosen === d.id}
                aria-label={d.name}
                onClick={() => setChosen(d.id)}
                onDoubleClick={() => apply(d.id)}
                onKeyDown={(e) => {
                  if (e.key === " " || e.key === "Enter") {
                    e.preventDefault();
                    if (e.key === "Enter" && chosen === d.id) apply(d.id);
                    else setChosen(d.id);
                  }
                }}
                className={cn(
                  "group flex min-w-0 cursor-pointer flex-col overflow-hidden rounded-lg border bg-panel text-left transition-shadow outline-none focus-visible:ring-2 focus-visible:ring-accent",
                  chosen === d.id ? "border-accent ring-2 ring-accent" : "border-line hover:shadow-card",
                )}
              >
                <DesignThumbnail blocks={d.blocks} theme={d.theme} className="aspect-[4/3] w-full border-b border-line" />
                <span className="flex min-w-0 items-center gap-2 px-2.5 py-2">
                  <EntityTile of="designs" size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-text">{d.name}</span>
                    <span className="block truncate text-xs text-text-3">
                      {d.blocks.length} block{d.blocks.length === 1 ? "" : "s"} · updated {f.relative(d.updatedAt)}
                    </span>
                  </span>
                  {d.fromLibrary && <Badge tone="info">Library</Badge>}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
