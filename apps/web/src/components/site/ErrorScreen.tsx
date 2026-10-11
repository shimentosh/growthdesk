import type { ReactNode } from "react";
import { BrandTile } from "@/components/account/AuthFrame";

/*
 * The full-page screen behind not-found, error and global-error: the brand
 * tile, a large status line, one calm sentence and the way out — the same
 * centred-on-the-grey-ground frame as the sign-in pages. No hooks, so both
 * server and client boundaries can render it.
 */
export function ErrorScreen({ code, title, description, actions, footnote }: { code?: string; title: string; description: ReactNode; actions: ReactNode; footnote?: ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-bg-deep px-4 py-16 text-center text-text">
      <BrandTile size="lg" />
      {code && <p className="mt-8 text-sm font-semibold tracking-wide text-accent-ink tabular-nums">{code}</p>}
      <h1 className="mt-2 text-[30px] leading-tight font-semibold tracking-[-0.025em] text-balance text-text-hi sm:text-[38px]">{title}</h1>
      <p className="mx-auto mt-3 max-w-md text-base leading-7 text-pretty text-text-2">{description}</p>
      <div className="mt-8 flex flex-wrap items-center justify-center gap-2">{actions}</div>
      {footnote && <p className="mt-8 text-xs text-text-3">{footnote}</p>}
    </main>
  );
}
