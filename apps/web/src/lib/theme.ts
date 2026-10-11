/*
 * Which appearance a person works in — a personal preference, so it lives in a
 * cookie (readable by the server, which renders the right class on <html> and
 * avoids a flash) rather than in any workspace setting.
 *
 *   light  → <html class="light">   pinned light
 *   dark   → <html class="dark">    pinned dark
 *   system → no class               globals.css follows prefers-color-scheme
 *
 * Ported from LinkDesk's lib/theme.ts; "system" needs no blocking script here
 * because the media query in globals.css already resolves it in CSS.
 */

export const THEME_COOKIE = "gd_theme";
export const THEME_MAX_AGE = 60 * 60 * 24 * 365;

export type ThemeChoice = "light" | "dark" | "system";
export const THEME_CHOICES: readonly ThemeChoice[] = ["light", "dark", "system"];
export const DEFAULT_THEME: ThemeChoice = "system";

export function asTheme(value: string | undefined | null): ThemeChoice {
  return THEME_CHOICES.includes(value as ThemeChoice) ? (value as ThemeChoice) : DEFAULT_THEME;
}

/** The class <html> carries for a choice ("" for system). */
export function themeClass(choice: ThemeChoice): string {
  return choice === "system" ? "" : choice;
}

/** Remember the choice (cookie, for the next server render) and apply it now. */
export function applyTheme(choice: ThemeChoice): void {
  if (typeof document === "undefined") return;
  document.cookie = `${THEME_COOKIE}=${choice}; path=/; max-age=${THEME_MAX_AGE}; samesite=lax`;
  const root = document.documentElement.classList;
  root.remove("light", "dark");
  if (choice !== "system") root.add(choice);
}

export function currentTheme(): ThemeChoice {
  if (typeof document === "undefined") return DEFAULT_THEME;
  const m = document.cookie.match(new RegExp(`(?:^|; )${THEME_COOKIE}=([^;]*)`));
  return asTheme(m?.[1] ? decodeURIComponent(m[1]) : undefined);
}
