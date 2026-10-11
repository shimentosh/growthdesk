import { Callout } from "@/components/ui/Callout";
import { getLegal } from "@/lib/site";
import type { LegalSlug } from "@growthdesk/shared";
import { Markdown } from "./Markdown";

/** /terms and /privacy: the published legal text, rendered as safe Markdown. */
export async function LegalPage({ slug }: { slug: LegalSlug }) {
  const page = await getLegal(slug);
  return (
    <article className="px-4 py-16 sm:px-6 sm:py-20">
      <div className="mx-auto max-w-3xl">
        {page ? (
          <>
            <header className="mb-10 border-b border-line pb-8">
              <h1 className="text-[34px] leading-[1.1] font-semibold tracking-[-0.03em] text-text-hi sm:text-[42px]">{page.title}</h1>
              {page.updatedLabel && <p className="mt-3 text-sm text-text-3">{page.updatedLabel}</p>}
            </header>
            <Markdown source={page.markdown} />
          </>
        ) : (
          <Callout tone="warn" title="This page is unavailable right now">
            It could not be loaded. Refresh the page in a moment.
          </Callout>
        )}
      </div>
    </article>
  );
}

export async function legalTitle(slug: LegalSlug, fallback: string) {
  const page = await getLegal(slug);
  return page?.title || fallback;
}
