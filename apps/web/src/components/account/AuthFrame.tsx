import { TrendingUp } from "lucide-react";
import type { ReactNode } from "react";
import { Card, CardBody } from "@/components/ui/Card";
import { IconTile } from "@/components/ui/IconTile";
import { cn } from "@/lib/cn";

/*
 * The pages outside a workspace — sign-in, sign-up, email links, invitations,
 * unsubscribe, first-run onboarding — share one frame: the Growthdesk tile
 * and name at the top, one centred card on the grey ground.
 *
 *   <AuthFrame><LoginForm /></AuthFrame>              (a layout)
 *   <AuthCard title="Sign in" description="…">…</AuthCard>
 */

const WIDTHS = { sm: "max-w-sm", md: "max-w-md" } as const;

/** Growthdesk's own tile — the app icon. */
export function BrandTile({ size = "xl", className }: { size?: "sm" | "md" | "lg" | "xl"; className?: string }) {
  return <IconTile icon={<TrendingUp />} tint="blue" size={size} className={className} />;
}

/** The brand mark: the app tile over the product name. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <div className={cn("flex flex-col items-center gap-2.5", className)}>
      <BrandTile />
      <div className="text-sm font-semibold tracking-[-0.01em] text-text-2">Growthdesk</div>
    </div>
  );
}

/** The whole page: brand mark, then the card column, centred on the deep ground. */
export function AuthFrame({ width = "sm", children }: { width?: keyof typeof WIDTHS; children: ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-bg-deep px-4 py-10">
      <BrandMark className="mb-7" />
      <div className={cn("w-full", WIDTHS[width])}>{children}</div>
    </main>
  );
}

/** The card itself: a centred title and one calm line under it, then the form. */
export function AuthCard({ title, description, children }: { title: ReactNode; description?: ReactNode; children: ReactNode }) {
  return (
    <Card>
      <CardBody className="flex flex-col gap-5 px-6 py-7 sm:px-8">
        <div className="text-center">
          <h1 className="text-xl font-semibold tracking-[-0.02em] text-text-hi">{title}</h1>
          {description && <p className="mx-auto mt-1.5 max-w-[34ch] text-sm text-pretty text-text-3">{description}</p>}
        </div>
        {children}
      </CardBody>
    </Card>
  );
}

/** The quiet line under a form that points elsewhere ("New here? Create an account"). */
export function AuthFooter({ children }: { children: ReactNode }) {
  return <p className="text-center text-xs text-text-3">{children}</p>;
}
