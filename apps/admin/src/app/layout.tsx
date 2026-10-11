import type { Metadata } from "next";
import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { asTheme, THEME_COOKIE, themeClass } from "@/lib/theme";
import { Providers } from "./providers";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Growthdesk Console", template: "%s · Growthdesk Console" },
  robots: { index: false, follow: false },
};

/** The theme class is rendered on the server from the gd_theme cookie, so the first paint is already right. */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const jar = await cookies();
  const theme = asTheme(jar.get(THEME_COOKIE)?.value);
  return (
    <html lang="en" className={themeClass(theme) || undefined} suppressHydrationWarning>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
