/*
 * Optional browser error reporting. NEXT_PUBLIC_SENTRY_DSN is inlined at build
 * time: when it is unset the condition is constant-false and the bundler drops
 * the Sentry import entirely, so a build without it ships no Sentry code.
 */

if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  void import("@sentry/nextjs").then((Sentry) =>
    Sentry.init({
      dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
      environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
      sendDefaultPii: false,
      initialScope: { tags: { service: "web-browser" } },
    }),
  );
}

export {};
