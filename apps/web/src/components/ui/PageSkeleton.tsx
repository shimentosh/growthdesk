import { Skeleton } from "./Skeleton";

/*
 * Route-level loading states (the `loading.tsx` files). Next shows these the
 * instant a link is clicked — the layouts around them (sidebar, settings menu)
 * stay put — and swaps in the page when it arrives. They follow the shape of
 * a typical page so nothing jumps when the real content lands.
 */

function Header() {
  return (
    <div className="flex items-start gap-3">
      <Skeleton className="size-10 shrink-0 rounded-lg" />
      <div className="flex flex-1 flex-col gap-2 pt-0.5">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-3.5 w-80 max-w-full" />
      </div>
    </div>
  );
}

function FormCard({ rows = 3 }: { rows?: number }) {
  return (
    <div className="rounded-xl border border-line bg-panel p-4 shadow-card">
      <div className="mb-4 flex items-center gap-2.5 border-b border-line pb-3.5">
        <Skeleton className="size-4" />
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3 w-64 max-w-full" />
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {Array.from({ length: rows * 2 }, (_, i) => (
          <div key={i} className="flex flex-col gap-1.5">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-8 w-full rounded-md" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** The content side of a Settings section (the settings menu stays on screen). */
export function SettingsSkeleton() {
  return (
    <div role="status" aria-label="Loading" className="flex flex-col gap-5">
      <Header />
      <FormCard rows={2} />
      <FormCard rows={1} />
      <span className="sr-only">Loading…</span>
    </div>
  );
}

/** A workspace page: header, a row of figures, a list. */
export function PageSkeleton() {
  return (
    <div role="status" aria-label="Loading" className="mx-auto flex w-full max-w-[1200px] flex-col gap-5 px-4 py-5 nav:px-6 nav:py-6">
      <Header />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="rounded-xl border border-line bg-panel p-4 shadow-card">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="mt-3 h-6 w-16" />
          </div>
        ))}
      </div>
      <div className="rounded-xl border border-line bg-panel shadow-card">
        <div className="flex items-center gap-2 border-b border-line p-3">
          <Skeleton className="h-8 w-64 max-w-full rounded-md" />
          <Skeleton className="ml-auto h-8 w-24 rounded-md" />
        </div>
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="flex items-center gap-3 border-b border-line px-3 py-3 last:border-b-0">
            <Skeleton className="size-7 shrink-0 rounded-full" />
            <Skeleton className="h-3.5" style={{ width: `${38 - (i % 3) * 6}%` }} />
            <Skeleton className="ml-auto h-3.5 w-16" />
          </div>
        ))}
      </div>
      <span className="sr-only">Loading…</span>
    </div>
  );
}
