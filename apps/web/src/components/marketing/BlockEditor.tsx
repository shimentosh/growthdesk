"use client";

import { useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDown,
  ArrowUp,
  Bold,
  ChevronRight,
  Copy,
  Ellipsis,
  Italic,
  Link2,
  ListPlus,
  Plus,
  X,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import {
  designProblems,
  EmailBlock as EmailBlockSchema,
  newBlock,
  resolveTheme,
  SOCIAL_NETWORKS,
  type EmailBlock,
  type EmailBlockType,
  type EmailColumnItem,
  type EmailTheme,
  type SocialNetwork,
} from "@growthdesk/shared";
import { Button, IconButton } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/DropdownMenu";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { ENTITY } from "@/components/ui/icons";
import { Input, NativeSelect, Textarea } from "@/components/ui/Input";
import { focusAt, spliceToken } from "@/components/templates/VariableMenu";
import { BLOCK_META, BLOCK_TYPES, BlockTile, blockSummary, makeBlockId, problemBlockIndex, SOCIAL_LABEL } from "@/components/marketing/designs/blocks";
import { Choice, ColorField, Slider, TokenMenu } from "@/components/marketing/designs/controls";
import { cn } from "@/lib/cn";

/*
 * The email block editor, shared by the design editor and the campaign
 * content tab. Contract (keep it stable): edits a list of blocks in place and
 * reports every change through onChange.
 *
 * One card per block: a header (type, summary, reorder and the block menu)
 * that expands into the block's fields. Field shapes follow the shared
 * EmailBlock schema, and its messages show under the field they belong to;
 * the design's send blockers (designProblems) sit on top, each one a link to
 * its block. `theme` (optional) only sets what the "default" colours look like.
 */
export function BlockEditor({ blocks, onChange, disabled, theme }: { blocks: EmailBlock[]; onChange: (blocks: EmailBlock[]) => void; disabled?: boolean; theme?: EmailTheme }) {
  // A short design opens fully; a long one starts as a tidy list of summaries.
  const [open, setOpen] = useState<Set<string>>(() => new Set(blocks.length <= 3 ? blocks.map((b) => b.id) : []));
  const reveal = useRef<string | null>(null);
  const cards = useRef(new Map<string, HTMLLIElement>());

  const problems = useMemo(() => designProblems(blocks), [blocks]);
  const resolved = useMemo(() => resolveTheme(theme), [theme]);
  // "Button 3 needs…" → block index 2 (a block can have several).
  const flagged = useMemo(() => {
    const m = new Map<number, string[]>();
    for (const p of problems) {
      const at = problemBlockIndex(p);
      if (at !== null) m.set(at, [...(m.get(at) ?? []), p]);
    }
    return m;
  }, [problems]);

  // Scroll a newly added, duplicated or problem block into view and focus its first field.
  useEffect(() => {
    const id = reveal.current;
    if (!id) return;
    reveal.current = null;
    const el = cards.current.get(id);
    if (!el) return;
    requestAnimationFrame(() => {
      el.scrollIntoView({ block: "nearest", behavior: "smooth" });
      // The field that needs fixing (a problem block's link), else the first one.
      const field =
        el.querySelector<HTMLElement>("fieldset [aria-invalid=true]") ??
        el.querySelector<HTMLElement>("fieldset input:not([type=color]):not([type=range]), fieldset textarea");
      field?.focus({ preventScroll: true });
    });
  });

  const expand = (id: string) => setOpen((s) => new Set(s).add(id));
  const toggle = (id: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const update = (i: number, patch: Partial<EmailBlock>) => onChange(blocks.map((b, j) => (j === i ? ({ ...b, ...patch } as EmailBlock) : b)));
  const move = (i: number, by: -1 | 1) => {
    const a = blocks[i];
    const b = blocks[i + by];
    if (!a || !b) return;
    onChange(blocks.map((x, k) => (k === i ? b : k === i + by ? a : x)));
  };
  const insertAt = (at: number, block: EmailBlock) => {
    onChange([...blocks.slice(0, at), block, ...blocks.slice(at)]);
    expand(block.id);
    reveal.current = block.id;
  };
  const add = (type: EmailBlockType, at = blocks.length) => insertAt(at, newBlock(type, makeBlockId(blocks.map((b) => b.id))));
  const duplicate = (i: number) => {
    const source = blocks[i];
    if (source) insertAt(i + 1, { ...source, id: makeBlockId(blocks.map((b) => b.id)) });
  };
  const remove = (i: number) => onChange(blocks.filter((_, j) => j !== i));
  const showBlock = (i: number) => {
    const b = blocks[i];
    if (!b) return;
    expand(b.id);
    reveal.current = b.id;
  };

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {problems.length > 0 && (
        <Callout tone="warn" title={problems.length === 1 ? "One thing to fix before this can be sent" : `${problems.length} things to fix before this can be sent`}>
          <ul className="mt-1 flex flex-col gap-0.5 text-xs">
            {problems.map((p) => {
              const at = problemBlockIndex(p);
              return (
                <li key={p}>
                  {at !== null ? (
                    <button type="button" onClick={() => showBlock(at)} className="text-left underline decoration-line-strong underline-offset-2 hover:text-text">
                      {p}
                    </button>
                  ) : (
                    p
                  )}
                </li>
              );
            })}
          </ul>
        </Callout>
      )}

      {blocks.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line-strong">
          <EmptyState
            compact
            icon={<ENTITY.designs.icon />}
            title="No blocks yet"
            description={disabled ? "This email has no content." : "Start with a heading and some text, then add a button for the one thing you want people to do."}
            action={!disabled && <AddBlockMenu onPick={(t) => add(t)} variant="primary" />}
          />
        </div>
      ) : (
        <ol className="flex flex-col gap-2">
          {blocks.map((b, i) => (
            <BlockCard
              key={b.id}
              block={b}
              index={i}
              count={blocks.length}
              expanded={open.has(b.id)}
              problems={flagged.get(i)}
              theme={resolved}
              disabled={disabled}
              cardRef={(el) => {
                if (el) cards.current.set(b.id, el);
                else cards.current.delete(b.id);
              }}
              onToggle={() => toggle(b.id)}
              onChange={(patch) => update(i, patch)}
              onMove={(by) => move(i, by)}
              onDuplicate={() => duplicate(i)}
              onInsertBelow={(t) => add(t, i + 1)}
              onRemove={() => remove(i)}
            />
          ))}
        </ol>
      )}

      {!disabled && blocks.length > 0 && (
        <div>
          <AddBlockMenu onPick={(t) => add(t)} disabled={blocks.length >= 100} />
        </div>
      )}
    </div>
  );
}

function AddBlockMenu({ onPick, variant = "secondary", disabled }: { onPick: (type: EmailBlockType) => void; variant?: "primary" | "secondary"; disabled?: boolean }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button variant={variant} icon={<Plus />} title={disabled ? "An email holds up to 100 blocks." : undefined}>
          Add block
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <BlockTypeItems onPick={onPick} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function BlockTypeItems({ onPick }: { onPick: (type: EmailBlockType) => void }) {
  return (
    <>
      {BLOCK_TYPES.map((t) => (
        <DropdownMenuItem key={t.type} onSelect={() => onPick(t.type)} icon={<BlockTile type={t.type} />} className="h-auto py-1.5">
          <span className="block font-medium">{t.label}</span>
          <span className="block truncate text-xs text-text-3">{t.hint}</span>
        </DropdownMenuItem>
      ))}
    </>
  );
}

function BlockCard({
  block,
  index,
  count,
  expanded,
  problems = [],
  theme,
  disabled,
  cardRef,
  onToggle,
  onChange,
  onMove,
  onDuplicate,
  onInsertBelow,
  onRemove,
}: {
  block: EmailBlock;
  index: number;
  count: number;
  expanded: boolean;
  problems?: string[];
  theme: Theme;
  disabled?: boolean;
  cardRef: (el: HTMLLIElement | null) => void;
  onToggle: () => void;
  onChange: (patch: Partial<EmailBlock>) => void;
  onMove: (by: -1 | 1) => void;
  onDuplicate: () => void;
  onInsertBelow: (type: EmailBlockType) => void;
  onRemove: () => void;
}) {
  const bodyId = useId();
  const meta = BLOCK_META[block.type];
  const hasFields = block.type !== "divider";
  // The shared schema's messages, by field ("url" → "Use a full link starting with https://") and by full path ("items.1.linkUrl").
  const errors = useMemo(() => {
    const parsed = EmailBlockSchema.safeParse(block);
    const out: Record<string, string> = {};
    if (!parsed.success)
      for (const issue of parsed.error.issues) {
        out[String(issue.path[0] ?? "")] ??= issue.message;
        if (issue.path.length > 1) out[issue.path.join(".")] ??= issue.message;
      }
    return out;
  }, [block]);
  const invalid = problems.length > 0 || Object.keys(errors).length > 0;

  return (
    <li ref={cardRef} className={cn("min-w-0 scroll-my-4 rounded-lg border bg-panel shadow-card transition-colors", invalid ? "border-warn-edge" : "border-line")}>
      <div className="flex items-center gap-1 py-1.5 pr-1.5 pl-2">
        <button
          type="button"
          aria-expanded={hasFields ? expanded : undefined}
          aria-controls={hasFields && expanded ? bodyId : undefined}
          onClick={hasFields ? onToggle : undefined}
          className={cn("flex min-w-0 flex-1 items-center gap-2 rounded-sm py-0.5 text-left", !hasFields && "cursor-default")}
        >
          {hasFields ? (
            <ChevronRight aria-hidden className={cn("size-3.5 shrink-0 text-text-3 transition-transform", expanded && "rotate-90")} />
          ) : (
            <span aria-hidden className="size-3.5 shrink-0" />
          )}
          <BlockTile type={block.type} size="md" />
          <span className="ml-0.5 min-w-0 flex-1">
            <span className="block text-sm font-medium text-text">{meta.label}</span>
            <span className={cn("block truncate text-xs", expanded && hasFields ? "text-text-3" : "text-text-2")}>{expanded && hasFields ? meta.hint : blockSummary(block)}</span>
          </span>
          {invalid && <TriangleAlert aria-label="Needs attention" className="size-4 shrink-0 text-warn-ink" />}
        </button>
        {!disabled && (
          <div className="flex shrink-0 items-center">
            <IconButton size="sm" label="Move up" icon={<ArrowUp />} disabled={index === 0} onClick={() => onMove(-1)} />
            <IconButton size="sm" label="Move down" icon={<ArrowDown />} disabled={index === count - 1} onClick={() => onMove(1)} />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton size="sm" label={`More for ${meta.label.toLowerCase()} block`} icon={<Ellipsis />} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem icon={<Copy />} onSelect={onDuplicate} disabled={count >= 100}>
                  Duplicate
                </DropdownMenuItem>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger icon={<ListPlus />} disabled={count >= 100}>
                    Add block below
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="w-72">
                    <BlockTypeItems onPick={onInsertBelow} />
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuSeparator />
                <DropdownMenuItem danger icon={<Trash2 />} onSelect={onRemove}>
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </div>
      {hasFields && expanded && (
        <fieldset id={bodyId} disabled={disabled} className="flex min-w-0 flex-col gap-3 border-t border-line px-3 pt-3 pb-3.5">
          <BlockFields block={block} errors={errors} problems={problems} theme={theme} disabled={disabled} onChange={onChange} />
        </fieldset>
      )}
    </li>
  );
}

const ALIGN = [
  { value: "left" as const, label: "Align left", icon: <AlignLeft />, iconOnly: true },
  { value: "center" as const, label: "Align centre", icon: <AlignCenter />, iconOnly: true },
  { value: "right" as const, label: "Align right", icon: <AlignRight />, iconOnly: true },
];

type Theme = ReturnType<typeof resolveTheme>;

/** A full link, as designProblems wants it (https://host.tld/…, mailto: or a token). */
const FULL_URL = /^(https?:\/\/[^/\s]+\.[^\s]+|mailto:\S+|\{\{.+\}\})$/i;

/** Black or white, whichever reads better on `bg` (as the renderer picks it). */
function contrastOn(bg: string): string {
  const n = parseInt(bg.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? "#1d1d1f" : "#ffffff";
}

/** Button colours that read well on white; "Default" leaves it to the email's accent. */
const SWATCHES = [
  { value: "#1d1d1f", label: "Graphite" },
  { value: "#248a3d", label: "Green" },
  { value: "#c93400", label: "Orange" },
  { value: "#d70015", label: "Red" },
  { value: "#8944ab", label: "Purple" },
];

type Errors = Record<string, string>;

function BlockFields({
  block: b,
  errors,
  problems,
  theme: t,
  disabled,
  onChange,
}: {
  block: EmailBlock;
  errors: Errors;
  problems: string[];
  theme: Theme;
  disabled?: boolean;
  onChange: (patch: Partial<EmailBlock>) => void;
}) {
  const textRef = useRef<HTMLTextAreaElement>(null);
  const headingRef = useRef<HTMLInputElement>(null);
  const labelRef = useRef<HTMLInputElement>(null);
  const problem = problems[0];

  /** Drops a token at the caret of `el`, whose value is `value` and lives in `key`. */
  const insertToken = (el: HTMLInputElement | HTMLTextAreaElement | null, key: string, value: string, token: string) => {
    const next = spliceToken(el, value, token);
    onChange({ [key]: next.value } as Partial<EmailBlock>);
    focusAt(el, next.caret);
  };

  switch (b.type) {
    case "heading":
      return (
        <>
          <Field label="Heading" error={errors.text} labelAction={!disabled && <TokenMenu onPick={(t) => insertToken(headingRef.current, "text", b.text, t)} />}>
            <Input ref={headingRef} value={b.text} maxLength={300} onChange={(e) => onChange({ text: e.target.value })} placeholder="A headline for your email" />
          </Field>
          <div className="flex flex-wrap gap-x-5 gap-y-3">
            <Field label="Size">
              <Choice
                aria-label="Heading size"
                value={b.level}
                disabled={disabled}
                onChange={(level) => onChange({ level })}
                options={[
                  { value: 1, label: "Large" },
                  { value: 2, label: "Small" },
                ]}
              />
            </Field>
            <Field label="Alignment">
              <Choice aria-label="Heading alignment" value={b.align} disabled={disabled} onChange={(align) => onChange({ align })} options={ALIGN} />
            </Field>
          </div>
        </>
      );

    case "text":
      return (
        <>
          <Field
            label="Text"
            error={errors.text}
            hint={
              <>
                <code className="font-mono">**bold**</code>, <code className="font-mono">*italic*</code>, <code className="font-mono">[link](https://…)</code> and{" "}
                <code className="font-mono">{"{{first_name|there}}"}</code>. Line breaks are kept.
              </>
            }
            labelAction={!disabled && <TextToolbar el={textRef} value={b.text} onChange={(text) => onChange({ text })} onToken={(t) => insertToken(textRef.current, "text", b.text, t)} />}
          >
            <Textarea ref={textRef} rows={6} value={b.text} maxLength={10_000} onChange={(e) => onChange({ text: e.target.value })} placeholder={"Hi {{first_name|there}},\n\n…"} />
          </Field>
          <Field label="Alignment">
            <Choice aria-label="Text alignment" value={b.align} disabled={disabled} onChange={(align) => onChange({ align })} options={ALIGN} />
          </Field>
        </>
      );

    case "button": {
      const colour = b.color ?? null;
      return (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Label" error={errors.label} labelAction={!disabled && <TokenMenu onPick={(t) => insertToken(labelRef.current, "label", b.label, t)} />}>
              <Input ref={labelRef} value={b.label} maxLength={80} onChange={(e) => onChange({ label: e.target.value })} placeholder="Learn more" />
            </Field>
            <Field label="Link" error={errors.url ?? (problem ? "Use a full link, like https://example.com/offer." : undefined)}>
              <Input type="url" inputMode="url" value={b.url} maxLength={2000} onChange={(e) => onChange({ url: e.target.value })} placeholder="https://example.com/offer" />
            </Field>
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-3">
            <Field label="Alignment">
              <Choice aria-label="Button alignment" value={b.align} disabled={disabled} onChange={(align) => onChange({ align })} options={ALIGN} />
            </Field>
            <Field label="Colour" error={errors.color}>
              <div role="group" aria-label="Button colour" className="flex h-8 items-center gap-1.5">
                <Swatch colour={t.accent} label="Theme accent" selected={!colour} onClick={() => onChange({ color: undefined })} />
                {SWATCHES.map((s) => (
                  <Swatch key={s.value} colour={s.value} label={s.label} selected={colour?.toLowerCase() === s.value} onClick={() => onChange({ color: s.value })} />
                ))}
                <label
                  title="Custom colour"
                  className={cn(
                    "relative ml-0.5 inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-sm border border-line-strong bg-ctl-face px-1.5 text-xs text-text-2 shadow-sm hover:bg-ctl-hover has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60",
                    colour && !SWATCHES.some((s) => s.value === colour.toLowerCase()) && "border-accent text-text",
                  )}
                >
                  <span aria-hidden className="size-4 rounded-full border border-black/10" style={{ background: colour ?? t.accent }} />
                  <span className="font-mono tabular-nums">{(colour ?? t.accent).toLowerCase()}</span>
                  <input
                    type="color"
                    aria-label="Custom colour"
                    value={colour ?? t.accent}
                    onChange={(e) => onChange({ color: e.target.value })}
                    className="absolute inset-0 size-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
                  />
                </label>
              </div>
            </Field>
          </div>
        </>
      );
    }

    case "image":
      return (
        <>
          <Field label="Image URL" error={errors.src ?? (problem ? "Use the image's full address, like https://example.com/photo.jpg." : undefined)} hint="A public https:// address. JPG, PNG or GIF read well in every inbox.">
            <Input type="url" inputMode="url" value={b.src} maxLength={2000} onChange={(e) => onChange({ src: e.target.value })} placeholder="https://example.com/photo.jpg" />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Description" error={errors.alt} hint="Read aloud by screen readers and shown when images are off.">
              <Input value={b.alt} maxLength={300} onChange={(e) => onChange({ alt: e.target.value })} placeholder="Our new dashboard on a laptop" />
            </Field>
            <Field label="Link" error={errors.href} hint="Optional. Where a click on the image goes.">
              <Input
                type="url"
                inputMode="url"
                value={b.href ?? ""}
                maxLength={2000}
                onChange={(e) => onChange({ href: e.target.value.trim() ? e.target.value : undefined })}
                placeholder="https://example.com"
              />
            </Field>
          </div>
          <Field label="Width" error={errors.width}>
            <Slider value={b.width} min={10} max={100} step={5} unit="%" label="Image width" onChange={(width) => onChange({ width })} />
          </Field>
        </>
      );

    case "spacer":
      return (
        <Field label="Height" error={errors.height}>
          <Slider value={b.height} min={4} max={120} step={4} unit="px" label="Spacer height" onChange={(height) => onChange({ height })} />
        </Field>
      );

    case "header":
      return (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Brand name" error={errors.brand} hint="Shown as a wordmark when there is no logo, and as the logo's description.">
              <Input ref={headingRef} value={b.brand} maxLength={80} onChange={(e) => onChange({ brand: e.target.value })} placeholder="Acme" />
            </Field>
            <Field label="Tagline" error={errors.tagline} hint="Optional. A short line under the brand.">
              <Input value={b.tagline} maxLength={120} onChange={(e) => onChange({ tagline: e.target.value })} placeholder="Monthly product news" />
            </Field>
          </div>
          <Field label="Logo URL" error={errors.logo} hint="Optional. A public https:// image about 32 px tall; a PNG with a transparent background works best.">
            <Input type="url" inputMode="url" value={b.logo} maxLength={2000} onChange={(e) => onChange({ logo: e.target.value })} placeholder="https://example.com/logo.png" />
          </Field>
          <div className="flex flex-wrap gap-x-5 gap-y-3">
            <Field label="Alignment">
              <Choice aria-label="Header alignment" value={b.align} disabled={disabled} onChange={(align) => onChange({ align })} options={ALIGN} />
            </Field>
            <Field label="Background" error={errors.background}>
              <ColorField label="Header background" value={b.background} fallback={t.surface} disabled={disabled} onChange={(background) => onChange({ background })} />
            </Field>
            <Field label="Text colour" error={errors.color}>
              <ColorField
                label="Header text colour"
                value={b.color}
                fallback={b.background ? contrastOn(b.background) : t.heading}
                disabled={disabled}
                onChange={(color) => onChange({ color })}
              />
            </Field>
          </div>
        </>
      );

    case "hero": {
      const bg = b.background ?? t.tint;
      return (
        <>
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
            <Field label="Eyebrow" error={errors.eyebrow} hint="Optional. A small label above the title.">
              <Input value={b.eyebrow} maxLength={80} onChange={(e) => onChange({ eyebrow: e.target.value })} placeholder="New" />
            </Field>
            <Field label="Title" error={errors.title} labelAction={!disabled && <TokenMenu onPick={(tok) => insertToken(headingRef.current, "title", b.title, tok)} />}>
              <Input ref={headingRef} value={b.title} maxLength={200} onChange={(e) => onChange({ title: e.target.value })} placeholder="A big idea, said simply" />
            </Field>
          </div>
          <Field
            label="Text"
            error={errors.text}
            labelAction={!disabled && <TextToolbar el={textRef} value={b.text} onChange={(text) => onChange({ text })} onToken={(tok) => insertToken(textRef.current, "text", b.text, tok)} />}
          >
            <Textarea ref={textRef} rows={3} value={b.text} maxLength={2000} onChange={(e) => onChange({ text: e.target.value })} placeholder="One or two lines on why it matters." />
          </Field>
          <Field label="Image URL" error={errors.image} hint="Optional. Shown under the text, full width.">
            <Input type="url" inputMode="url" value={b.image} maxLength={2000} onChange={(e) => onChange({ image: e.target.value })} placeholder="https://example.com/hero.jpg" />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Button label" error={errors.buttonLabel} hint="Leave empty for no button.">
              <Input ref={labelRef} value={b.buttonLabel} maxLength={80} onChange={(e) => onChange({ buttonLabel: e.target.value })} placeholder="Find out more" />
            </Field>
            <Field label="Button link" error={errors.buttonUrl ?? (problem ? "Use a full link, like https://example.com/offer." : undefined)}>
              <Input type="url" inputMode="url" value={b.buttonUrl} maxLength={2000} onChange={(e) => onChange({ buttonUrl: e.target.value })} placeholder="https://example.com/offer" />
            </Field>
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-3">
            <Field label="Alignment">
              <Choice aria-label="Hero alignment" value={b.align} disabled={disabled} onChange={(align) => onChange({ align })} options={ALIGN} />
            </Field>
            <Field label="Background" error={errors.background}>
              <ColorField label="Hero background" value={b.background} fallback={t.tint} disabled={disabled} onChange={(background) => onChange({ background })} />
            </Field>
            <Field label="Text colour" error={errors.color}>
              <ColorField label="Hero text colour" value={b.color} fallback={contrastOn(bg)} disabled={disabled} onChange={(color) => onChange({ color })} />
            </Field>
          </div>
        </>
      );
    }

    case "columns": {
      const setItem = (j: number, patch: Partial<EmailColumnItem>) => onChange({ items: b.items.map((it, k) => (k === j ? { ...it, ...patch } : it)) });
      const setCount = (n: 2 | 3) => {
        if (n === b.items.length) return;
        onChange({ items: n < b.items.length ? b.items.slice(0, n) : [...b.items, { image: "", title: "Another point", text: "A short line about it.", linkLabel: "", linkUrl: "" }] });
      };
      return (
        <>
          <div className="flex flex-wrap gap-x-5 gap-y-3">
            <Field label="Columns" hint="They stack on phones.">
              <Choice<2 | 3>
                aria-label="Number of columns"
                value={b.items.length === 3 ? 3 : 2}
                disabled={disabled}
                onChange={setCount}
                options={[
                  { value: 2, label: "Two" },
                  { value: 3, label: "Three" },
                ]}
              />
            </Field>
            <Field label="Alignment">
              <Choice aria-label="Column alignment" value={b.align} disabled={disabled} onChange={(align) => onChange({ align })} options={ALIGN} />
            </Field>
          </div>
          {b.items.map((it, j) => {
            const linkProblem = problems.some((p) => p.startsWith(`Column ${j + 1} in block`));
            return (
              <div key={j} className="flex flex-col gap-3 rounded-md border border-line bg-s-2 p-3">
                <p className="text-xs font-semibold text-text-2">Column {j + 1}</p>
                <Field label="Title" error={errors[`items.${j}.title`]}>
                  <Input value={it.title} maxLength={200} onChange={(e) => setItem(j, { title: e.target.value })} placeholder="A feature or product" />
                </Field>
                <Field label="Text" error={errors[`items.${j}.text`]}>
                  <Textarea rows={2} value={it.text} maxLength={2000} onChange={(e) => setItem(j, { text: e.target.value })} placeholder="A short line about it." />
                </Field>
                <Field label="Image URL" error={errors[`items.${j}.image`]} hint="Optional.">
                  <Input type="url" inputMode="url" value={it.image} maxLength={2000} onChange={(e) => setItem(j, { image: e.target.value })} placeholder="https://example.com/photo.jpg" />
                </Field>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Link label" error={errors[`items.${j}.linkLabel`]} hint="Optional.">
                    <Input value={it.linkLabel} maxLength={80} onChange={(e) => setItem(j, { linkLabel: e.target.value })} placeholder="Read more" />
                  </Field>
                  <Field label="Link" error={errors[`items.${j}.linkUrl`] ?? (linkProblem ? "Use a full link, like https://example.com/page." : undefined)}>
                    <Input type="url" inputMode="url" value={it.linkUrl} maxLength={2000} onChange={(e) => setItem(j, { linkUrl: e.target.value })} placeholder="https://example.com/page" />
                  </Field>
                </div>
              </div>
            );
          })}
        </>
      );
    }

    case "quote":
      return (
        <>
          <Field label="Quote" error={errors.text}>
            <Textarea ref={textRef} rows={3} value={b.text} maxLength={1000} onChange={(e) => onChange({ text: e.target.value })} placeholder="This changed how our team works." />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Who said it" error={errors.author}>
              <Input value={b.author} maxLength={120} onChange={(e) => onChange({ author: e.target.value })} placeholder="Jamie Lee" />
            </Field>
            <Field label="Role" error={errors.role} hint="Optional.">
              <Input value={b.role} maxLength={160} onChange={(e) => onChange({ role: e.target.value })} placeholder="Head of Sales, Acme" />
            </Field>
          </div>
        </>
      );

    case "callout":
      return (
        <>
          <Field label="Title" error={errors.title} labelAction={!disabled && <TokenMenu onPick={(tok) => insertToken(headingRef.current, "title", b.title, tok)} />}>
            <Input ref={headingRef} value={b.title} maxLength={200} onChange={(e) => onChange({ title: e.target.value })} placeholder="Limited time" />
          </Field>
          <Field
            label="Text"
            error={errors.text}
            labelAction={!disabled && <TextToolbar el={textRef} value={b.text} onChange={(text) => onChange({ text })} onToken={(tok) => insertToken(textRef.current, "text", b.text, tok)} />}
          >
            <Textarea ref={textRef} rows={3} value={b.text} maxLength={2000} onChange={(e) => onChange({ text: e.target.value })} placeholder="Use code **WELCOME20** before Friday." />
          </Field>
          <div className="flex flex-wrap gap-x-5 gap-y-3">
            <Field label="Alignment">
              <Choice aria-label="Callout alignment" value={b.align} disabled={disabled} onChange={(align) => onChange({ align })} options={ALIGN} />
            </Field>
            <Field label="Background" error={errors.background}>
              <ColorField label="Callout background" value={b.background} fallback={t.tint} disabled={disabled} onChange={(background) => onChange({ background })} />
            </Field>
          </div>
        </>
      );

    case "list": {
      const setItems = (items: string[]) => onChange({ items });
      const moveItem = (j: number, by: -1 | 1) => {
        const a = b.items[j];
        const c = b.items[j + by];
        if (a === undefined || c === undefined) return;
        setItems(b.items.map((x, k) => (k === j ? c : k === j + by ? a : x)));
      };
      return (
        <>
          <Field label="Style">
            <Choice
              aria-label="List style"
              value={b.ordered ? "ordered" : "bullets"}
              disabled={disabled}
              onChange={(v) => onChange({ ordered: v === "ordered" })}
              options={[
                { value: "bullets", label: "Bullets" },
                { value: "ordered", label: "Numbered" },
              ]}
            />
          </Field>
          <Group
            label="Items"
            error={errors.items}
            hint={
              <>
                Each item takes <code className="font-mono">**bold**</code>, <code className="font-mono">*italic*</code> and links. Enter adds the next item.
              </>
            }
          >
            <ol className="flex flex-col gap-1.5">
              {b.items.map((item, j) => (
                <li key={j} className="flex items-center gap-1">
                  <span aria-hidden className="w-5 shrink-0 text-right text-xs text-text-3 tabular-nums">
                    {b.ordered ? `${j + 1}.` : "•"}
                  </span>
                  <Input
                    aria-label={`Item ${j + 1}`}
                    value={item}
                    maxLength={500}
                    invalid={Boolean(errors[`items.${j}`])}
                    onChange={(e) => setItems(b.items.map((x, k) => (k === j ? e.target.value : x)))}
                    onKeyDown={(e) => {
                      // Enter adds the next item, like a word processor.
                      if (e.key === "Enter" && !e.nativeEvent.isComposing && b.items.length < 12) {
                        e.preventDefault();
                        setItems([...b.items.slice(0, j + 1), "", ...b.items.slice(j + 1)]);
                        const row = e.currentTarget.closest("li");
                        requestAnimationFrame(() => row?.nextElementSibling?.querySelector("input")?.focus());
                      }
                    }}
                    placeholder="A point worth making"
                    className="min-w-0 flex-1"
                  />
                  {!disabled && (
                    <span className="flex shrink-0 items-center">
                      <IconButton size="sm" label={`Move item ${j + 1} up`} icon={<ArrowUp />} disabled={j === 0} onClick={() => moveItem(j, -1)} />
                      <IconButton size="sm" label={`Move item ${j + 1} down`} icon={<ArrowDown />} disabled={j === b.items.length - 1} onClick={() => moveItem(j, 1)} />
                      <IconButton size="sm" label={`Remove item ${j + 1}`} icon={<X />} disabled={b.items.length <= 1} onClick={() => setItems(b.items.filter((_, k) => k !== j))} />
                    </span>
                  )}
                </li>
              ))}
            </ol>
          </Group>
          {!disabled && (
            <div>
              <Button size="sm" icon={<Plus />} disabled={b.items.length >= 12} title={b.items.length >= 12 ? "A list holds up to 12 items." : undefined} onClick={() => setItems([...b.items, ""])}>
                Add item
              </Button>
            </div>
          )}
        </>
      );
    }

    case "social": {
      const setLinks = (links: typeof b.links) => onChange({ links });
      const used = new Set(b.links.map((l) => l.network));
      const nextNetwork = SOCIAL_NETWORKS.find((n) => !used.has(n)) ?? "website";
      return (
        <>
          <Group label="Links" error={errors.links} hint="Each one shows as a small labelled button.">
            {b.links.length === 0 ? (
              <p className="text-xs text-text-3">No links yet. Add your website or a social profile.</p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {b.links.map((l, j) => {
                  const err = errors[`links.${j}.url`] ?? (problem && !FULL_URL.test(l.url.trim()) ? "Use a full link, like https://linkedin.com/company/acme." : undefined);
                  return (
                    <li key={j} className="flex flex-col gap-1">
                      <div className="flex items-center gap-1.5">
                        <NativeSelect
                          aria-label={`Network for link ${j + 1}`}
                          className="w-36 shrink-0"
                          value={l.network}
                          disabled={disabled}
                          onChange={(e) => setLinks(b.links.map((x, k) => (k === j ? { ...x, network: e.target.value as SocialNetwork } : x)))}
                          options={SOCIAL_NETWORKS.map((n) => ({ value: n, label: SOCIAL_LABEL[n] }))}
                        />
                        <Input
                          type="url"
                          inputMode="url"
                          aria-label={`${SOCIAL_LABEL[l.network]} link`}
                          value={l.url}
                          maxLength={2000}
                          invalid={Boolean(err)}
                          onChange={(e) => setLinks(b.links.map((x, k) => (k === j ? { ...x, url: e.target.value } : x)))}
                          placeholder="https://"
                          className="min-w-0 flex-1"
                        />
                        {!disabled && <IconButton size="sm" label={`Remove ${SOCIAL_LABEL[l.network]} link`} icon={<X />} onClick={() => setLinks(b.links.filter((_, k) => k !== j))} />}
                      </div>
                      {err && <p className="pl-39 text-xs text-bad-ink">{err}</p>}
                    </li>
                  );
                })}
              </ul>
            )}
          </Group>
          <div className="flex flex-wrap items-end gap-x-5 gap-y-3">
            {!disabled && (
              <Button
                size="sm"
                icon={<Plus />}
                disabled={b.links.length >= 8}
                title={b.links.length >= 8 ? "Up to 8 links." : undefined}
                onClick={() => setLinks([...b.links, { network: nextNetwork, url: "https://" }])}
              >
                Add link
              </Button>
            )}
            <Field label="Alignment">
              <Choice aria-label="Social links alignment" value={b.align} disabled={disabled} onChange={(align) => onChange({ align })} options={ALIGN} />
            </Field>
          </div>
        </>
      );
    }

    case "divider":
      return null;
  }
}

/** Bold, italic and link wrap the selection in the text block's markup; Personalise drops a token at the caret. */
function TextToolbar({
  el,
  value,
  onChange,
  onToken,
}: {
  el: RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (text: string) => void;
  onToken: (token: string) => void;
}) {
  const wrap = (before: string, after: string, placeholder: string, selectPart?: "inner" | "after") => {
    const t = el.current;
    const start = t?.selectionStart ?? value.length;
    const end = t?.selectionEnd ?? start;
    const inner = value.slice(start, end) || placeholder;
    onChange(value.slice(0, start) + before + inner + after + value.slice(end));
    requestAnimationFrame(() => {
      if (!t) return;
      t.focus();
      // Select what the person most likely types next: the link address, or the placeholder word.
      if (selectPart === "after") t.setSelectionRange(start + before.length + inner.length + 2, start + before.length + inner.length + after.length - 1);
      else t.setSelectionRange(start + before.length, start + before.length + inner.length);
    });
  };
  return (
    <div className="-my-1 flex items-center">
      <ToolbarButton label="Bold" icon={<Bold />} onClick={() => wrap("**", "**", "bold text")} />
      <ToolbarButton label="Italic" icon={<Italic />} onClick={() => wrap("*", "*", "italic text")} />
      <ToolbarButton label="Link" icon={<Link2 />} onClick={() => wrap("[", "](https://)", "link text", "after")} />
      <span aria-hidden className="mx-1 h-4 w-px bg-line" />
      <TokenMenu onPick={onToken} />
    </div>
  );
}

function ToolbarButton({ label, icon, onClick }: { label: string; icon: ReactNode; onClick: () => void }) {
  return (
    <IconButton
      label={label}
      icon={icon}
      size="sm"
      // Keep the textarea's selection: a mousedown on the button would otherwise blur it first.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className="size-6"
    />
  );
}

/** Like Field, for a label over several controls (each row names itself): no shared id or invalid state. */
function Group({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={label} className="flex min-w-0 flex-col gap-1.5">
      <p className="text-xs font-medium text-text-2">{label}</p>
      {children}
      {(error || hint) && <p className={cn("text-xs", error ? "text-bad-ink" : "text-text-3")}>{error || hint}</p>}
    </div>
  );
}

function Swatch({ colour, label, selected, onClick }: { colour: string; label: string; selected: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={selected}
      title={label}
      onClick={onClick}
      style={{ background: colour }}
      className={cn(
        "size-6 shrink-0 rounded-full border border-black/10 transition-shadow disabled:opacity-60",
        selected ? "ring-2 ring-accent ring-offset-2 ring-offset-panel" : "hover:ring-2 hover:ring-line-strong hover:ring-offset-1 hover:ring-offset-panel",
      )}
    />
  );
}
