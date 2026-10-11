"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { ArrowRight, CircleCheck, Info, TriangleAlert, X } from "lucide-react";
import type { PublicSite } from "@growthdesk/shared";
import { cn } from "@/lib/cn";
import { ANNOUNCEMENT_COOKIE, isAppPath } from "./announcement-rules";

/*
 * The platform announcement, edited in the super-admin (Website →
 * Announcement). On the public site it is a strip above the navigation; in
 * the signed-in app — whose shell fills the viewport — it floats in the
 * bottom-left corner instead of pushing the layout. Closing it sets a cookie
 * with the message's id, so the server stops rendering it until the text
 * changes.
 */

export type SiteAnnouncement = NonNullable<PublicSite["announcement"]>;

const TONES = {
  info: { icon: Info, edge: "border-info-edge", wash: "bg-info-wash", glyph: "text-accent-ink" },
  warning: { icon: TriangleAlert, edge: "border-warn-edge", wash: "bg-warn-wash", glyph: "text-warn-ink" },
  success: { icon: CircleCheck, edge: "border-ok-edge", wash: "bg-ok-wash", glyph: "text-ok-ink" },
} as const;

function dismiss(id: string) {
  document.cookie = `${ANNOUNCEMENT_COOKIE}=${encodeURIComponent(id)}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
}

function MessageLink({ href, children }: { href: string; children: React.ReactNode }) {
  const cls = "inline-flex items-center gap-1 font-semibold whitespace-nowrap text-text-hi underline-offset-2 hover:underline [&_svg]:size-3.5";
  if (/^(https?:|mailto:)/i.test(href)) {
    return (
      <a href={href} className={cls} target={href.startsWith("mailto:") ? undefined : "_blank"} rel="noopener noreferrer">
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className={cls}>
      {children}
    </Link>
  );
}

/** The strip at the top of the public site. */
export function AnnouncementBar({ announcement: a }: { announcement: SiteAnnouncement }) {
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;
  const tone = TONES[a.tone];
  const Icon = tone.icon;
  return (
    <div role="region" aria-label="Announcement" className={cn("border-b", tone.edge, tone.wash)}>
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-2 text-sm text-text sm:px-6">
        <Icon aria-hidden className={cn("size-4 shrink-0", tone.glyph)} />
        <p className="min-w-0 flex-1 text-pretty">
          {a.message}
          {a.href && (
            <>
              {" "}
              <MessageLink href={a.href}>
                Learn more <ArrowRight aria-hidden />
              </MessageLink>
            </>
          )}
        </p>
        {a.dismissible && (
          <button
            type="button"
            aria-label="Dismiss announcement"
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-sm text-text-2 hover:bg-hover hover:text-text"
            onClick={() => {
              dismiss(a.id);
              setHidden(true);
            }}
          >
            <X className="size-4" />
          </button>
        )}
      </div>
    </div>
  );
}

/** The floating card inside the signed-in app (only on app routes). */
export function AppAnnouncement({ announcement: a }: { announcement: SiteAnnouncement }) {
  const pathname = usePathname();
  const [hidden, setHidden] = useState(false);
  if (hidden || !isAppPath(pathname ?? "")) return null;
  const tone = TONES[a.tone];
  const Icon = tone.icon;
  return (
    <div
      role="region"
      aria-label="Announcement"
      className="pointer-events-none fixed inset-x-3 bottom-3 z-[90] flex sm:inset-x-auto sm:bottom-4 sm:left-4 sm:max-w-[400px]"
    >
      <div className={cn("pointer-events-auto w-full overflow-hidden rounded-lg border bg-popover shadow-lg animate-toast-in", tone.edge)}>
      <div className={cn("flex items-start gap-2.5 p-3 text-sm text-text", tone.wash)}>
        <Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", tone.glyph)} />
        <p className="min-w-0 flex-1 text-pretty">
          {a.message}
          {a.href && (
            <>
              {" "}
              <MessageLink href={a.href}>
                Learn more <ArrowRight aria-hidden />
              </MessageLink>
            </>
          )}
        </p>
        {a.dismissible && (
          <button
            type="button"
            aria-label="Dismiss announcement"
            className="-m-1 inline-flex size-7 shrink-0 items-center justify-center rounded-sm text-text-2 hover:bg-hover hover:text-text"
            onClick={() => {
              dismiss(a.id);
              setHidden(true);
            }}
          >
            <X className="size-4" />
          </button>
        )}
      </div>
      </div>
    </div>
  );
}
