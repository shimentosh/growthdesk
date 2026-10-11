"use client";

import { useEffect } from "react";
import { RefreshCw } from "lucide-react";
import { ErrorScreen } from "@/components/site/ErrorScreen";
import "./globals.css";

/*
 * A crash in the root layout itself. It replaces the whole document, so it
 * brings its own <html>, <body> and styles; the appearance follows the OS
 * (the theme cookie is read by the layout that just failed). Plain anchors
 * and buttons: the app's providers are gone.
 */
export default function GlobalError({ error, retry, reset }: { error: Error & { digest?: string }; retry?: () => void; reset?: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  const again = retry ?? reset;
  const button =
    "inline-flex h-8 items-center justify-center gap-1.5 rounded-sm border px-3 text-sm font-medium transition-colors [&_svg]:size-4";
  return (
    <html lang="en">
      <body>
        <title>Something went wrong</title>
        <ErrorScreen
          code="Error"
          title="Something went wrong"
          description="The app could not load. Try again in a moment — if it keeps happening, the service may be briefly unavailable."
          actions={
            <>
              {again && (
                <button type="button" onClick={() => again()} className={`${button} border-transparent bg-accent font-semibold text-on-accent hover:bg-accent-hi`}>
                  <RefreshCw aria-hidden /> Try again
                </button>
              )}
              <a href="/" className={`${button} border-line-strong bg-ctl-face text-text hover:bg-ctl-hover`}>
                Go to home
              </a>
            </>
          }
          footnote={error.digest ? `Reference: ${error.digest}` : undefined}
        />
      </body>
    </html>
  );
}
