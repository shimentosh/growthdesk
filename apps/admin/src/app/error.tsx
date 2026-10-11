"use client";

import { useEffect } from "react";
import { RefreshCw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { IconTile } from "@/components/ui/IconTile";

/** A render error anywhere below the root layout. The digest matches the server log line. */
export default function RouteError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <main className="flex min-h-[60dvh] flex-col items-center justify-center gap-4 px-4 py-10 text-center">
      <IconTile icon={<TriangleAlert />} tint="red" size="lg" />
      <div className="flex max-w-md flex-col gap-1.5">
        <h1 className="text-xl font-semibold tracking-[-0.02em] text-text-hi">Something went wrong</h1>
        <p className="text-sm text-text-3">{error.message || "This page could not be shown."}</p>
        {error.digest && <p className="font-mono text-2xs text-text-3">Reference {error.digest}</p>}
      </div>
      <div className="flex gap-2">
        <Button variant="primary" icon={<RefreshCw />} onClick={() => retry()}>
          Try again
        </Button>
        <Button href="/">Dashboard</Button>
      </div>
    </main>
  );
}
