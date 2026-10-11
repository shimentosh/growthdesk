"use client";

import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/DropdownMenu";
import { applyTheme, currentTheme, type ThemeChoice } from "@/lib/theme";

const CHOICES: { value: ThemeChoice; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

/** Light / dark / system, stored in the gd_theme cookie (shared with the customer app on the same host). */
export function ThemeToggle() {
  const [theme, setTheme] = useState<ThemeChoice>("system");
  // Read after mount: the server rendered the class from the same cookie.
  useEffect(() => setTheme(currentTheme()), []);
  const Current = CHOICES.find((c) => c.value === theme)?.icon ?? Monitor;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Appearance: ${theme}`}
        className="inline-flex size-8 items-center justify-center rounded-sm text-text-2 transition-colors hover:bg-hover hover:text-text"
      >
        <Current aria-hidden className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        <DropdownMenuLabel>Appearance</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={theme}
          onValueChange={(v) => {
            setTheme(v as ThemeChoice);
            applyTheme(v as ThemeChoice);
          }}
        >
          {CHOICES.map((c) => (
            <DropdownMenuRadioItem key={c.value} value={c.value}>
              <span className="flex items-center gap-2">
                <c.icon aria-hidden className="size-3.5 text-text-3" /> {c.label}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
