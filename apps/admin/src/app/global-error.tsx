"use client";

/*
 * Replaces the root layout when it fails, so it brings its own document and
 * cannot rely on globals.css: plain inline styles that follow the OS theme.
 */
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100dvh",
          display: "grid",
          placeItems: "center",
          fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
          colorScheme: "light dark",
          background: "Canvas",
          color: "CanvasText",
        }}
      >
        <title>Error · Growthdesk Console</title>
        <main style={{ maxWidth: 420, padding: 24, textAlign: "center" }}>
          <h1 style={{ fontSize: 20, margin: "0 0 8px" }}>The console failed to load</h1>
          <p style={{ fontSize: 13, opacity: 0.7, margin: "0 0 16px" }}>{error.digest ? `Reference ${error.digest}` : "Please try again."}</p>
          <button
            type="button"
            onClick={() => retry()}
            style={{ font: "inherit", fontSize: 13, padding: "6px 14px", borderRadius: 8, border: "1px solid rgba(127,127,127,0.4)", background: "transparent", color: "inherit", cursor: "pointer" }}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
