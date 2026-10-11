"use client";

import { useEffect } from "react";
import { House, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ErrorScreen } from "@/components/site/ErrorScreen";

/** A crash anywhere below the root layout. The layout (theme, providers) still stands; this replaces the page. */
export default function RouteError({ error, retry, reset }: { error: Error & { digest?: string }; retry?: () => void; reset?: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  const again = retry ?? reset;
  return (
    <ErrorScreen
      code="Error"
      title="Something went wrong"
      description="An unexpected problem stopped this page from loading. Try again, or head back to the start."
      actions={
        <>
          {again && (
            <Button variant="primary" icon={<RefreshCw />} onClick={() => again()}>
              Try again
            </Button>
          )}
          <Button href="/" icon={<House />}>
            Go to home
          </Button>
        </>
      }
      footnote={error.digest ? `Reference: ${error.digest}` : undefined}
    />
  );
}
