"use client";

import { createContext, useContext, useRef, type ComponentProps, type ReactNode } from "react";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDown,
  ArrowUp,
  Copy,
  Heading,
  Image as ImageIcon,
  Minus,
  MousePointerClick,
  MoveVertical,
  Square,
  Trash2,
  Type,
  type LucideIcon,
} from "lucide-react";
import { EMAIL_BLOCK_TYPES, newBlock, type EmailBlock, type EmailBlockType, type PlatformTemplateVariable } from "@growthdesk/shared";
import { Button, IconButton } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input, NativeSelect, Textarea } from "@/components/ui/Input";
import { Tooltip } from "@/components/ui/Tooltip";
import { toast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";

/*
 * A compact editor for the EmailBlock model (packages/shared/src/email-design.ts):
 * heading, text (with **bold**, *italic*, [link](url)), button, image, divider,
 * spacer. Variables are inserted at the caret of whichever text field was
 * focused last (TokenScope + VariablePicker).
 */

// ─── Token insertion ────────────────────────────────────────────────────────

type Target = { el: HTMLInputElement | HTMLTextAreaElement; set: (value: string) => void };
const TokenContext = createContext<{ current: { current: Target | null } } | null>(null);

export function TokenScope({ children }: { children: ReactNode }) {
  const ref = useRef<Target | null>(null);
  return <TokenContext.Provider value={{ current: ref }}>{children}</TokenContext.Provider>;
}

function useTokenTarget(set: (v: string) => void) {
  const ctx = useContext(TokenContext);
  return (e: { currentTarget: HTMLInputElement | HTMLTextAreaElement }) => {
    if (ctx) ctx.current.current = { el: e.currentTarget, set };
  };
}

export function TokenInput({ value, onChange, ...rest }: { value: string; onChange: (v: string) => void } & Omit<ComponentProps<typeof Input>, "value" | "onChange">) {
  const register = useTokenTarget(onChange);
  return <Input {...rest} value={value} onChange={(e) => onChange(e.target.value)} onFocus={register} />;
}

export function TokenTextarea({ value, onChange, ...rest }: { value: string; onChange: (v: string) => void } & Omit<ComponentProps<typeof Textarea>, "value" | "onChange">) {
  const register = useTokenTarget(onChange);
  return <Textarea {...rest} value={value} onChange={(e) => onChange(e.target.value)} onFocus={register} />;
}

/** Chips that insert {{token}} at the caret of the last focused field. */
export function VariablePicker({ variables, required, disabled }: { variables: PlatformTemplateVariable[]; required: string[]; disabled?: boolean }) {
  const ctx = useContext(TokenContext);
  const insert = (key: string) => {
    const target = ctx?.current.current;
    const token = `{{${key}}}`;
    if (!target || !target.el.isConnected) {
      toast.info("Click into a text field first, then pick a variable");
      return;
    }
    const { el } = target;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    target.set(el.value.slice(0, start) + token + el.value.slice(end));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {variables.map((v) => (
        <Tooltip key={v.key} content={`${v.label} — e.g. ${v.sample}${required.includes(v.key) ? " (required)" : ""}`}>
          <button
            type="button"
            disabled={disabled}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => insert(v.key)}
            className={cn(
              "inline-flex h-6 items-center gap-1 rounded-md border px-1.5 font-mono text-2xs transition-colors disabled:opacity-50",
              required.includes(v.key) ? "border-accent/40 bg-accent/10 text-accent-ink hover:bg-accent/15" : "border-line bg-well text-text-2 hover:bg-hover hover:text-text",
            )}
          >
            {`{{${v.key}}}`}
            {required.includes(v.key) && <span aria-hidden className="size-1.5 rounded-full bg-accent" />}
          </button>
        </Tooltip>
      ))}
    </div>
  );
}

// ─── Blocks ─────────────────────────────────────────────────────────────────

const ICONS: Partial<Record<EmailBlockType, LucideIcon>> = {
  heading: Heading,
  text: Type,
  button: MousePointerClick,
  image: ImageIcon,
  divider: Minus,
  spacer: MoveVertical,
};

const makeId = () => `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** A new block suited to system email: no contact tokens, the action link pre-filled when the template has one. */
export function starterBlock(type: EmailBlockType, hasActionUrl: boolean): EmailBlock {
  const b = newBlock(type, makeId());
  if (b.type === "heading") return { ...b, text: "A clear headline" };
  if (b.type === "text") return { ...b, text: "Hi {{name|there}},\n\nWrite the message here. Use **bold**, *italic* and [links](https://example.com)." };
  if (b.type === "button") return { ...b, label: "Open", url: hasActionUrl ? "{{action_url}}" : "https://", align: "left" };
  return b;
}

type Align = "left" | "center" | "right";

function AlignControl({ value, onChange, disabled }: { value: Align; onChange: (v: Align) => void; disabled?: boolean }) {
  const opts: { v: Align; icon: ReactNode; label: string }[] = [
    { v: "left", icon: <AlignLeft />, label: "Left" },
    { v: "center", icon: <AlignCenter />, label: "Centre" },
    { v: "right", icon: <AlignRight />, label: "Right" },
  ];
  return (
    <div role="radiogroup" aria-label="Alignment" className="inline-flex h-8 overflow-hidden rounded-md border border-line-strong bg-ctl-face">
      {opts.map((o) => (
        <button
          key={o.v}
          type="button"
          role="radio"
          aria-checked={value === o.v}
          aria-label={o.label}
          title={o.label}
          disabled={disabled}
          onClick={() => onChange(o.v)}
          className={cn("flex w-8 items-center justify-center text-text-3 [&_svg]:size-3.5", value === o.v ? "bg-accent/12 text-accent-ink" : "hover:bg-ctl-hover hover:text-text")}
        >
          {o.icon}
        </button>
      ))}
    </div>
  );
}

function BlockFields({ block, set, disabled }: { block: EmailBlock; set: (b: EmailBlock) => void; disabled?: boolean }) {
  switch (block.type) {
    case "heading":
      return (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <Field label="Heading" className="flex-1">
            <TokenInput value={block.text} onChange={(text) => set({ ...block, text })} maxLength={300} disabled={disabled} />
          </Field>
          <div className="flex gap-2">
            <NativeSelect
              aria-label="Size"
              value={String(block.level)}
              onChange={(e) => set({ ...block, level: e.target.value === "2" ? 2 : 1 })}
              options={[
                { value: "1", label: "Large" },
                { value: "2", label: "Small" },
              ]}
              disabled={disabled}
              className="w-24"
            />
            <AlignControl value={block.align} onChange={(align) => set({ ...block, align })} disabled={disabled} />
          </div>
        </div>
      );
    case "text":
      return (
        <div className="flex flex-col gap-1.5">
          <TokenTextarea aria-label="Text" rows={Math.min(10, Math.max(3, block.text.split("\n").length + 1))} value={block.text} onChange={(text) => set({ ...block, text })} maxLength={10_000} disabled={disabled} />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-2xs text-text-3">**bold** · *italic* · [label](https://…) · blank line = new paragraph · {"{{name|there}}"} = fallback</span>
            <AlignControl value={block.align} onChange={(align) => set({ ...block, align })} disabled={disabled} />
          </div>
        </div>
      );
    case "button":
      return (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Field label="Label">
            <TokenInput value={block.label} onChange={(label) => set({ ...block, label })} maxLength={80} disabled={disabled} />
          </Field>
          <Field label="Link">
            <TokenInput value={block.url} onChange={(url) => set({ ...block, url })} placeholder="{{action_url}}" className="font-mono text-xs" disabled={disabled} />
          </Field>
          <div className="flex items-center gap-2 sm:col-span-2">
            <AlignControl value={block.align} onChange={(align) => set({ ...block, align })} disabled={disabled} />
            <label className="flex items-center gap-1.5 text-xs text-text-2">
              <input type="color" value={block.color ?? "#0071e3"} onChange={(e) => set({ ...block, color: e.target.value })} disabled={disabled} className="h-7 w-9 cursor-pointer rounded border border-line bg-transparent" />
              {block.color ? "Custom colour" : "Brand colour"}
            </label>
            {block.color && (
              <Button size="sm" variant="ghost" onClick={() => set({ ...block, color: undefined })} disabled={disabled}>
                Use brand colour
              </Button>
            )}
          </div>
        </div>
      );
    case "image":
      return (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Field label="Image URL" className="sm:col-span-2">
            <TokenInput value={block.src} onChange={(src) => set({ ...block, src })} placeholder="https://…" className="font-mono text-xs" disabled={disabled} />
          </Field>
          <Field label="Description (alt text)">
            <TokenInput value={block.alt} onChange={(alt) => set({ ...block, alt })} maxLength={300} disabled={disabled} />
          </Field>
          <Field label="Link (optional)">
            <TokenInput value={block.href ?? ""} onChange={(href) => set({ ...block, href: href || undefined })} placeholder="https://…" className="font-mono text-xs" disabled={disabled} />
          </Field>
          <Field label={`Width ${block.width}%`} className="sm:col-span-2">
            <input type="range" min={10} max={100} step={5} value={block.width} onChange={(e) => set({ ...block, width: Number(e.target.value) })} disabled={disabled} className="w-full accent-[var(--color-accent)]" />
          </Field>
        </div>
      );
    case "divider":
      return <div className="border-t border-line-strong" aria-hidden />;
    case "spacer":
      return (
        <Field label={`Height ${block.height}px`}>
          <input type="range" min={4} max={120} step={4} value={block.height} onChange={(e) => set({ ...block, height: Number(e.target.value) })} disabled={disabled} className="w-full accent-[var(--color-accent)]" />
        </Field>
      );
    default:
      // The workspace designer's richer blocks (hero, columns…) are not offered for system email.
      return <p className="text-xs text-text-3">This block can only be edited in the workspace email designer.</p>;
  }
}

export function BlockEditor({ blocks, onChange, hasActionUrl, disabled }: { blocks: EmailBlock[]; onChange: (b: EmailBlock[]) => void; hasActionUrl: boolean; disabled?: boolean }) {
  const label = (t: EmailBlockType) => EMAIL_BLOCK_TYPES.find((x) => x.type === t)?.label ?? t;
  const update = (i: number, b: EmailBlock) => onChange(blocks.map((x, j) => (j === i ? b : x)));
  const move = (i: number, d: -1 | 1) => {
    const next = [...blocks];
    const [b] = next.splice(i, 1);
    next.splice(i + d, 0, b!);
    onChange(next);
  };
  return (
    <div className="flex flex-col gap-2">
      {blocks.map((b, i) => {
        const Icon = ICONS[b.type] ?? Square;
        return (
          <div key={b.id} className="rounded-lg border border-line bg-panel">
            <div className="flex items-center justify-between gap-2 border-b border-line px-2.5 py-1">
              <span className="flex items-center gap-1.5 text-xs font-medium text-text-2">
                <Icon aria-hidden className="size-3.5 text-text-3" />
                {label(b.type)}
              </span>
              {!disabled && (
                <span className="flex items-center">
                  <IconButton size="sm" label="Move up" icon={<ArrowUp />} disabled={i === 0} onClick={() => move(i, -1)} />
                  <IconButton size="sm" label="Move down" icon={<ArrowDown />} disabled={i === blocks.length - 1} onClick={() => move(i, 1)} />
                  <IconButton size="sm" label="Duplicate" icon={<Copy />} onClick={() => onChange([...blocks.slice(0, i + 1), { ...b, id: makeId() }, ...blocks.slice(i + 1)])} />
                  <IconButton size="sm" variant="danger" label="Remove block" icon={<Trash2 />} disabled={blocks.length === 1} onClick={() => onChange(blocks.filter((_, j) => j !== i))} />
                </span>
              )}
            </div>
            <div className="p-2.5">
              <BlockFields block={b} set={(nb) => update(i, nb)} disabled={disabled} />
            </div>
          </div>
        );
      })}
      {!disabled && (
        <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-dashed border-line-strong px-2.5 py-2">
          <span className="mr-1 text-xs text-text-3">Add</span>
          {EMAIL_BLOCK_TYPES.map(({ type, label: l }) => {
            const Icon = ICONS[type] ?? Square;
            return (
              <Button key={type} size="sm" variant="ghost" icon={<Icon />} onClick={() => onChange([...blocks, starterBlock(type, hasActionUrl)])} disabled={blocks.length >= 100}>
                {l}
              </Button>
            );
          })}
        </div>
      )}
    </div>
  );
}
