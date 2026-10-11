"use client";

import { ArrowRight, CircleCheck, Globe, Info, LayoutDashboard, Megaphone, MonitorSmartphone, TriangleAlert, X } from "lucide-react";
import { withProductName, type AnnouncementContent } from "@growthdesk/shared";
import { Card } from "@/components/ui/Card";
import { QueryState } from "@/components/ui/ErrorState";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { SkeletonText } from "@/components/ui/Skeleton";
import { Switch } from "@/components/ui/Switch";
import { cn } from "@/lib/cn";
import { usePlatform } from "@/features/common/platform";
import { DraftBar, ReadOnlyNote, useSiteEditor, WebsiteTile } from "./editor";
import { EditorCard, Segmented, TextField } from "./fields";

/*
 * /website/announcement — one platform-wide message (the `announcement`
 * key): a strip above the public site's navigation and/or a floating card in
 * the signed-in app. A dismissed banner stays dismissed until its text,
 * link or tone changes.
 */

const TONES = {
  info: { icon: Info, edge: "border-info-edge", wash: "bg-info-wash", glyph: "text-accent-ink", label: "Info" },
  warning: { icon: TriangleAlert, edge: "border-warn-edge", wash: "bg-warn-wash", glyph: "text-warn-ink", label: "Warning" },
  success: { icon: CircleCheck, edge: "border-ok-edge", wash: "bg-ok-wash", glyph: "text-ok-ink", label: "Success" },
} as const;

function Message({ a }: { a: AnnouncementContent }) {
  return (
    <p className="min-w-0 flex-1 text-pretty">
      {a.message || <span className="text-text-3">Your message…</span>}
      {a.href && (
        <>
          {" "}
          <span className="inline-flex items-center gap-1 font-semibold whitespace-nowrap text-text-hi">
            Learn more <ArrowRight className="size-3.5" />
          </span>
        </>
      )}
    </p>
  );
}

function Previews({ a }: { a: AnnouncementContent }) {
  const tone = TONES[a.tone];
  const Icon = tone.icon;
  const showPublic = a.audience !== "app";
  const showApp = a.audience !== "public";
  return (
    <div className={cn("flex flex-col gap-4", !a.enabled && "opacity-55")}>
      {showPublic && (
        <div>
          <div className="mb-2 text-2xs font-semibold tracking-wide text-text-3 uppercase">Public site</div>
          <Card className="overflow-hidden">
            <div className={cn("flex items-center gap-2.5 border-b px-3 py-2 text-xs text-text", tone.edge, tone.wash)}>
              <Icon className={cn("size-4 shrink-0", tone.glyph)} />
              <Message a={a} />
              {a.dismissible && <X className="size-3.5 shrink-0 text-text-2" />}
            </div>
            <div className="flex items-center justify-between border-b border-line bg-bg-deep px-3 py-2.5">
              <span className="h-2 w-20 rounded-full bg-s-5" />
              <span className="h-5 w-16 rounded-sm bg-accent" />
            </div>
            <div className="flex flex-col items-center gap-1.5 bg-bg-deep px-3 py-6">
              <span className="h-3 w-3/5 rounded-full bg-s-5" />
              <span className="h-2 w-2/5 rounded-full bg-s-3" />
            </div>
          </Card>
        </div>
      )}
      {showApp && (
        <div>
          <div className="mb-2 text-2xs font-semibold tracking-wide text-text-3 uppercase">Signed-in app</div>
          <Card className="relative h-44 overflow-hidden bg-bg">
            <div className="absolute inset-y-0 left-0 w-16 border-r border-line bg-sidebar" />
            <div className="absolute inset-x-0 top-0 ml-16 h-8 border-b border-line bg-panel" />
            <div className={cn("absolute bottom-3 left-3 max-w-[300px] overflow-hidden rounded-lg border bg-popover shadow-lg", tone.edge)}>
              <div className={cn("flex items-start gap-2 p-2.5 text-xs text-text", tone.wash)}>
                <Icon className={cn("mt-0.5 size-4 shrink-0", tone.glyph)} />
                <Message a={a} />
                {a.dismissible && <X className="size-3.5 shrink-0 text-text-2" />}
              </div>
            </div>
          </Card>
        </div>
      )}
      {!a.enabled && <p className="text-xs text-text-3">Switched off — nothing is shown.</p>}
    </div>
  );
}

/** /website/announcement */
export function WebsiteAnnouncement({ appUrl }: { appUrl: string | null }) {
  const ed = useSiteEditor("announcement");
  const brand = useSiteEditor("branding");
  const { canChange } = usePlatform();
  const name = brand.row?.published.productName ?? "Growthdesk";
  return (
    <Page width="capped">
      <PageHeader icon={<WebsiteTile icon={<Megaphone />} />} title="Announcement" description="A short message across the public site and/or the signed-in app — launches, planned maintenance, news." />
      <DraftBar editors={[ed]} appUrl={appUrl} />
      <ReadOnlyNote />
      <QueryState query={ed.query} loading={<SkeletonText lines={8} />}>
        {() => {
          const a = ed.value!;
          const e = ed.errors;
          return (
            <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_420px]">
              <EditorCard icon={<Megaphone />} title="Message" className="self-start">
                <Switch
                  checked={a.enabled}
                  disabled={!canChange}
                  onCheckedChange={(v) => ed.update((d) => void (d.enabled = v))}
                  label="Show the announcement"
                  description="Takes effect when published."
                />
                <TextField label="Message" value={a.message} onChange={(v) => ed.update((d) => void (d.message = v))} error={e.message} max={280} rows={2} required={a.enabled} hint="One or two sentences. May use {{product_name}}." />
                <TextField
                  label="Link"
                  value={a.href}
                  onChange={(v) => ed.update((d) => void (d.href = v.trim()))}
                  error={e.href}
                  placeholder="/pricing or https://…"
                  hint="Optional. Adds “Learn more →” after the message."
                  mono
                />
                <Segmented
                  label="Tone"
                  value={a.tone}
                  onChange={(v) => ed.update((d) => void (d.tone = v))}
                  options={(Object.keys(TONES) as (keyof typeof TONES)[]).map((t) => {
                    const Icon = TONES[t].icon;
                    return { value: t, label: TONES[t].label, icon: <Icon /> };
                  })}
                />
                <Segmented
                  label="Where"
                  value={a.audience}
                  onChange={(v) => ed.update((d) => void (d.audience = v))}
                  options={[
                    { value: "public", label: "Public site", icon: <Globe /> },
                    { value: "app", label: "Signed-in app", icon: <LayoutDashboard /> },
                    { value: "both", label: "Both", icon: <MonitorSmartphone /> },
                  ]}
                />
                <Switch
                  checked={a.dismissible}
                  disabled={!canChange}
                  onCheckedChange={(v) => ed.update((d) => void (d.dismissible = v))}
                  label="Visitors can close it"
                  description="A closed banner stays closed in that browser until the message, link or tone changes."
                />
              </EditorCard>
              <aside className="lg:sticky lg:top-20 lg:self-start">
                <Previews a={withProductName(a, name)} />
              </aside>
            </div>
          );
        }}
      </QueryState>
    </Page>
  );
}
