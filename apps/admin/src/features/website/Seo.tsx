"use client";

import { BarChart3, ImageOff, Search, Share2, ShieldCheck } from "lucide-react";
import { withProductName } from "@growthdesk/shared";
import { Callout } from "@/components/ui/Callout";
import { Card } from "@/components/ui/Card";
import { QueryState } from "@/components/ui/ErrorState";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { SkeletonText } from "@/components/ui/Skeleton";
import { DraftBar, ReadOnlyNote, useSiteEditor, WebsiteTile } from "./editor";
import { EditorCard, ImageField, Segmented, TextField, useSiteAssets } from "./fields";

/*
 * /website/seo — search and share metadata (`seo`) and website analytics
 * (`analytics`), published together. Analytics runs on the public pages
 * only; the customer site sends page views by hand, so nothing from the
 * signed-in app reaches the provider.
 */

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

function hostOf(url: string | null) {
  try {
    return url ? new URL(url).host : "your-domain.com";
  } catch {
    return "your-domain.com";
  }
}

function SearchSnippet({ title, description, host }: { title: string; description: string; host: string }) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2.5">
        <span className="grid size-7 place-items-center rounded-full border border-line bg-bg text-2xs font-bold text-text-2">{host.charAt(0).toUpperCase()}</span>
        <div className="min-w-0 leading-4">
          <div className="truncate text-xs text-text">{host}</div>
          <div className="truncate text-2xs text-text-3">https://{host}</div>
        </div>
      </div>
      <div className="mt-2 text-[17px] leading-6 text-[#1a0dab] dark:text-[#99c3ff]">{clip(title, 60)}</div>
      <p className="mt-0.5 text-[13px] leading-5 text-text-2">{description ? clip(description, 158) : <span className="text-text-3">No description — search engines pick text from the page.</span>}</p>
    </Card>
  );
}

function ShareCard({ title, description, host, image }: { title: string; description: string; host: string; image: string | null }) {
  return (
    <Card className="overflow-hidden">
      <div className="grid aspect-[1.91/1] place-items-center overflow-hidden border-b border-line bg-well">
        {image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={image} alt="" className="size-full object-cover" />
        ) : (
          <span className="flex flex-col items-center gap-1 text-xs text-text-3">
            <ImageOff className="size-5" /> No share image
          </span>
        )}
      </div>
      <div className="px-3 py-2.5">
        <div className="text-2xs text-text-3 uppercase">{host}</div>
        <div className="mt-0.5 truncate text-sm font-semibold text-text-hi">{title}</div>
        {description && <p className="line-clamp-2 text-xs text-text-2">{description}</p>}
      </div>
    </Card>
  );
}

/** /website/seo */
export function WebsiteSeo({ appUrl }: { appUrl: string | null }) {
  const seo = useSiteEditor("seo");
  const analytics = useSiteEditor("analytics");
  const brand = useSiteEditor("branding");
  const assets = useSiteAssets();
  const name = brand.row?.published.productName ?? "Growthdesk";
  const host = hostOf(appUrl);
  return (
    <Page width="capped">
      <PageHeader icon={<WebsiteTile icon={<Search />} />} title="SEO & analytics" description="How the site appears in search results and link previews, and which analytics service counts its visits." />
      <DraftBar editors={[seo, analytics]} appUrl={appUrl} />
      <ReadOnlyNote />
      <QueryState query={seo.query} loading={<SkeletonText lines={10} />}>
        {() => {
          const s = seo.value!;
          const e = seo.errors;
          const title = withProductName(s.title, name) || name;
          const description = withProductName(s.description, name);
          const ogId = s.ogAssetId ?? brand.row?.published.ogAssetId ?? null;
          const ogUrl = ogId ? (assets.data?.find((a) => a.id === ogId)?.url ?? null) : null;
          return (
            <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_400px]">
              <div className="flex min-w-0 flex-col gap-4">
                <EditorCard icon={<Search />} title="Search">
                  <TextField
                    label="Page title"
                    value={s.title}
                    onChange={(v) => seo.update((d) => void (d.title = v))}
                    error={e.title}
                    max={70}
                    placeholder={name}
                    hint="The home page's title. Empty: the product name. Other pages read “Pricing · Product”."
                  />
                  <TextField
                    label="Description"
                    value={s.description}
                    onChange={(v) => seo.update((d) => void (d.description = v))}
                    error={e.description}
                    max={200}
                    rows={3}
                    hint="About 150 characters is what search results usually show. Also used in the site footer."
                  />
                </EditorCard>
                <EditorCard icon={<Share2 />} title="Link previews">
                  <ImageField
                    kind="og"
                    label="Share image"
                    hint={s.ogAssetId ? "1200×630 PNG or JPEG." : "Empty: the share image from Branding, if there is one. 1200×630 PNG or JPEG."}
                    value={s.ogAssetId}
                    onChange={(id) => seo.update((d) => void (d.ogAssetId = id))}
                    error={e.ogAssetId}
                    previewClass="h-16 w-[122px]"
                  />
                </EditorCard>
                <QueryState query={analytics.query} loading={<SkeletonText lines={4} />}>
                  {() => {
                    const a = analytics.value!;
                    const ae = analytics.errors;
                    return (
                      <EditorCard icon={<BarChart3 />} title="Analytics">
                        <Segmented
                          label="Provider"
                          value={a.provider}
                          onChange={(v) => analytics.update((d) => void (d.provider = v))}
                          options={[
                            { value: "none", label: "None" },
                            { value: "plausible", label: "Plausible" },
                            { value: "ga4", label: "Google Analytics 4" },
                          ]}
                        />
                        {a.provider === "plausible" && (
                          <TextField
                            label="Site domain in Plausible"
                            value={a.plausibleDomain}
                            onChange={(v) => analytics.update((d) => void (d.plausibleDomain = v.trim().toLowerCase()))}
                            error={ae.plausibleDomain}
                            placeholder={host.replace(/:\d+$/, "")}
                            hint="Exactly as the site is registered at plausible.io. Loads plausible.io/js/script.manual.js."
                            mono
                            required
                          />
                        )}
                        {a.provider === "ga4" && (
                          <TextField
                            label="Measurement ID"
                            value={a.ga4MeasurementId}
                            onChange={(v) => analytics.update((d) => void (d.ga4MeasurementId = v.trim().toUpperCase()))}
                            error={ae.ga4MeasurementId}
                            placeholder="G-AB12CD34EF"
                            hint="From Google Analytics → Admin → Data streams. Loads gtag.js from www.googletagmanager.com with IP anonymisation."
                            mono
                            required
                          />
                        )}
                        <Callout tone="info" title="What is tracked">
                          Page views on the public pages only — the landing page, pricing and the legal pages. Nothing is sent from sign-in, sign-up or the signed-in app, so workspace
                          names and ids never reach the provider. Mention the provider in the Privacy Policy when you switch one on.
                        </Callout>
                        {a.provider !== "none" && (
                          <p className="flex items-center gap-1.5 text-xs text-text-3">
                            <ShieldCheck className="size-3.5" /> If the site sends a Content-Security-Policy, allow {a.provider === "plausible" ? "plausible.io" : "www.googletagmanager.com and *.google-analytics.com"}.
                          </p>
                        )}
                      </EditorCard>
                    );
                  }}
                </QueryState>
              </div>
              <aside className="flex flex-col gap-4 lg:sticky lg:top-20 lg:self-start">
                <div>
                  <div className="mb-2 text-2xs font-semibold tracking-wide text-text-3 uppercase">Search result</div>
                  <SearchSnippet title={title} description={description} host={host} />
                </div>
                <div>
                  <div className="mb-2 text-2xs font-semibold tracking-wide text-text-3 uppercase">Link preview</div>
                  <ShareCard title={title} description={description} host={host} image={ogUrl} />
                </div>
              </aside>
            </div>
          );
        }}
      </QueryState>
    </Page>
  );
}
