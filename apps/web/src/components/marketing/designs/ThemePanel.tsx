"use client";

import { useState } from "react";
import { ChevronRight, Palette, RotateCcw } from "lucide-react";
import { DEFAULT_EMAIL_THEME, EMAIL_FONTS, resolveTheme, type EmailFont, type EmailTheme } from "@growthdesk/shared";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { NativeSelect } from "@/components/ui/Input";
import { ColorField, Slider } from "@/components/marketing/designs/controls";
import { cn } from "@/lib/cn";

/*
 * The email's theme: one-click palettes, then every colour, the fonts and the
 * corner radii. A theme only stores what differs from the defaults ({} is the
 * default look), so "Reset to default" is just {}.
 */

type ThemeKey = keyof EmailTheme;
type ColourKey = Exclude<ThemeKey, "font" | "headingFont" | "radius" | "buttonRadius">;

/** One-click palettes. "Default" is the empty theme; "No theme" reads like a plain email typed in a mail app. */
export const THEME_PRESETS: { id: string; label: string; theme: EmailTheme }[] = [
  {
    id: "plain",
    label: "No theme",
    theme: {
      background: "#ffffff",
      surface: "#ffffff",
      text: "#222222",
      heading: "#222222",
      muted: "#777777",
      accent: "#1a73e8",
      accentText: "#ffffff",
      tint: "#ffffff",
      font: "helvetica",
      headingFont: "helvetica",
      radius: 0,
      buttonRadius: 4,
    },
  },
  { id: "default", label: "Default", theme: {} },
  {
    id: "editorial",
    label: "Editorial",
    theme: {
      background: "#f4f1ea",
      surface: "#fffdf8",
      text: "#2b2b2b",
      heading: "#111111",
      muted: "#6b6b6b",
      accent: "#111111",
      accentText: "#ffffff",
      tint: "#ece6d9",
      font: "georgia",
      headingFont: "georgia",
      radius: 0,
      buttonRadius: 0,
    },
  },
  {
    id: "forest",
    label: "Forest",
    theme: {
      background: "#eef3ee",
      surface: "#ffffff",
      text: "#1f2a24",
      heading: "#14532d",
      muted: "#5f6f66",
      accent: "#15803d",
      accentText: "#ffffff",
      tint: "#dcfce7",
      font: "helvetica",
      headingFont: "georgia",
      radius: 12,
      buttonRadius: 6,
    },
  },
  {
    id: "ocean",
    label: "Ocean",
    theme: {
      background: "#e8f4fb",
      surface: "#ffffff",
      text: "#17324d",
      heading: "#0b2540",
      muted: "#5b7287",
      accent: "#0284c7",
      accentText: "#ffffff",
      tint: "#e0f2fe",
      font: "verdana",
      headingFont: "helvetica",
      radius: 14,
      buttonRadius: 24,
    },
  },
  {
    id: "sunset",
    label: "Sunset",
    theme: {
      background: "#fff7ed",
      surface: "#ffffff",
      text: "#3b2a20",
      heading: "#7c2d12",
      muted: "#8a6f5f",
      accent: "#ea580c",
      accentText: "#ffffff",
      tint: "#ffedd5",
      font: "trebuchet",
      headingFont: "trebuchet",
      radius: 20,
      buttonRadius: 40,
    },
  },
  {
    id: "midnight",
    label: "Midnight",
    theme: {
      background: "#0b1020",
      surface: "#111827",
      text: "#d1d5db",
      heading: "#f9fafb",
      muted: "#9ca3af",
      accent: "#818cf8",
      accentText: "#0b1020",
      tint: "#1e1b4b",
      font: "system",
      headingFont: "system",
      radius: 16,
      buttonRadius: 10,
    },
  },
];

const COLOURS: { key: ColourKey; label: string; hint: string }[] = [
  { key: "background", label: "Page", hint: "Behind the email" },
  { key: "surface", label: "Email", hint: "The email's card" },
  { key: "heading", label: "Headings", hint: "Titles and quotes" },
  { key: "text", label: "Text", hint: "Paragraphs and lists" },
  { key: "muted", label: "Muted", hint: "Footer and captions" },
  { key: "accent", label: "Accent", hint: "Buttons and links" },
  { key: "accentText", label: "On accent", hint: "Button text" },
  { key: "tint", label: "Tint", hint: "Hero and callout bands" },
];

const FONT_LABEL: Record<EmailFont, string> = {
  system: "System (sans-serif)",
  helvetica: "Helvetica / Arial",
  georgia: "Georgia (serif)",
  verdana: "Verdana",
  trebuchet: "Trebuchet",
  mono: "Monospace",
};
const FONT_OPTIONS = (Object.keys(EMAIL_FONTS) as EmailFont[]).map((f) => ({ value: f, label: FONT_LABEL[f] }));

/** The theme with unset keys dropped and keys in one order, so an unchanged theme compares equal to what was saved. */
export function cleanTheme(theme: EmailTheme): EmailTheme {
  return Object.fromEntries(
    Object.entries(theme)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)),
  ) as EmailTheme;
}

const sameLook = (a: EmailTheme, b: EmailTheme) => JSON.stringify(resolveTheme(a)) === JSON.stringify(resolveTheme(b));

export function ThemePanel({ theme, onChange, disabled, className }: { theme: EmailTheme; onChange: (theme: EmailTheme) => void; disabled?: boolean; className?: string }) {
  const [open, setOpen] = useState(false);
  const t = resolveTheme(theme);
  const isDefault = Object.keys(cleanTheme(theme)).length === 0;
  const set = <K extends ThemeKey>(key: K, value: EmailTheme[K] | undefined) => onChange(cleanTheme({ ...theme, [key]: value }));
  const preset = THEME_PRESETS.find((p) => sameLook(p.theme, theme));

  return (
    <Card className={className}>
      <CardHeader
        icon={<Palette />}
        title="Theme"
        description={
          preset?.id === "plain"
            ? "No theme: a plain white email, like one typed in a mail app."
            : preset
              ? `${preset.label} palette. Colours, fonts and corners for the whole email.`
              : "Custom palette. Colours, fonts and corners for the whole email."
        }
        actions={
          !disabled ? (
            <Button size="sm" variant="ghost" icon={<RotateCcw />} disabled={isDefault} onClick={() => onChange({})}>
              Reset to default
            </Button>
          ) : undefined
        }
      />
      <CardBody className="flex flex-col gap-3">
        <div role="radiogroup" aria-label="Theme presets" className="grid grid-cols-[repeat(auto-fill,minmax(88px,1fr))] gap-2">
          {THEME_PRESETS.map((p) => (
            <PresetSwatch key={p.id} label={p.label} theme={p.theme} selected={preset?.id === p.id} disabled={disabled} onClick={() => onChange(cleanTheme(p.theme))} />
          ))}
        </div>

        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="-mx-1 inline-flex items-center gap-1 self-start rounded-sm px-1 py-0.5 text-xs font-medium text-text-2 hover:text-text"
        >
          <ChevronRight aria-hidden className={cn("size-3.5 transition-transform", open && "rotate-90")} />
          {disabled ? "Theme details" : "Customise colours, fonts and corners"}
        </button>

        {open && (
          <fieldset disabled={disabled} className="flex min-w-0 flex-col gap-4">
            <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
              {COLOURS.map((c) => (
                <Field key={c.key} label={`${c.label} · ${c.hint}`}>
                  <ColorField label={`${c.label} colour`} value={theme[c.key]} fallback={DEFAULT_EMAIL_THEME[c.key]} disabled={disabled} onChange={(v) => set(c.key, v)} />
                </Field>
              ))}
            </div>
            <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
              <Field label="Body font">
                <NativeSelect value={t.font} disabled={disabled} onChange={(e) => set("font", e.target.value as EmailFont)} options={FONT_OPTIONS} />
              </Field>
              <Field label="Heading font">
                <NativeSelect value={t.headingFont} disabled={disabled} onChange={(e) => set("headingFont", e.target.value as EmailFont)} options={FONT_OPTIONS} />
              </Field>
              <Field label="Email corners">
                <Slider value={t.radius} min={0} max={32} step={2} unit="px" label="Email corner radius" disabled={disabled} onChange={(v) => set("radius", v)} />
              </Field>
              <Field label="Button corners">
                <Slider value={t.buttonRadius} min={0} max={40} step={2} unit="px" label="Button corner radius" disabled={disabled} onChange={(v) => set("buttonRadius", v)} />
              </Field>
            </div>
            <p className="text-xs text-text-3">Inboxes without these fonts fall back to a similar one. A block&apos;s own colour wins over the theme.</p>
          </fieldset>
        )}
      </CardBody>
    </Card>
  );
}

/** A tiny email in the preset's colours: page, card, a heading line, text lines and a button. */
function PresetSwatch({ label, theme, selected, disabled, onClick }: { label: string; theme: EmailTheme; selected: boolean; disabled?: boolean; onClick: () => void }) {
  const t = resolveTheme(theme);
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex min-w-0 flex-col gap-1.5 rounded-md border p-1.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
        selected ? "border-accent bg-accent-soft" : "border-line hover:bg-hover",
      )}
    >
      <span aria-hidden className="block rounded-sm border border-line p-1.5" style={{ background: t.background }}>
        <span className="flex flex-col gap-1 p-1.5" style={{ background: t.surface, borderRadius: Math.min(t.radius, 8) / 2 }}>
          <span className="block h-1.5 w-3/4 rounded-full" style={{ background: t.heading }} />
          <span className="block h-1 w-full rounded-full opacity-60" style={{ background: t.text }} />
          <span className="block h-1 w-2/3 rounded-full opacity-60" style={{ background: t.text }} />
          <span className="mt-0.5 block h-2 w-1/2" style={{ background: t.accent, borderRadius: Math.min(t.buttonRadius, 8) / 2 }} />
        </span>
      </span>
      <span className="truncate px-0.5 text-xs font-medium text-text">{label}</span>
    </button>
  );
}
