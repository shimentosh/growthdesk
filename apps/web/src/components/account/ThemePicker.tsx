"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import { applyTheme, currentTheme, DEFAULT_THEME, type ThemeChoice } from "@/lib/theme";

const CHOICES: { value: ThemeChoice; label: string; Icon: typeof Sun }[] = [
  { value: "system", label: "System", Icon: Monitor },
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
];

/**
 * Light / dark / follow the system. A personal choice kept in a cookie on
 * this browser, applied at once — nothing to save.
 */
export function ThemePicker({ className }: { className?: string }) {
  // The cookie is only readable in the browser; read it after mount so the server render matches.
  const [theme, setTheme] = useState<ThemeChoice>(DEFAULT_THEME);
  useEffect(() => setTheme(currentTheme()), []);

  return (
    <div role="radiogroup" aria-label="Appearance" className={cn("inline-flex rounded-sm border border-line-strong bg-well p-0.5", className)}>
      {CHOICES.map(({ value, label, Icon }) => {
        const active = theme === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => {
              setTheme(value);
              applyTheme(value);
            }}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-xs px-3 text-sm transition-colors",
              active ? "bg-ctl-face font-medium text-text-hi shadow-sm" : "text-text-3 hover:text-text",
            )}
          >
            <Icon aria-hidden className="size-3.5" />
            {label}
          </button>
        );
      })}
    </div>
  );
}
