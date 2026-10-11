"use client";

import { useState } from "react";
import { CalendarCheck, Eye, FileText, PenLine, Scale } from "lucide-react";
import { LEGAL_MARKDOWN_MAX, SITE_DEFAULTS, withProductName } from "@growthdesk/shared";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card } from "@/components/ui/Card";
import { QueryState } from "@/components/ui/ErrorState";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { SkeletonText } from "@/components/ui/Skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { cn } from "@/lib/cn";
import { usePlatform } from "@/features/common/platform";
import { DraftBar, ReadOnlyNote, useSiteEditor, WebsiteTile } from "./editor";
import { TextField } from "./fields";
import { Markdown } from "./Markdown";

/*
 * /website/legal — the Terms of Service and Privacy Policy pages
 * (`legal.terms`, `legal.privacy`), written in Markdown and rendered on the
 * customer site without raw HTML. Each tab has its own draft and publish.
 */

const SYNTAX = "## Heading · **bold** · *italic* · [link](https://…) · - list · 1. list · > quote · | table |";

function LegalEditor({ slug, appUrl, productName }: { slug: "terms" | "privacy"; appUrl: string | null; productName: string }) {
  const key = slug === "terms" ? "legal.terms" : "legal.privacy";
  const ed = useSiteEditor(key);
  const { canChange } = usePlatform();
  const [view, setView] = useState<"write" | "preview">("write");
  return (
    <>
      <DraftBar editors={[ed]} appUrl={appUrl} livePath={`/${slug}`} label={slug === "terms" ? "Terms of Service" : "Privacy Policy"} />
      <QueryState query={ed.query} loading={<SkeletonText lines={14} />}>
        {() => {
          const c = ed.value!;
          const e = ed.errors;
          const isDefaultText = c.markdown.trim() === SITE_DEFAULTS[key].markdown.trim();
          return (
            <div className="flex flex-col gap-4">
              {isDefaultText && (
                <Callout tone="warn" title="This is the built-in generic draft">
                  It describes how the product works in plain language, but it is not legal advice and names no company, address or jurisdiction. Have it reviewed (and completed) by
                  counsel before launch.
                </Callout>
              )}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1.4fr_1fr]">
                <TextField label="Page title" value={c.title} onChange={(v) => ed.update((d) => void (d.title = v))} error={e.title} max={120} required />
                <div className="flex items-end gap-2">
                  <TextField
                    className="flex-1"
                    label="Updated label"
                    value={c.updatedLabel}
                    onChange={(v) => ed.update((d) => void (d.updatedLabel = v))}
                    error={e.updatedLabel}
                    max={80}
                    placeholder="Last updated 1 October 2026"
                  />
                  {canChange && (
                    <Button
                      icon={<CalendarCheck />}
                      title="Set to today's date"
                      onClick={() =>
                        ed.update((d) => void (d.updatedLabel = `Last updated ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}`))
                      }
                    >
                      Today
                    </Button>
                  )}
                </div>
              </div>

              <div className="flex items-center justify-between gap-2 lg:hidden">
                <div role="radiogroup" aria-label="View" className="inline-flex rounded-sm border border-line-strong bg-ctl p-0.5">
                  {(["write", "preview"] as const).map((v) => (
                    <button
                      key={v}
                      type="button"
                      role="radio"
                      aria-checked={view === v}
                      onClick={() => setView(v)}
                      className={cn("inline-flex h-7 items-center gap-1.5 rounded-xs px-2.5 text-xs font-medium [&_svg]:size-3.5", view === v ? "bg-ctl-face text-text-hi shadow-sm" : "text-text-3")}
                    >
                      {v === "write" ? <PenLine /> : <Eye />}
                      {v === "write" ? "Write" : "Preview"}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid gap-4 lg:grid-cols-2">
                <div className={cn("min-w-0", view === "preview" && "hidden lg:block")}>
                  <TextField label="Markdown" value={c.markdown} onChange={(v) => ed.update((d) => void (d.markdown = v))} error={e.markdown} max={LEGAL_MARKDOWN_MAX} rows={28} mono required hint={SYNTAX} />
                </div>
                <div className={cn("min-w-0", view === "write" && "hidden lg:block")}>
                  <div className="mb-1.5 text-xs font-medium text-text-2">Preview</div>
                  <Card className="max-h-[720px] overflow-y-auto px-6 py-5">
                    <h1 className="text-2xl font-semibold tracking-[-0.02em] text-text-hi">{withProductName(c.title, productName) || "Untitled"}</h1>
                    {c.updatedLabel && <p className="mt-1 text-xs text-text-3">{c.updatedLabel}</p>}
                    <div className="mt-4 border-t border-line pt-2">
                      <Markdown source={withProductName(c.markdown, productName)} className="text-sm leading-6" />
                    </div>
                  </Card>
                  <p className="mt-1.5 text-2xs text-text-3">Raw HTML is shown as text; only http(s), mailto, /path and #anchor links are kept.</p>
                </div>
              </div>
            </div>
          );
        }}
      </QueryState>
    </>
  );
}

/** /website/legal */
export function WebsiteLegal({ appUrl }: { appUrl: string | null }) {
  const brand = useSiteEditor("branding");
  const productName = brand.row?.published.productName ?? "Growthdesk";
  return (
    <Page width="capped">
      <PageHeader icon={<WebsiteTile icon={<Scale />} />} title="Legal pages" description="The Terms of Service and Privacy Policy at /terms and /privacy, linked from the site footer. Text may use {{product_name}}." />
      <ReadOnlyNote />
      <Tabs defaultValue="terms">
        <TabsList className="mb-1">
          <TabsTrigger value="terms">
            <FileText /> Terms of Service
          </TabsTrigger>
          <TabsTrigger value="privacy">
            <FileText /> Privacy Policy
          </TabsTrigger>
        </TabsList>
        <TabsContent value="terms" forceMount className="pt-0 data-[state=inactive]:hidden">
          <LegalEditor slug="terms" appUrl={appUrl} productName={productName} />
        </TabsContent>
        <TabsContent value="privacy" forceMount className="pt-0 data-[state=inactive]:hidden">
          <LegalEditor slug="privacy" appUrl={appUrl} productName={productName} />
        </TabsContent>
      </Tabs>
    </Page>
  );
}
