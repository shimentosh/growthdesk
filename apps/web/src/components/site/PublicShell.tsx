import Link from "next/link";
import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { BrandTile } from "@/components/account/AuthFrame";
import { Button } from "@/components/ui/Button";
import type { PublicSite } from "@/lib/site";
import { AnnouncementBar } from "./Announcement";
import { Analytics } from "./Analytics";
import { ANNOUNCEMENT_COOKIE } from "./announcement-rules";

/*
 * The frame of every public page — the landing page at "/", /pricing,
 * /terms, /privacy: the announcement strip, a sticky top bar (brand,
 * Pricing, Sign in, Get started), the page, and a footer with the legal
 * links and the support address. Server component.
 */

/** The uploaded logo, or the built-in tile beside the product name. */
export function BrandLogo({ name, logoUrl }: { name: string; logoUrl: string | null }) {
  if (logoUrl) {
    // eslint-disable-next-line @next/next/no-img-element -- served by our own API with immutable caching
    return <img src={logoUrl} alt={name} className="h-8 w-auto max-w-[180px] object-contain" />;
  }
  return (
    <span className="flex items-center gap-2.5">
      <BrandTile size="md" />
      <span className="text-[15px] font-semibold tracking-[-0.015em] text-text-hi">{name}</span>
    </span>
  );
}

const NAV = [
  { href: "/#features", label: "Features" },
  { href: "/pricing", label: "Pricing" },
  { href: "/#faq", label: "FAQ" },
];

export async function PublicShell({ site, children }: { site: PublicSite; children: ReactNode }) {
  const jar = await cookies();
  const a = site.announcement;
  const showAnnouncement = a && a.audience !== "app" && !(a.dismissible && jar.get(ANNOUNCEMENT_COOKIE)?.value === a.id);
  const year = new Date().getFullYear();

  return (
    <div className="flex min-h-dvh flex-col bg-bg-deep text-text">
      {showAnnouncement && <AnnouncementBar announcement={a} />}

      <header className="sticky top-0 z-40 border-b border-line bg-bg-deep/85 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-4 sm:px-6">
          <Link href="/" className="flex shrink-0 items-center rounded-sm" aria-label={`${site.productName} home`}>
            <BrandLogo name={site.productName} logoUrl={site.logoUrl} />
          </Link>
          <nav aria-label="Main" className="hidden items-center gap-1 md:flex">
            {NAV.map((n) => (
              <Link key={n.href} href={n.href} className="rounded-sm px-2.5 py-1.5 text-sm font-medium text-text-2 transition-colors hover:bg-hover hover:text-text">
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <Link href="/pricing" className="hidden rounded-sm px-2 py-1.5 text-sm font-medium text-text-2 hover:text-text sm:inline md:hidden">
              Pricing
            </Link>
            <Button href="/login" variant="ghost">
              Sign in
            </Button>
            <Button href="/register" variant="primary">
              Get started
            </Button>
          </div>
        </div>
      </header>

      <main id="main" className="flex-1">
        {children}
      </main>

      <footer className="border-t border-line bg-bg">
        <div className="mx-auto grid max-w-6xl gap-10 px-4 py-12 sm:px-6 md:grid-cols-[1.4fr_1fr_1fr_1fr]">
          <div className="max-w-xs">
            <BrandLogo name={site.productName} logoUrl={site.logoUrl} />
            {site.seo.description && <p className="mt-3 text-sm text-text-3">{site.seo.description}</p>}
          </div>
          <FooterColumn title="Product">
            <FooterLink href="/#features">Features</FooterLink>
            <FooterLink href="/pricing">Pricing</FooterLink>
            <FooterLink href="/#faq">FAQ</FooterLink>
          </FooterColumn>
          <FooterColumn title="Account">
            <FooterLink href="/login">Sign in</FooterLink>
            <FooterLink href="/register">Create an account</FooterLink>
          </FooterColumn>
          <FooterColumn title="Legal">
            <FooterLink href="/terms">Terms of Service</FooterLink>
            <FooterLink href="/privacy">Privacy Policy</FooterLink>
            {site.supportEmail && <FooterLink href={`mailto:${site.supportEmail}`}>{site.supportEmail}</FooterLink>}
          </FooterColumn>
        </div>
        <div className="border-t border-line">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-5 text-xs text-text-3 sm:px-6">
            <span>
              © {year} {site.productName}
            </span>
            {site.supportEmail && (
              <span>
                Questions? <a href={`mailto:${site.supportEmail}`} className="font-medium text-text-2 hover:text-text">{site.supportEmail}</a>
              </span>
            )}
          </div>
        </div>
      </footer>

      {site.analytics.provider !== "none" && <Analytics analytics={site.analytics} />}
    </div>
  );
}

function FooterColumn({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h2 className="text-xs font-semibold tracking-wide text-text-hi uppercase">{title}</h2>
      <ul className="mt-3 flex flex-col gap-2">{children}</ul>
    </div>
  );
}

function FooterLink({ href, children }: { href: string; children: ReactNode }) {
  const cls = "text-sm text-text-2 transition-colors hover:text-text";
  return (
    <li>
      {href.startsWith("mailto:") ? (
        <a href={href} className={cls}>
          {children}
        </a>
      ) : (
        <Link href={href} className={cls}>
          {children}
        </Link>
      )}
    </li>
  );
}
