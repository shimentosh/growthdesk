import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowRight, ChevronDown, CircleCheck, Clock, Inbox, Kanban, Mail, MessageCircle, Phone, Quote } from "lucide-react";
import type { SiteCta } from "@growthdesk/shared";
import { Card } from "@/components/ui/Card";
import { IconTile } from "@/components/ui/IconTile";
import { cn } from "@/lib/cn";
import type { PublicSite } from "@/lib/site";
import { FEATURE_TINTS, LANDING_ICON_COMPONENTS } from "./landing-icons";

/*
 * The landing page at "/", for visitors without a session. Every word comes
 * from the published `landing` content (super-admin → Website → Landing); a
 * section with nothing in it is left out rather than shown empty.
 */

// ─── Calls to action ─────────────────────────────────────────────────────────

const CTA_BASE =
  "inline-flex h-11 items-center justify-center gap-2 rounded-md px-5 text-[15px] font-semibold tracking-[-0.01em] transition-colors whitespace-nowrap [&_svg]:size-4";
const CTA_VARIANTS = {
  primary: "bg-accent text-on-accent shadow-solid hover:bg-accent-hi active:bg-accent-deep",
  secondary: "border border-line-strong bg-ctl-face text-text shadow-sm hover:bg-ctl-hover",
} as const;

export function CtaLink({ cta, variant, arrow }: { cta: SiteCta; variant: keyof typeof CTA_VARIANTS; arrow?: boolean }) {
  const cls = cn(CTA_BASE, CTA_VARIANTS[variant]);
  const body = (
    <>
      {cta.label}
      {arrow && <ArrowRight aria-hidden />}
    </>
  );
  if (/^(https?:|mailto:)/i.test(cta.href)) {
    return (
      <a href={cta.href} className={cls} {...(cta.href.startsWith("mailto:") ? {} : { target: "_blank", rel: "noopener noreferrer" })}>
        {body}
      </a>
    );
  }
  return (
    <Link href={cta.href} className={cls}>
      {body}
    </Link>
  );
}

function SectionHeading({ title, subtitle, id }: { title: string; subtitle?: string; id?: string }) {
  if (!title && !subtitle) return null;
  return (
    <div className="mx-auto mb-12 max-w-2xl text-center">
      {title && (
        <h2 id={id} className="text-[28px] leading-[1.15] font-semibold tracking-[-0.025em] text-balance text-text-hi sm:text-[34px]">
          {title}
        </h2>
      )}
      {subtitle && <p className="mt-3 text-lg leading-7 text-pretty text-text-2">{subtitle}</p>}
    </div>
  );
}

function Section({ id, className, children, labelledBy }: { id?: string; className?: string; children: ReactNode; labelledBy?: string }) {
  return (
    <section id={id} aria-labelledby={labelledBy} className={cn("scroll-mt-20 px-4 py-20 sm:px-6 sm:py-24", className)}>
      <div className="mx-auto max-w-6xl">{children}</div>
    </section>
  );
}

// ─── The hero's product sketch ───────────────────────────────────────────────

/** A drawing of the product's own building blocks (a sequence, a reply, the pipeline) — decorative, no data. */
function ProductSketch() {
  const steps = [
    { icon: <Mail />, label: "Email", note: "Day 1 · Introduction" },
    { icon: <Clock />, label: "Wait", note: "2 days, skipped on reply" },
    { icon: <MessageCircle />, label: "WhatsApp", note: "Day 3 · Short follow-up" },
    { icon: <Phone />, label: "Call task", note: "Day 5 · With a script" },
  ];
  const stages = ["New", "Meeting", "Proposal", "Won"];
  return (
    <div aria-hidden className="relative isolate mx-auto mt-16 max-w-5xl text-left select-none">
      <div className="absolute -inset-x-8 -inset-y-6 -z-10 rounded-[32px] bg-[radial-gradient(60%_60%_at_50%_40%,var(--accent-soft),transparent)] blur-2xl" />
      <Card className="overflow-hidden shadow-lg">
        <div className="flex items-center gap-1.5 border-b border-line bg-well px-4 py-2.5">
          <span className="size-2.5 rounded-full bg-s-6" />
          <span className="size-2.5 rounded-full bg-s-6" />
          <span className="size-2.5 rounded-full bg-s-6" />
        </div>
        <div className="grid gap-px bg-line md:grid-cols-[1.1fr_1fr_1fr]">
          <div className="bg-panel p-5">
            <div className="mb-4 text-xs font-semibold tracking-wide text-text-3 uppercase">Sequence</div>
            <ol className="flex flex-col gap-2.5">
              {steps.map((s, i) => (
                <li key={s.label} className="flex items-center gap-3 rounded-md border border-line bg-bg p-2.5">
                  <IconTile icon={s.icon} tint={(["blue", "gray", "green", "orange"] as const)[i]} size="md" />
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-text-hi">{s.label}</div>
                    <div className="truncate text-xs text-text-3">{s.note}</div>
                  </div>
                </li>
              ))}
            </ol>
          </div>
          <div className="bg-panel p-5">
            <div className="mb-4 flex items-center gap-1.5 text-xs font-semibold tracking-wide text-text-3 uppercase">
              <Inbox className="size-3.5" /> Inbox
            </div>
            <div className="flex flex-col gap-2.5">
              <div className="rounded-md border border-line bg-bg p-3">
                <div className="mb-1.5 flex items-center justify-between text-xs">
                  <span className="font-semibold text-text-hi">Reply · Email</span>
                  <span className="rounded-full bg-ok-chip px-2 py-0.5 font-medium text-ok-ink">Interested</span>
                </div>
                <div className="h-2 w-11/12 rounded-full bg-s-4" />
                <div className="mt-1.5 h-2 w-2/3 rounded-full bg-s-4" />
              </div>
              <div className="rounded-md border border-line bg-bg p-3">
                <div className="mb-1.5 flex items-center justify-between text-xs">
                  <span className="font-semibold text-text-hi">Reply · WhatsApp</span>
                  <span className="rounded-full bg-live-chip px-2 py-0.5 font-medium text-accent-ink">Assigned</span>
                </div>
                <div className="h-2 w-3/4 rounded-full bg-s-4" />
              </div>
              <div className="flex items-center gap-2 rounded-md border border-dashed border-line-strong px-3 py-2 text-xs font-medium text-text-2">
                <CircleCheck className="size-3.5 text-ok" /> Create a deal from this reply
              </div>
            </div>
          </div>
          <div className="bg-panel p-5">
            <div className="mb-4 flex items-center gap-1.5 text-xs font-semibold tracking-wide text-text-3 uppercase">
              <Kanban className="size-3.5" /> Pipeline
            </div>
            <div className="grid grid-cols-2 gap-2">
              {stages.map((stage, i) => (
                <div key={stage} className="rounded-md border border-line bg-bg p-2.5">
                  <div className="mb-2 text-xs font-semibold text-text-2">{stage}</div>
                  {Array.from({ length: 3 - Math.min(2, i) }, (_, k) => (
                    <div key={k} className={cn("mb-1.5 h-5 rounded-sm last:mb-0", i === 3 ? "bg-ok-chip" : "bg-s-3")} />
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}

// ─── The page ────────────────────────────────────────────────────────────────

export function Landing({ site }: { site: PublicSite }) {
  const { hero, socialProof, features, steps, testimonials, faq, finalCta } = site.landing;

  return (
    <>
      {/* Hero */}
      <section className="relative overflow-hidden px-4 pt-16 pb-20 sm:px-6 sm:pt-24">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 -z-0 h-[520px] bg-[radial-gradient(50%_60%_at_50%_0%,var(--accent-soft),transparent)]"
        />
        <div className="relative mx-auto max-w-6xl text-center">
          {hero.eyebrow && (
            <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-line-strong bg-panel px-3 py-1 text-xs font-semibold text-text-2 shadow-sm">
              <span className="size-1.5 rounded-full bg-accent" />
              {hero.eyebrow}
            </div>
          )}
          <h1 className="mx-auto max-w-4xl text-[40px] leading-[1.05] font-semibold tracking-[-0.035em] text-balance text-text-hi sm:text-[60px]">
            {hero.headline}
          </h1>
          {hero.subheadline && <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-pretty text-text-2 sm:text-xl sm:leading-8">{hero.subheadline}</p>}
          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <CtaLink cta={hero.primaryCta} variant="primary" arrow />
            {hero.secondaryCta && <CtaLink cta={hero.secondaryCta} variant="secondary" />}
          </div>
          <ProductSketch />
        </div>
      </section>

      {/* Social proof strip */}
      {socialProof.items.length > 0 && (
        <section aria-label={socialProof.title || "Works with"} className="border-y border-line bg-bg px-4 py-10 sm:px-6">
          <div className="mx-auto max-w-6xl text-center">
            {socialProof.title && <p className="text-xs font-semibold tracking-wide text-text-3 uppercase">{socialProof.title}</p>}
            <ul className="mt-5 flex flex-wrap items-center justify-center gap-x-8 gap-y-3">
              {socialProof.items.map((item) => (
                <li key={item} className="text-base font-semibold tracking-[-0.01em] text-text-2">
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      {/* Features */}
      {features.items.length > 0 && (
        <Section id="features" labelledBy="features-title">
          <SectionHeading id="features-title" title={features.title} subtitle={features.subtitle} />
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {features.items.map((f, i) => {
              const Icon = LANDING_ICON_COMPONENTS[f.icon];
              return (
                <li key={`${f.title}-${i}`}>
                  <Card className="h-full p-6 transition-shadow hover:shadow-md">
                    <IconTile icon={<Icon />} tint={FEATURE_TINTS[i % FEATURE_TINTS.length]} size="lg" />
                    <h3 className="mt-4 text-lg font-semibold tracking-[-0.015em] text-text-hi">{f.title}</h3>
                    <p className="mt-2 text-[15px] leading-6 text-text-2">{f.body}</p>
                  </Card>
                </li>
              );
            })}
          </ul>
        </Section>
      )}

      {/* How it works */}
      {steps.items.length > 0 && (
        <Section id="how-it-works" labelledBy="steps-title" className="bg-bg">
          <SectionHeading id="steps-title" title={steps.title} subtitle={steps.subtitle} />
          <ol className={cn("grid gap-6", steps.items.length >= 3 ? "md:grid-cols-3" : "md:grid-cols-2")}>
            {steps.items.map((s, i) => (
              <li key={`${s.title}-${i}`} className="relative rounded-xl border border-line bg-panel p-6 shadow-card">
                <span className="inline-flex size-9 items-center justify-center rounded-full bg-accent text-sm font-bold text-on-accent shadow-solid">{i + 1}</span>
                <h3 className="mt-4 text-lg font-semibold tracking-[-0.015em] text-text-hi">{s.title}</h3>
                <p className="mt-2 text-[15px] leading-6 text-text-2">{s.body}</p>
              </li>
            ))}
          </ol>
        </Section>
      )}

      {/* Testimonials — only real ones, so empty by default */}
      {testimonials.items.length > 0 && (
        <Section id="testimonials" labelledBy="testimonials-title">
          <SectionHeading id="testimonials-title" title={testimonials.title} subtitle={testimonials.subtitle} />
          <ul className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {testimonials.items.map((t, i) => (
              <li key={`${t.name}-${i}`}>
                <Card className="flex h-full flex-col p-6">
                  <Quote aria-hidden className="size-5 text-accent" />
                  <blockquote className="mt-3 flex-1 text-[15px] leading-7 text-text">{t.quote}</blockquote>
                  <div className="mt-5 border-t border-line pt-4">
                    <div className="text-sm font-semibold text-text-hi">{t.name}</div>
                    {t.role && <div className="text-xs text-text-3">{t.role}</div>}
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* FAQ — native disclosure, works without JavaScript */}
      {faq.items.length > 0 && (
        <Section id="faq" labelledBy="faq-title" className={testimonials.items.length > 0 ? "bg-bg" : undefined}>
          <SectionHeading id="faq-title" title={faq.title} subtitle={faq.subtitle} />
          <div className="mx-auto max-w-3xl">
            <Card className="divide-y divide-line">
              {faq.items.map((item, i) => (
                <details key={`${item.q}-${i}`} className="group px-5 [&_summary::-webkit-details-marker]:hidden">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-4 text-left text-base font-semibold text-text-hi">
                    {item.q}
                    <ChevronDown aria-hidden className="size-4 shrink-0 text-text-3 transition-transform group-open:rotate-180" />
                  </summary>
                  <p className="pb-5 text-[15px] leading-7 whitespace-pre-line text-text-2">{item.a}</p>
                </details>
              ))}
            </Card>
          </div>
        </Section>
      )}

      {/* Final call to action */}
      <section className="px-4 pb-24 sm:px-6">
        <div className="relative mx-auto max-w-6xl overflow-hidden rounded-[22px] border border-line bg-panel px-6 py-14 text-center shadow-md sm:px-12 sm:py-16">
          <div aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(70%_80%_at_50%_0%,var(--accent-soft),transparent)]" />
          <div className="relative">
            <h2 className="mx-auto max-w-2xl text-[28px] leading-[1.15] font-semibold tracking-[-0.025em] text-balance text-text-hi sm:text-[36px]">
              {finalCta.headline}
            </h2>
            {finalCta.body && <p className="mx-auto mt-4 max-w-xl text-lg leading-7 text-pretty text-text-2">{finalCta.body}</p>}
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <CtaLink cta={finalCta.primaryCta} variant="primary" arrow />
              {finalCta.secondaryCta && <CtaLink cta={finalCta.secondaryCta} variant="secondary" />}
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
