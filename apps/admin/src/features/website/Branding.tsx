"use client";

import { Fingerprint, Image as ImageIcon, Mail, Palette, TrendingUp } from "lucide-react";
import { HEX_COLOR } from "@growthdesk/shared";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { QueryState } from "@/components/ui/ErrorState";
import { Field } from "@/components/ui/Field";
import { IconTile } from "@/components/ui/IconTile";
import { Input } from "@/components/ui/Input";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { SkeletonText } from "@/components/ui/Skeleton";
import { cn } from "@/lib/cn";
import { usePlatform } from "@/features/common/platform";
import { DraftBar, ReadOnlyNote, useSiteEditor, WebsiteTile } from "./editor";
import { EditorCard, ImageField, TextField, useSiteAssets } from "./fields";

/*
 * /website/branding — the product's public identity (the `branding` key):
 * name, support address, accent colour, logo, favicon and default share
 * image. The API's BrandingService reads the published copy for email
 * footers, page titles and the maintenance notice.
 */

/** The design system's blue, used when no colour is set. */
const DEFAULT_ACCENT = "#0071e3";

function luminance(hex: string) {
  const ch = (i: number) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(1) + 0.7152 * ch(3) + 0.0722 * ch(5);
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};
/** Matches apps/web/src/lib/site.ts accentCss(): black text on light accents. */
const onAccent = (hex: string) => (luminance(hex) > 0.45 ? "#000000" : "#ffffff");

function ContrastRow({ label, fg, bg, large }: { label: string; fg: string; bg: string; large?: boolean }) {
  const ratio = contrast(fg, bg);
  const pass = ratio >= (large ? 3 : 4.5);
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <div className="flex min-w-0 items-center gap-2">
        <span className="grid size-6 shrink-0 place-items-center rounded-xs border border-line text-2xs font-bold" style={{ background: bg, color: fg }}>
          Aa
        </span>
        <span className="truncate text-xs text-text-2">{label}</span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span className="text-xs font-semibold text-text-hi tabular-nums">{(Math.floor(ratio * 10) / 10).toFixed(1)}:1</span>
        <Badge tone={pass ? "ok" : "bad"} quiet>
          {pass ? "Passes" : "Low"}
        </Badge>
      </div>
    </div>
  );
}

function ColorField({ value, onChange, error }: { value: string; onChange: (v: string) => void; error?: string }) {
  const { canChange } = usePlatform();
  const effective = HEX_COLOR.test(value) ? value : DEFAULT_ACCENT;
  return (
    <Field label="Accent colour" error={error} hint="Buttons, links and focus rings on the customer site. Empty: the default blue.">
      <div className="flex flex-wrap items-center gap-2">
        <label className={cn("relative size-9 shrink-0 overflow-hidden rounded-sm border border-line-strong shadow-sm", canChange && "cursor-pointer")} style={{ background: effective }}>
          <span className="sr-only">Pick a colour</span>
          <input type="color" value={effective} disabled={!canChange} onChange={(e) => onChange(e.target.value)} className="absolute inset-0 size-full cursor-pointer opacity-0" />
        </label>
        <Input value={value} onChange={(e) => onChange(e.target.value.trim())} placeholder={DEFAULT_ACCENT} disabled={!canChange} invalid={Boolean(error)} className="w-32 font-mono" maxLength={7} />
        {value && canChange && (
          <Button size="sm" variant="ghost" onClick={() => onChange("")}>
            Use default
          </Button>
        )}
      </div>
    </Field>
  );
}

function Preview({ name, supportEmail, color, logoUrl }: { name: string; supportEmail: string; color: string; logoUrl: string | null }) {
  const accent = HEX_COLOR.test(color) ? color : DEFAULT_ACCENT;
  const ink = onAccent(accent);
  const brand = logoUrl ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={logoUrl} alt="" className="h-9 w-auto max-w-[160px] object-contain" />
  ) : (
    <IconTile icon={<TrendingUp />} tint="blue" size="lg" />
  );
  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="mb-2 text-2xs font-semibold tracking-wide text-text-3 uppercase">Sign-in page</div>
        <Card className="overflow-hidden">
          <div className="flex flex-col items-center gap-2 bg-bg-deep px-5 pt-6 pb-5">
            {brand}
            <div className="text-xs font-semibold text-text-2">{name || "—"}</div>
            <div className="mt-2 w-full max-w-[250px] rounded-lg border border-line bg-panel p-4 shadow-card">
              <div className="text-center text-sm font-semibold text-text-hi">Sign in</div>
              <div className="mt-3 h-7 rounded-sm border border-line bg-field" />
              <div className="mt-2 h-7 rounded-sm border border-line bg-field" />
              <div className="mt-3 grid h-8 place-items-center rounded-sm text-xs font-semibold shadow-sm" style={{ background: accent, color: ink }}>
                Continue
              </div>
              <div className="mt-2 text-center text-2xs" style={{ color: accent }}>
                Forgot password?
              </div>
            </div>
          </div>
        </Card>
      </div>
      <div>
        <div className="mb-2 text-2xs font-semibold tracking-wide text-text-3 uppercase">Email footer</div>
        <Card className="p-4">
          <div className="text-sm font-semibold text-text-hi">Confirm your email</div>
          <div className="mt-2 h-2 w-11/12 rounded-full bg-s-4" />
          <div className="mt-1.5 h-2 w-2/3 rounded-full bg-s-4" />
          <div className="mt-3 inline-grid h-7 place-items-center rounded-sm px-3 text-2xs font-semibold" style={{ background: accent, color: ink }}>
            Confirm email
          </div>
          <div className="mt-4 border-t border-line pt-3 text-2xs text-text-3">
            {name || "—"}
            {supportEmail && <> · Questions? {supportEmail}</>}
          </div>
        </Card>
      </div>
      <div>
        <div className="mb-2 text-2xs font-semibold tracking-wide text-text-3 uppercase">Contrast</div>
        <Card className="divide-y divide-line px-3 py-1">
          <ContrastRow label="Button text on the accent" fg={ink} bg={accent} />
          <ContrastRow label="Links on a light page" fg={accent} bg="#ffffff" />
          <ContrastRow label="Accent on a dark page" fg={accent} bg="#1c1c1e" large />
        </Card>
        <p className="mt-2 text-2xs text-text-3">WCAG AA: 4.5:1 for text, 3:1 for large text and controls. In dark mode, links are mixed toward the text colour automatically.</p>
      </div>
    </div>
  );
}

/** /website/branding */
export function WebsiteBranding({ appUrl }: { appUrl: string | null }) {
  const ed = useSiteEditor("branding");
  const assets = useSiteAssets();
  const urlOf = (id: string | null) => (id ? (assets.data?.find((a) => a.id === id)?.url ?? null) : null);
  return (
    <Page width="capped">
      <PageHeader icon={<WebsiteTile icon={<Fingerprint />} />} title="Branding" description="The product's name, colour and images on the customer site and in system email." />
      <DraftBar editors={[ed]} appUrl={appUrl} />
      <ReadOnlyNote />
      <QueryState query={ed.query} loading={<SkeletonText lines={12} />}>
        {() => {
          const b = ed.value!;
          const e = ed.errors;
          return (
            <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
              <div className="flex min-w-0 flex-col gap-4">
                <EditorCard icon={<Fingerprint />} title="Identity" description="Shown in page titles, the sign-in pages, email footers and the maintenance notice.">
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <TextField label="Product name" value={b.productName} onChange={(v) => ed.update((d) => void (d.productName = v))} error={e.productName} max={60} required />
                    <TextField
                      label="Support email"
                      type="email"
                      value={b.supportEmail}
                      onChange={(v) => ed.update((d) => void (d.supportEmail = v.trim()))}
                      error={e.supportEmail}
                      placeholder="support@example.com"
                      hint="Shown in the site footer and email footers. Empty: none."
                    />
                  </div>
                </EditorCard>
                <EditorCard icon={<Palette />} title="Colour">
                  <ColorField value={b.primaryColor} onChange={(v) => ed.update((d) => void (d.primaryColor = v))} error={e.primaryColor} />
                </EditorCard>
                <EditorCard icon={<ImageIcon />} title="Images" description="Uploads are checked by their contents: PNG, JPEG, WebP or ICO only, never SVG, up to 256 KB.">
                  <ImageField
                    kind="logo"
                    label="Logo"
                    hint="Replaces the built-in tile and name in the site header. A wide PNG with a transparent background works best (about 360×80)."
                    value={b.logoAssetId}
                    onChange={(id) => ed.update((d) => void (d.logoAssetId = id))}
                    error={e.logoAssetId}
                    previewClass="h-16 w-36"
                  />
                  <ImageField kind="favicon" label="Favicon" hint="The browser-tab icon: a square PNG (at least 64×64) or an ICO." value={b.faviconAssetId} onChange={(id) => ed.update((d) => void (d.faviconAssetId = id))} error={e.faviconAssetId} />
                  <ImageField
                    kind="og"
                    label="Social share image"
                    hint="Shown when a link to the site is shared. 1200×630 PNG or JPEG. SEO & analytics can override it."
                    value={b.ogAssetId}
                    onChange={(id) => ed.update((d) => void (d.ogAssetId = id))}
                    error={e.ogAssetId}
                    previewClass="h-16 w-[122px]"
                  />
                </EditorCard>
                <p className="flex items-center gap-1.5 text-xs text-text-3">
                  <Mail className="size-3.5" /> Email templates take the product name and support address from the published branding.
                </p>
              </div>
              <aside className="lg:sticky lg:top-20 lg:self-start">
                <Preview name={b.productName} supportEmail={b.supportEmail} color={b.primaryColor} logoUrl={urlOf(b.logoAssetId)} />
              </aside>
            </div>
          );
        }}
      </QueryState>
    </Page>
  );
}
