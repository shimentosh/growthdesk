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
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { designProblems, EmailBlock as EmailBlockSchema, newBlock, type EmailBlock, type EmailBlockType } from "@growthdesk/shared";
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
import { Input, Textarea } from "@/components/ui/Input";
import { focusAt, spliceToken } from "@/components/templates/VariableMenu";
import { BLOCK_META, BLOCK_TYPES, BlockTile, blockSummary, makeBlockId } from "@/components/marketing/designs/blocks";
import { Choice, TokenMenu } from "@/components/marketing/designs/controls";
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
 * its block.
 */
export function BlockEditor({ blocks, onChange, disabled }: { blocks: EmailBlock[]; onChange: (blocks: EmailBlock[]) => void; disabled?: boolean }) {
  // A short design opens fully; a long one starts as a tidy list of summaries.
  const [open, setOpen] = useState<Set<string>>(() => new Set(blocks.length <= 3 ? blocks.map((b) => b.id) : []));
  const reveal = useRef<string | null>(null);
  const cards = useRef(new Map<string, HTMLLIElement>());

  const problems = useMemo(() => designProblems(blocks), [blocks]);
  // "Button 3 needs…" → block index 2.
  const flagged = useMemo(() => {
    const m = new Map<number, string>();
    for (const p of problems) {
      const hit = /^(?:Button|Image) (\d+) /.exec(p);
      if (hit) m.set(Number(hit[1]) - 1, p);
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
              const at = /^(?:Button|Image) (\d+) /.exec(p);
              return (
                <li key={p}>
                  {at ? (
                    <button type="button" onClick={() => showBlock(Number(at[1]) - 1)} className="text-left underline decoration-line-strong underline-offset-2 hover:text-text">
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
              problem={flagged.get(i)}
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
  problem,
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
  problem?: string;
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
  // The shared schema's messages, by field ("url" → "Use a full link starting with https://").
  const errors = useMemo(() => {
    const parsed = EmailBlockSchema.safeParse(block);
    const out: Record<string, string> = {};
    if (!parsed.success) for (const issue of parsed.error.issues) out[String(issue.path[0] ?? "")] ??= issue.message;
    return out;
  }, [block]);
  const invalid = Boolean(problem) || Object.keys(errors).length > 0;

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
          <BlockFields block={block} errors={errors} problem={problem} disabled={disabled} onChange={onChange} />
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

/** Button colours that read well on white; "Default" leaves it to the email's accent. */
const SWATCHES = [
  { value: "#1d1d1f", label: "Graphite" },
  { value: "#248a3d", label: "Green" },
  { value: "#c93400", label: "Orange" },
  { value: "#d70015", label: "Red" },
  { value: "#8944ab", label: "Purple" },
];
const DEFAULT_BUTTON = "#0071e3";

type Errors = Record<string, string>;

function BlockFields({
  block: b,
  errors,
  problem,
  disabled,
  onChange,
}: {
  block: EmailBlock;
  errors: Errors;
  problem?: string;
  disabled?: boolean;
  onChange: (patch: Partial<EmailBlock>) => void;
}) {
  const textRef = useRef<HTMLTextAreaElement>(null);
  const headingRef = useRef<HTMLInputElement>(null);
  const labelRef = useRef<HTMLInputElement>(null);

  /** Drops a token at the caret of `el`, whose value is `value` and lives in `key`. */
  const insertToken = (el: HTMLInputElement | HTMLTextAreaElement | null, key: "text" | "label", value: string, token: string) => {
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
                <Swatch colour={DEFAULT_BUTTON} label="Default (blue)" selected={!colour} onClick={() => onChange({ color: undefined })} />
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
                  <span aria-hidden className="size-4 rounded-full border border-black/10" style={{ background: colour ?? DEFAULT_BUTTON }} />
                  <span className="font-mono tabular-nums">{(colour ?? DEFAULT_BUTTON).toLowerCase()}</span>
                  <input
                    type="color"
                    aria-label="Custom colour"
                    value={colour ?? DEFAULT_BUTTON}
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

function Slider({ value, min, max, step, unit, label, onChange }: { value: number; min: number; max: number; step: number; unit: string; label: string; onChange: (v: number) => void }) {
  return (
    <div className="flex items-center gap-3">
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-8 min-w-0 flex-1 accent-accent disabled:opacity-60"
      />
      <span className="w-14 shrink-0 text-right text-sm text-text-2 tabular-nums">
        {value}
        <span className="text-text-3"> {unit}</span>
      </span>
    </div>
  );
}
