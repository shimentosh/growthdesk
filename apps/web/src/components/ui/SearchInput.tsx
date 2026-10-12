"use client";

import { Search, X } from "lucide-react";
import { useEffect, useRef, useState, type Ref } from "react";
import { cn } from "@/lib/cn";
import { controlClass, fullUnlessSized } from "./control";

export type SearchInputProps = {
  /** The committed search (e.g. from the URL). The box follows it when it changes from outside. */
  value?: string;
  /** Called with the text once typing pauses for `delay` ms, and immediately on clear / Enter. */
  onChange: (value: string) => void;
  delay?: number;
  placeholder?: string;
  size?: "sm" | "md";
  autoFocus?: boolean;
  "aria-label"?: string;
  className?: string;
  ref?: Ref<HTMLInputElement>;
};

/** A debounced search box. Escape clears it. */
export function SearchInput({
  value = "",
  onChange,
  delay = 300,
  placeholder = "Search…",
  size = "md",
  autoFocus,
  className,
  ref,
  ...aria
}: SearchInputProps) {
  const [text, setText] = useState(value);
  const committed = useRef(value);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  // Follow external changes (a "clear filters" button, back/forward navigation).
  useEffect(() => {
    if (value !== committed.current) {
      committed.current = value;
      setText(value);
    }
  }, [value]);

  useEffect(() => {
    if (text === committed.current) return;
    const t = setTimeout(() => {
      committed.current = text;
      onChangeRef.current(text);
    }, delay);
    return () => clearTimeout(t);
  }, [text, delay]);

  const commit = (next: string) => {
    setText(next);
    committed.current = next;
    onChangeRef.current(next);
  };

  return (
    <div className={cn("relative", fullUnlessSized(className), className)}>
      <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-text-3" />
      <input
        ref={ref}
        type="search"
        role="searchbox"
        value={text}
        autoFocus={autoFocus}
        placeholder={placeholder}
        aria-label={aria["aria-label"] ?? placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && text) {
            e.preventDefault();
            e.stopPropagation();
            commit("");
          } else if (e.key === "Enter") {
            commit(text);
          }
        }}
        className={cn(
          controlClass,
          "pr-7 pl-8 [&::-webkit-search-cancel-button]:appearance-none",
          size === "md" ? "h-8" : "h-7 text-xs",
        )}
      />
      {text && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => commit("")}
          className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded-xs p-0.5 text-text-3 hover:bg-hover hover:text-text"
        >
          <X aria-hidden className="size-3.5" />
        </button>
      )}
    </div>
  );
}
