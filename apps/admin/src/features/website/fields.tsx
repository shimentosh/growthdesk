"use client";

import { useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ImageOff, ImagePlus, Images, Plus, Trash2, X } from "lucide-react";
import { SITE_ASSET_MAX_BYTES, type SiteCta } from "@growthdesk/shared";
import { Button, IconButton } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Checkbox } from "@/components/ui/Checkbox";
import { Field } from "@/components/ui/Field";
import { Input, Textarea } from "@/components/ui/Input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/Popover";
import { toast } from "@/components/ui/Toast";
import { api, messageOf } from "@/lib/api";
import { cn } from "@/lib/cn";
import { formatBytes } from "@/lib/format";
import { useApiQuery, useInvalidate } from "@/lib/query";
import { usePlatform } from "@/features/common/platform";
import { SITE_ASSETS_KEY, type SiteAsset } from "./editor";

/* Form pieces shared by the Website pages. */

/** A titled card around one block of the content. */
export function EditorCard({ title, description, icon, actions, children, className }: { title: ReactNode; description?: ReactNode; icon?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <Card className={className}>
      <CardHeader icon={icon} title={title} description={description} actions={actions} />
      <CardBody className="flex flex-col gap-4">{children}</CardBody>
    </Card>
  );
}

/** A labelled text input (or textarea) with a character counter when it has a limit. */
export function TextField({
  label,
  value,
  onChange,
  error,
  hint,
  max,
  rows,
  placeholder,
  required,
  mono,
  className,
  type,
}: {
  label: ReactNode;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  hint?: ReactNode;
  max?: number;
  /** Renders a textarea with this many rows. */
  rows?: number;
  placeholder?: string;
  required?: boolean;
  mono?: boolean;
  className?: string;
  type?: string;
}) {
  const { canChange } = usePlatform();
  const over = max !== undefined && value.length > max;
  const counter =
    max !== undefined ? (
      <span className={cn("text-2xs tabular-nums", over ? "font-semibold text-bad-ink" : value.length > max * 0.9 ? "text-warn-ink" : "text-text-3")}>
        {value.length}/{max}
      </span>
    ) : undefined;
  return (
    <Field label={label} error={error} hint={hint} required={required} labelAction={counter} className={className}>
      {rows ? (
        <Textarea rows={rows} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} disabled={!canChange} invalid={Boolean(error)} className={mono ? "font-mono text-xs leading-5" : undefined} />
      ) : (
        <Input type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} disabled={!canChange} invalid={Boolean(error)} className={mono ? "font-mono" : undefined} />
      )}
    </Field>
  );
}

/** A button's label and link. */
export function CtaFields({ value, onChange, errors, prefix, label }: { value: SiteCta; onChange: (v: SiteCta) => void; errors: Record<string, string>; prefix: string; label: string }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1.3fr]">
      <TextField label={`${label} label`} value={value.label} onChange={(v) => onChange({ ...value, label: v })} error={errors[`${prefix}.label`]} max={40} required />
      <TextField
        label="Link"
        value={value.href}
        onChange={(v) => onChange({ ...value, href: v })}
        error={errors[`${prefix}.href`]}
        placeholder="/register"
        hint="A path such as /register or #faq, or a full https:// link."
        mono
        required
      />
    </div>
  );
}

/** An optional second button: a checkbox that adds or removes it. */
export function OptionalCta({ value, onChange, errors, prefix, fallback }: { value: SiteCta | null; onChange: (v: SiteCta | null) => void; errors: Record<string, string>; prefix: string; fallback: SiteCta }) {
  const { canChange } = usePlatform();
  return (
    <div className="flex flex-col gap-3">
      <Checkbox checked={value !== null} disabled={!canChange} onCheckedChange={(on) => onChange(on ? fallback : null)} label="Show a second button" />
      {value && <CtaFields value={value} onChange={onChange} errors={errors} prefix={prefix} label="Second button" />}
    </div>
  );
}

/**
 * A list with add / remove / move up / move down. `render` draws one item's
 * fields; the item number and controls are drawn here.
 */
export function ListEditor<T>({
  items,
  onChange,
  max,
  make,
  render,
  noun,
  empty,
  error,
}: {
  items: T[];
  onChange: (items: T[]) => void;
  max: number;
  make: () => T;
  render: (item: T, set: (next: T) => void, index: number) => ReactNode;
  noun: string;
  empty?: ReactNode;
  error?: string;
}) {
  const { canChange } = usePlatform();
  const move = (from: number, to: number) => {
    const next = [...items];
    const [it] = next.splice(from, 1);
    next.splice(to, 0, it as T);
    onChange(next);
  };
  return (
    <div className="flex flex-col gap-3">
      {items.length === 0 && empty && <div className="rounded-md border border-dashed border-line-strong px-4 py-5 text-center text-xs text-text-3">{empty}</div>}
      {items.map((item, i) => (
        <div key={i} className="rounded-lg border border-line bg-bg p-3">
          <div className="mb-3 flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-text-2">
              {noun} {i + 1}
            </span>
            {canChange && (
              <div className="flex items-center gap-0.5">
                <IconButton size="sm" label="Move up" icon={<ArrowUp />} disabled={i === 0} onClick={() => move(i, i - 1)} />
                <IconButton size="sm" label="Move down" icon={<ArrowDown />} disabled={i === items.length - 1} onClick={() => move(i, i + 1)} />
                <IconButton size="sm" label={`Remove ${noun.toLowerCase()}`} variant="danger" icon={<Trash2 />} onClick={() => onChange(items.filter((_, j) => j !== i))} />
              </div>
            )}
          </div>
          <div className="flex flex-col gap-3">{render(item, (next) => onChange(items.map((x, j) => (j === i ? next : x))), i)}</div>
        </div>
      ))}
      {error && <p className="text-xs text-bad-ink">{error}</p>}
      {canChange && (
        <div className="flex items-center gap-3">
          <Button size="sm" icon={<Plus />} disabled={items.length >= max} onClick={() => onChange([...items, make()])}>
            Add {noun.toLowerCase()}
          </Button>
          <span className="text-2xs text-text-3">
            {items.length} of {max}
          </span>
        </div>
      )}
    </div>
  );
}

// ─── Images ──────────────────────────────────────────────────────────────────

const ACCEPT: Record<SiteAsset["kind"], { mimes: string[]; label: string }> = {
  logo: { mimes: ["image/png", "image/jpeg", "image/webp"], label: "PNG, JPEG or WebP" },
  favicon: { mimes: ["image/png", "image/x-icon", "image/vnd.microsoft.icon"], label: "PNG or ICO" },
  og: { mimes: ["image/png", "image/jpeg"], label: "PNG or JPEG, ideally 1200×630" },
};

const readAsDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error("The file could not be read"));
    r.readAsDataURL(file);
  });

export function useSiteAssets() {
  return useApiQuery<SiteAsset[]>(SITE_ASSETS_KEY, "/admin/site/assets");
}

/**
 * Pick an image for a slot: upload a new one (checked here for size and type,
 * and again by the API from the file's bytes — SVG is never accepted), choose
 * one uploaded before, or clear it.
 */
export function ImageField({
  kind,
  label,
  hint,
  value,
  onChange,
  error,
  previewClass,
}: {
  kind: SiteAsset["kind"];
  label: string;
  hint?: ReactNode;
  value: string | null;
  onChange: (id: string | null) => void;
  error?: string;
  previewClass?: string;
}) {
  const { canChange } = usePlatform();
  const assets = useSiteAssets();
  const invalidate = useInvalidate();
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const current = assets.data?.find((a) => a.id === value) ?? null;
  const previous = (assets.data ?? []).filter((a) => a.kind === kind);
  const accept = ACCEPT[kind];

  const upload = async (file: File) => {
    setProblem(null);
    if (/svg/i.test(file.type) || /\.svg$/i.test(file.name)) return setProblem("SVG files are not accepted — export a PNG instead.");
    if (file.size > SITE_ASSET_MAX_BYTES) return setProblem(`That file is ${formatBytes(file.size)}; the limit is 256 KB.`);
    if (file.type && !accept.mimes.includes(file.type)) return setProblem(`Use ${accept.label}.`);
    setUploading(true);
    try {
      const data = await readAsDataUrl(file);
      const asset = await api<SiteAsset>("/admin/site/assets", { method: "POST", body: { kind, mime: file.type || undefined, data } });
      await invalidate(SITE_ASSETS_KEY);
      onChange(asset.id);
      toast.success("Image uploaded");
    } catch (e) {
      setProblem(messageOf(e));
    } finally {
      setUploading(false);
    }
  };

  return (
    <Field label={label} error={problem ?? error} hint={hint ?? `${accept.label}, up to 256 KB.`}>
      <div className="flex flex-wrap items-center gap-3">
        <div className={cn("grid shrink-0 place-items-center overflow-hidden rounded-md border border-line bg-[repeating-conic-gradient(var(--s-3)_0%_25%,transparent_0%_50%)] bg-[length:12px_12px]", previewClass ?? "size-16")}>
          {current ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={current.url} alt="" className="max-h-full max-w-full object-contain" />
          ) : value ? (
            <span className="text-2xs text-text-3">Loading…</span>
          ) : (
            <ImageOff className="size-5 text-text-3" aria-hidden />
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          {current && (
            <span className="truncate text-xs text-text-3">
              {current.mime.replace("image/", "").toUpperCase()} · {formatBytes(current.size)}
            </span>
          )}
          {canChange && (
            <div className="flex flex-wrap items-center gap-1.5">
              <input
                ref={input}
                type="file"
                hidden
                accept={accept.mimes.join(",")}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) void upload(file);
                }}
              />
              <Button size="sm" icon={<ImagePlus />} loading={uploading} onClick={() => input.current?.click()}>
                Upload
              </Button>
              <Popover>
                <PopoverTrigger asChild>
                  <Button size="sm" variant="ghost" icon={<Images />} disabled={previous.length === 0}>
                    Previous uploads
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-[300px] p-2">
                  <div className="grid max-h-64 grid-cols-4 gap-1.5 overflow-y-auto">
                    {previous.map((a) => (
                      <button
                        key={a.id}
                        type="button"
                        title={`${a.mime} · ${formatBytes(a.size)}`}
                        onClick={() => onChange(a.id)}
                        className={cn(
                          "grid aspect-square place-items-center overflow-hidden rounded-sm border bg-bg p-1 hover:border-accent",
                          a.id === value ? "border-accent ring-2 ring-accent-ring" : "border-line",
                        )}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={a.url} alt="" className="max-h-full max-w-full object-contain" />
                      </button>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>
              {value && (
                <Button size="sm" variant="ghost" icon={<X />} onClick={() => onChange(null)}>
                  Remove
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </Field>
  );
}

/** A row of mutually exclusive choices (tone, audience, provider). */
export function Segmented<V extends string>({
  label,
  value,
  onChange,
  options,
  hint,
}: {
  label: ReactNode;
  value: V;
  onChange: (v: V) => void;
  options: { value: V; label: ReactNode; icon?: ReactNode }[];
  hint?: ReactNode;
}) {
  const { canChange } = usePlatform();
  return (
    <Field label={label} hint={hint}>
      <div role="radiogroup" className="inline-flex w-fit max-w-full flex-wrap gap-0.5 rounded-sm border border-line-strong bg-ctl p-0.5">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={value === o.value}
            disabled={!canChange}
            onClick={() => onChange(o.value)}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-xs px-2.5 text-xs font-medium transition-colors disabled:cursor-not-allowed [&_svg]:size-3.5",
              value === o.value ? "bg-ctl-face text-text-hi shadow-sm" : "text-text-3 hover:text-text",
            )}
          >
            {o.icon}
            {o.label}
          </button>
        ))}
      </div>
    </Field>
  );
}
