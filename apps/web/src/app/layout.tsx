import type { Metadata } from "next";
import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { AppAnnouncement } from "@/components/site/Announcement";
import { ANNOUNCEMENT_COOKIE } from "@/components/site/announcement-rules";
import { accentCss, getSite } from "@/lib/site";
import { asTheme, THEME_COOKIE, themeClass } from "@/lib/theme";
import { Providers } from "./providers";
import "./globals.css";

/**
 * Title, description, favicon and share image from the published branding and
 * SEO content (super-admin → Website). getSite() falls back to the built-in
 * defaults when the API is down, so this never fails a page.
 */
export async function generateMetadata(): Promise<Metadata> {
  const site = await getSite();
  const name = site.productName;
  const title = site.seo.title || name;
  const description = site.seo.description || undefined;
  const images = site.seo.ogImageUrl ? [{ url: site.seo.ogImageUrl }] : undefined;
  return {
    title: { default: title, template: `%s · ${name}` },
    description,
    applicationName: name,
    ...(site.faviconUrl ? { icons: { icon: site.faviconUrl } } : {}),
    openGraph: { type: "website", siteName: name, title, description, images },
    twitter: { card: images ? "summary_large_image" : "summary", title, description, images: images?.map((i) => i.url) },
  };
}

/** The theme class is rendered on the server from the cookie, so the first paint is already right. */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const jar = await cookies();
  const theme = asTheme(jar.get(THEME_COOKIE)?.value);
  const site = await getSite();
  // Only ever built from a validated #rrggbb (see accentCss).
  const accent = accentCss(site.primaryColor);
  const a = site.announcement;
  const appAnnouncement = a && a.audience !== "public" && !(a.dismissible && jar.get(ANNOUNCEMENT_COOKIE)?.value === a.id) ? a : null;
  return (
    <html lang="en" className={themeClass(theme) || undefined} suppressHydrationWarning>
      <body>
        {accent && <style id="gd-brand-accent" dangerouslySetInnerHTML={{ __html: accent }} />}
        <Providers>
          {children}
          {appAnnouncement && <AppAnnouncement announcement={appAnnouncement} />}
        </Providers>
      </body>
    </html>
  );
}
