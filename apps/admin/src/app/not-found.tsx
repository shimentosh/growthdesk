import type { Metadata } from "next";
import { SearchX } from "lucide-react";
import { ConsoleTile } from "@/components/shell/Brand";
import { Button } from "@/components/ui/Button";
import { IconTile } from "@/components/ui/IconTile";

export const metadata: Metadata = { title: "Not found" };

/** Unknown paths — and, deliberately, the whole console for a signed-in customer account. */
export default function NotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-bg-deep px-4 py-10 text-center">
      <ConsoleTile size="lg" />
      <div className="flex max-w-sm flex-col items-center gap-3">
        <IconTile icon={<SearchX />} tint="gray" size="lg" />
        <h1 className="text-xl font-semibold tracking-[-0.02em] text-text-hi">Page not found</h1>
        <p className="text-sm text-text-3">This page does not exist, or your account cannot open it.</p>
      </div>
      <Button href="/" variant="secondary">
        Go to the dashboard
      </Button>
    </main>
  );
}
