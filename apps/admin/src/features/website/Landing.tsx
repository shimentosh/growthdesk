"use client";

import { useState } from "react";
import { ChevronDown, CircleHelp, Flag, LayoutTemplate, ListOrdered, MessageSquareQuote, Rocket, Sparkles, Star } from "lucide-react";
import { LANDING_ICONS, withProductName, type LandingContent, type LandingIcon } from "@growthdesk/shared";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { QueryState } from "@/components/ui/ErrorState";
import { Field } from "@/components/ui/Field";
import { IconTile } from "@/components/ui/IconTile";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/Popover";
import { SkeletonText } from "@/components/ui/Skeleton";
import { Switch } from "@/components/ui/Switch";
import { cn } from "@/lib/cn";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { platformKey, usePlatform } from "@/features/common/platform";
import { ChangedDot, DraftBar, ReadOnlyNote, sameJson, useSiteEditor, WebsiteTile } from "./editor";
import { CtaFields, EditorCard, ListEditor, OptionalCta, TextField } from "./fields";
import { FEATURE_TINTS, LANDING_ICON_COMPONENTS } from "./landing-icons";

/*
 * /website/landing — the landing page at "/" for signed-out visitors (the
 * `landing` key), with a simplified live preview and the on/off switch
 * (platform setting landingEnabled: off sends visitors to /login).
 */

type Errors = Record<string, string>;

function IconPicker({ value, onChange }: { value: LandingIcon; onChange: (v: LandingIcon) => void }) {
  const { canChange } = usePlatform();
  const [open, setOpen] = useState(false);
  const Current = LANDING_ICON_COMPONENTS[value];
  return (
    <Field label="Icon">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button disabled={!canChange} icon={<Current />} iconRight={<ChevronDown />} className="w-fit">
            {value}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[320px] p-2">
          <div className="grid grid-cols-6 gap-1">
            {LANDING_ICONS.map((name) => {
              const Icon = LANDING_ICON_COMPONENTS[name];
              return (
                <button
                  key={name}
                  type="button"
                  title={name}
                  aria-label={name}
                  aria-pressed={name === value}
                  onClick={() => {
                    onChange(name);
                    setOpen(false);
                  }}
                  className={cn(
                    "grid aspect-square place-items-center rounded-sm border text-text-2 transition-colors hover:bg-hover hover:text-text [&_svg]:size-[18px]",
                    name === value ? "border-accent bg-accent-soft text-accent-ink" : "border-transparent",
                  )}
                >
                  <Icon />
                </button>
              );
            })}
          </div>
        </PopoverContent>
      </Popover>
    </Field>
  );
}

function SectionTitles({ title, subtitle, onTitle, onSubtitle, errors, prefix }: { title: string; subtitle: string; onTitle: (v: string) => void; onSubtitle: (v: string) => void; errors: Errors; prefix: string }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <TextField label="Section title" value={title} onChange={onTitle} error={errors[`${prefix}.title`]} max={120} />
      <TextField label="Subtitle" value={subtitle} onChange={onSubtitle} error={errors[`${prefix}.subtitle`]} max={300} />
    </div>
  );
}

// ─── Preview ─────────────────────────────────────────────────────────────────

/** A compact drawing of the landing page, in the same order and with the same rules as the site. */
function LandingPreview({ c }: { c: LandingContent }) {
  return (
    <Card className="overflow-hidden text-[11px] leading-4">
      <div className="flex items-center justify-between border-b border-line bg-bg-deep px-3 py-2">
        <div className="flex items-center gap-1.5">
          <span className="size-3.5 rounded-[4px] bg-accent" />
          <span className="h-1.5 w-12 rounded-full bg-s-5" />
        </div>
        <div className="flex items-center gap-1.5">
          <span className="h-1.5 w-8 rounded-full bg-s-4" />
          <span className="rounded-[3px] bg-accent px-1.5 py-0.5 text-[8px] font-semibold text-on-accent">Get started</span>
        </div>
      </div>
      <div className="max-h-[calc(100dvh-220px)] overflow-y-auto bg-bg-deep">
        <div className="px-4 pt-6 pb-5 text-center">
          {c.hero.eyebrow && <div className="mx-auto mb-2 w-fit rounded-full border border-line bg-panel px-2 py-0.5 text-[9px] font-semibold text-text-2">{c.hero.eyebrow}</div>}
          <div className="text-[17px] leading-5 font-semibold tracking-[-0.02em] text-balance text-text-hi">{c.hero.headline || "Headline"}</div>
          {c.hero.subheadline && <p className="mx-auto mt-2 max-w-[90%] text-text-2">{c.hero.subheadline}</p>}
          <div className="mt-3 flex justify-center gap-1.5">
            <span className="rounded-[4px] bg-accent px-2 py-1 text-[9px] font-semibold text-on-accent">{c.hero.primaryCta.label || "Button"}</span>
            {c.hero.secondaryCta && <span className="rounded-[4px] border border-line-strong bg-panel px-2 py-1 text-[9px] font-semibold text-text">{c.hero.secondaryCta.label}</span>}
          </div>
        </div>
        {c.socialProof.items.length > 0 && (
          <div className="border-y border-line bg-bg px-3 py-3 text-center">
            {c.socialProof.title && <div className="text-[8px] font-semibold tracking-wide text-text-3 uppercase">{c.socialProof.title}</div>}
            <div className="mt-1.5 flex flex-wrap justify-center gap-x-3 gap-y-1 text-[10px] font-semibold text-text-2">
              {c.socialProof.items.map((i, k) => (
                <span key={k}>{i}</span>
              ))}
            </div>
          </div>
        )}
        {c.features.items.length > 0 && (
          <div className="px-3 py-5">
            <PreviewHeading title={c.features.title} subtitle={c.features.subtitle} />
            <div className="grid grid-cols-2 gap-1.5">
              {c.features.items.map((f, i) => {
                const Icon = LANDING_ICON_COMPONENTS[f.icon];
                return (
                  <div key={i} className="rounded-md border border-line bg-panel p-2">
                    <IconTile icon={<Icon />} tint={FEATURE_TINTS[i % FEATURE_TINTS.length]} size="sm" />
                    <div className="mt-1.5 font-semibold text-text-hi">{f.title}</div>
                    <p className="mt-0.5 line-clamp-3 text-[10px] text-text-3">{f.body}</p>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        {c.steps.items.length > 0 && (
          <div className="bg-bg px-3 py-5">
            <PreviewHeading title={c.steps.title} subtitle={c.steps.subtitle} />
            <div className="flex flex-col gap-1.5">
              {c.steps.items.map((s, i) => (
                <div key={i} className="flex gap-2 rounded-md border border-line bg-panel p-2">
                  <span className="grid size-4 shrink-0 place-items-center rounded-full bg-accent text-[8px] font-bold text-on-accent">{i + 1}</span>
                  <div className="min-w-0">
                    <div className="font-semibold text-text-hi">{s.title}</div>
                    <p className="line-clamp-2 text-[10px] text-text-3">{s.body}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        {c.testimonials.items.length > 0 && (
          <div className="px-3 py-5">
            <PreviewHeading title={c.testimonials.title} subtitle={c.testimonials.subtitle} />
            <div className="flex flex-col gap-1.5">
              {c.testimonials.items.map((t, i) => (
                <div key={i} className="rounded-md border border-line bg-panel p-2">
                  <p className="line-clamp-3 text-text">“{t.quote}”</p>
                  <div className="mt-1 text-[10px] font-semibold text-text-hi">
                    {t.name}
                    {t.role && <span className="font-normal text-text-3"> · {t.role}</span>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        {c.faq.items.length > 0 && (
          <div className="px-3 py-5">
            <PreviewHeading title={c.faq.title} subtitle={c.faq.subtitle} />
            <div className="divide-y divide-line rounded-md border border-line bg-panel">
              {c.faq.items.map((q, i) => (
                <div key={i} className="flex items-center justify-between gap-2 px-2 py-1.5 font-semibold text-text-hi">
                  <span className="min-w-0 truncate">{q.q}</span>
                  <ChevronDown className="size-3 shrink-0 text-text-3" />
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="px-3 pb-6">
          <div className="rounded-lg border border-line bg-panel px-3 py-4 text-center">
            <div className="text-[13px] font-semibold text-balance text-text-hi">{c.finalCta.headline || "Headline"}</div>
            {c.finalCta.body && <p className="mt-1 text-text-2">{c.finalCta.body}</p>}
            <div className="mt-2 flex justify-center gap-1.5">
              <span className="rounded-[4px] bg-accent px-2 py-1 text-[9px] font-semibold text-on-accent">{c.finalCta.primaryCta.label || "Button"}</span>
              {c.finalCta.secondaryCta && <span className="rounded-[4px] border border-line-strong bg-panel px-2 py-1 text-[9px] font-semibold text-text">{c.finalCta.secondaryCta.label}</span>}
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}

function PreviewHeading({ title, subtitle }: { title: string; subtitle: string }) {
  if (!title && !subtitle) return null;
  return (
    <div className="mb-2.5 text-center">
      {title && <div className="text-[13px] font-semibold text-balance text-text-hi">{title}</div>}
      {subtitle && <p className="mt-0.5 text-[10px] text-text-3">{subtitle}</p>}
    </div>
  );
}

// ─── The on/off switch ───────────────────────────────────────────────────────

function LandingSwitch() {
  const { canChange } = usePlatform();
  const settings = useApiQuery<{ landingEnabled: boolean }>(platformKey("settings"), "/admin/settings");
  const save = useApiMutation<unknown, { landingEnabled: boolean }>({
    method: "PATCH",
    path: "/admin/settings",
    invalidate: [platformKey("settings")],
    success: (_, v) => (v.landingEnabled ? "Landing page switched on" : "Landing page switched off — visitors go to sign-in"),
  });
  const on = settings.data?.landingEnabled ?? true;
  return (
    <Card className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <Switch
        checked={on}
        disabled={!canChange || settings.isPending || save.isPending}
        onCheckedChange={(v) => save.mutate({ landingEnabled: v })}
        label="Show the landing page"
        description={on ? "Signed-out visitors to / see this page. Applies immediately — no publish needed." : "Off: signed-out visitors to / go straight to the sign-in page."}
      />
    </Card>
  );
}

// ─── The page ────────────────────────────────────────────────────────────────

/** /website/landing */
export function WebsiteLanding({ appUrl }: { appUrl: string | null }) {
  const ed = useSiteEditor("landing");
  const brand = useSiteEditor("branding");
  const name = brand.row?.published.productName ?? "Growthdesk";
  return (
    <Page width="capped">
      <PageHeader icon={<WebsiteTile icon={<LayoutTemplate />} />} title="Landing page" description="What signed-out visitors see at the root of the customer site. Text may use {{product_name}}." />
      <DraftBar editors={[ed]} appUrl={appUrl} />
      <ReadOnlyNote />
      <QueryState query={ed.query} loading={<SkeletonText lines={14} />}>
        {(row) => {
          const c = ed.value!;
          const e = ed.errors;
          const live = row.published;
          const set = ed.update;
          return (
            <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_400px]">
              <div className="flex min-w-0 flex-col gap-4">
                <LandingSwitch />

                <EditorCard icon={<Flag />} title="Hero" actions={<ChangedDot changed={!sameJson(c.hero, live.hero)} />}>
                  <TextField label="Eyebrow" value={c.hero.eyebrow} onChange={(v) => set((d) => void (d.hero.eyebrow = v))} error={e["hero.eyebrow"]} max={80} hint="The small line above the headline." />
                  <TextField label="Headline" value={c.hero.headline} onChange={(v) => set((d) => void (d.hero.headline = v))} error={e["hero.headline"]} max={140} required />
                  <TextField label="Subheadline" value={c.hero.subheadline} onChange={(v) => set((d) => void (d.hero.subheadline = v))} error={e["hero.subheadline"]} max={400} rows={3} />
                  <CtaFields value={c.hero.primaryCta} onChange={(v) => set((d) => void (d.hero.primaryCta = v))} errors={e} prefix="hero.primaryCta" label="Main button" />
                  <OptionalCta value={c.hero.secondaryCta} onChange={(v) => set((d) => void (d.hero.secondaryCta = v))} errors={e} prefix="hero.secondaryCta" fallback={{ label: "See pricing", href: "/pricing" }} />
                </EditorCard>

                <EditorCard icon={<Star />} title="Social proof strip" description="Short text items — what it works with, who it is for. Not customer logos you do not have permission to show." actions={<ChangedDot changed={!sameJson(c.socialProof, live.socialProof)} />}>
                  <TextField label="Strip title" value={c.socialProof.title} onChange={(v) => set((d) => void (d.socialProof.title = v))} error={e["socialProof.title"]} max={120} />
                  <ListEditor
                    items={c.socialProof.items}
                    onChange={(items) => set((d) => void (d.socialProof.items = items))}
                    max={12}
                    make={() => ""}
                    noun="Item"
                    empty="No items: the strip is hidden."
                    render={(item, setItem, i) => <TextField label="Text" value={item} onChange={setItem} error={e[`socialProof.items.${i}`]} max={60} required />}
                  />
                </EditorCard>

                <EditorCard icon={<Sparkles />} title="Features" actions={<ChangedDot changed={!sameJson(c.features, live.features)} />}>
                  <SectionTitles title={c.features.title} subtitle={c.features.subtitle} onTitle={(v) => set((d) => void (d.features.title = v))} onSubtitle={(v) => set((d) => void (d.features.subtitle = v))} errors={e} prefix="features" />
                  <ListEditor
                    items={c.features.items}
                    onChange={(items) => set((d) => void (d.features.items = items))}
                    max={12}
                    make={() => ({ icon: "sparkles" as LandingIcon, title: "", body: "" })}
                    noun="Feature"
                    empty="No features: the section is hidden."
                    render={(f, setF, i) => (
                      <>
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[auto_1fr]">
                          <IconPicker value={f.icon} onChange={(icon) => setF({ ...f, icon })} />
                          <TextField label="Title" value={f.title} onChange={(title) => setF({ ...f, title })} error={e[`features.items.${i}.title`]} max={80} required />
                        </div>
                        <TextField label="Description" value={f.body} onChange={(body) => setF({ ...f, body })} error={e[`features.items.${i}.body`]} max={400} rows={2} required />
                      </>
                    )}
                  />
                </EditorCard>

                <EditorCard icon={<ListOrdered />} title="How it works" actions={<ChangedDot changed={!sameJson(c.steps, live.steps)} />}>
                  <SectionTitles title={c.steps.title} subtitle={c.steps.subtitle} onTitle={(v) => set((d) => void (d.steps.title = v))} onSubtitle={(v) => set((d) => void (d.steps.subtitle = v))} errors={e} prefix="steps" />
                  <ListEditor
                    items={c.steps.items}
                    onChange={(items) => set((d) => void (d.steps.items = items))}
                    max={6}
                    make={() => ({ title: "", body: "" })}
                    noun="Step"
                    empty="No steps: the section is hidden."
                    render={(s, setS, i) => (
                      <>
                        <TextField label="Title" value={s.title} onChange={(title) => setS({ ...s, title })} error={e[`steps.items.${i}.title`]} max={80} required />
                        <TextField label="Description" value={s.body} onChange={(body) => setS({ ...s, body })} error={e[`steps.items.${i}.body`]} max={400} rows={2} required />
                      </>
                    )}
                  />
                </EditorCard>

                <EditorCard
                  icon={<MessageSquareQuote />}
                  title="Testimonials"
                  description="Only real quotes from real customers, with their permission. With none, the section is hidden."
                  actions={<ChangedDot changed={!sameJson(c.testimonials, live.testimonials)} />}
                >
                  <SectionTitles title={c.testimonials.title} subtitle={c.testimonials.subtitle} onTitle={(v) => set((d) => void (d.testimonials.title = v))} onSubtitle={(v) => set((d) => void (d.testimonials.subtitle = v))} errors={e} prefix="testimonials" />
                  <ListEditor
                    items={c.testimonials.items}
                    onChange={(items) => set((d) => void (d.testimonials.items = items))}
                    max={9}
                    make={() => ({ quote: "", name: "", role: "" })}
                    noun="Testimonial"
                    empty="No testimonials yet."
                    render={(t, setT, i) => (
                      <>
                        <TextField label="Quote" value={t.quote} onChange={(quote) => setT({ ...t, quote })} error={e[`testimonials.items.${i}.quote`]} max={600} rows={3} required />
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                          <TextField label="Name" value={t.name} onChange={(name) => setT({ ...t, name })} error={e[`testimonials.items.${i}.name`]} max={80} required />
                          <TextField label="Role and company" value={t.role} onChange={(role) => setT({ ...t, role })} error={e[`testimonials.items.${i}.role`]} max={120} />
                        </div>
                      </>
                    )}
                  />
                </EditorCard>

                <EditorCard icon={<CircleHelp />} title="FAQ" actions={<ChangedDot changed={!sameJson(c.faq, live.faq)} />}>
                  <SectionTitles title={c.faq.title} subtitle={c.faq.subtitle} onTitle={(v) => set((d) => void (d.faq.title = v))} onSubtitle={(v) => set((d) => void (d.faq.subtitle = v))} errors={e} prefix="faq" />
                  <ListEditor
                    items={c.faq.items}
                    onChange={(items) => set((d) => void (d.faq.items = items))}
                    max={20}
                    make={() => ({ q: "", a: "" })}
                    noun="Question"
                    empty="No questions: the section is hidden."
                    render={(q, setQ, i) => (
                      <>
                        <TextField label="Question" value={q.q} onChange={(v) => setQ({ ...q, q: v })} error={e[`faq.items.${i}.q`]} max={200} required />
                        <TextField label="Answer" value={q.a} onChange={(a) => setQ({ ...q, a })} error={e[`faq.items.${i}.a`]} max={2000} rows={3} required />
                      </>
                    )}
                  />
                </EditorCard>

                <EditorCard icon={<Rocket />} title="Final call to action" actions={<ChangedDot changed={!sameJson(c.finalCta, live.finalCta)} />}>
                  <TextField label="Headline" value={c.finalCta.headline} onChange={(v) => set((d) => void (d.finalCta.headline = v))} error={e["finalCta.headline"]} max={140} required />
                  <TextField label="Text" value={c.finalCta.body} onChange={(v) => set((d) => void (d.finalCta.body = v))} error={e["finalCta.body"]} max={400} rows={2} />
                  <CtaFields value={c.finalCta.primaryCta} onChange={(v) => set((d) => void (d.finalCta.primaryCta = v))} errors={e} prefix="finalCta.primaryCta" label="Main button" />
                  <OptionalCta value={c.finalCta.secondaryCta} onChange={(v) => set((d) => void (d.finalCta.secondaryCta = v))} errors={e} prefix="finalCta.secondaryCta" fallback={{ label: "Compare plans", href: "/pricing" }} />
                </EditorCard>
              </div>

              <aside className="hidden xl:sticky xl:top-20 xl:block xl:self-start">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-2xs font-semibold tracking-wide text-text-3 uppercase">Preview (draft)</span>
                  <span className="text-2xs text-text-3">Simplified</span>
                </div>
                <LandingPreview c={withProductName(c, name)} />
              </aside>
            </div>
          );
        }}
      </QueryState>
    </Page>
  );
}
