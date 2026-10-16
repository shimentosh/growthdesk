"use client";

import { Popover as P } from "radix-ui";
import { Check, ChevronDown, SearchX } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { useFieldControl } from "./Field";
import { sizedControlClass } from "./control";
import { SearchInput } from "./SearchInput";

export type SelectOption<V extends string = string> = {
  value: V;
  label: ReactNode;
  disabled?: boolean;
  description?: ReactNode;
  /** Options sharing a group are listed under its heading (in the order given). */
  group?: string;
  /** Plain text for search and type-ahead when `label` is not a string. */
  text?: string;
};

export type SelectProps<V extends string = string> = {
  value: V | undefined;
  onValueChange: (value: V) => void;
  options: SelectOption<V>[];
  placeholder?: string;
  disabled?: boolean;
  size?: "sm" | "md";
  invalid?: boolean;
  /** Show a search box above the list (default: when there are more than 12 options). */
  searchable?: boolean;
  id?: string;
  name?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  className?: string;
  /** A small muted icon before the chosen value (filter bars), e.g. <Building2 />. */
  icon?: ReactNode;
};

const SEARCH_AFTER = 12;

const textOf = (node: ReactNode): string => {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "object" && "props" in node) return textOf((node.props as { children?: ReactNode }).children);
  return "";
};

/**
 * The app's one dropdown: a button that opens a styled list. Keyboard: arrows,
 * Home/End, Enter, Escape, type-ahead; long lists get a search box. Any string
 * is a valid value, "" included (a placeholder value shows muted).
 */
export function Select<V extends string = string>({
  value,
  onValueChange,
  options,
  placeholder = "Choose…",
  disabled,
  size = "md",
  invalid,
  searchable,
  id,
  name,
  className,
  icon,
  ...aria
}: SelectProps<V>) {
  const field = useFieldControl({ id, invalid, "aria-describedby": aria["aria-describedby"] });
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const listRef = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: "", at: 0 });

  const withSearch = searchable ?? options.length > SEARCH_AFTER;
  const current = options.find((o) => o.value === value);
  const muted = !current || (value === "" && current.label === placeholder);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => (o.text ?? textOf(o.label)).toLowerCase().includes(q) || textOf(o.description).toLowerCase().includes(q));
  }, [options, query]);

  // Open on the chosen option, or the first one that can be chosen.
  useEffect(() => {
    if (!open) return;
    const at = shown.findIndex((o) => o.value === value && !o.disabled);
    setActive(at >= 0 && !query ? at : shown.findIndex((o) => !o.disabled));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the list opens or the search changes
  }, [open, query]);

  useEffect(() => {
    if (active < 0) return;
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (o: SelectOption<V> | undefined) => {
    if (!o || o.disabled) return;
    setOpen(false);
    if (o.value !== value) onValueChange(o.value);
  };

  const step = (from: number, dir: 1 | -1) => {
    for (let i = from + dir; i >= 0 && i < shown.length; i += dir) if (!shown[i]?.disabled) return i;
    return from;
  };

  const onListKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") setActive((a) => step(a, 1));
    else if (e.key === "ArrowUp") setActive((a) => step(a, -1));
    else if (e.key === "Home" && !withSearch) setActive(step(-1, 1));
    else if (e.key === "End" && !withSearch) setActive(step(shown.length, -1));
    else if (e.key === "Enter" || (e.key === " " && !withSearch)) choose(shown[active]);
    else if (e.key === "Tab") setOpen(false);
    else if (!withSearch && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const now = Date.now();
      typed.current = { text: (now - typed.current.at > 600 ? "" : typed.current.text) + e.key.toLowerCase(), at: now };
      const t = typed.current.text;
      const order = [...shown.keys()].slice(active + (t.length === 1 ? 1 : 0)).concat([...shown.keys()]);
      const hit = order.find((i) => { const o = shown[i]; return Boolean(o && !o.disabled && (o.text ?? textOf(o.label)).toLowerCase().startsWith(t)); });
      if (hit !== undefined) setActive(hit);
      else return;
    } else return;
    e.preventDefault();
  };

  return (
    <P.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQuery("");
      }}
    >
      <P.Trigger
        type="button"
        disabled={disabled}
        {...field}
        aria-label={aria["aria-label"]}
        aria-haspopup="listbox"
        aria-controls={open ? listId : undefined}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className={cn(
          sizedControlClass(className),
          "group inline-flex items-center justify-between gap-2 text-left outline-none hover:border-text-3/40 data-[state=open]:border-accent",
          size === "md" ? "h-8 pr-2 pl-2.5" : "h-7 pr-1.5 pl-2 text-xs",
          muted && "text-text-3",
          className,
        )}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          {icon && <span aria-hidden className="inline-flex shrink-0 text-text-3 [&_svg]:size-3.5">{icon}</span>}
          <span className="truncate">{current ? current.label : placeholder}</span>
        </span>
        <ChevronDown aria-hidden className="size-3.5 shrink-0 text-text-3 transition-transform duration-150 group-data-[state=open]:rotate-180" />
      </P.Trigger>
      {name && <input type="hidden" name={name} value={value ?? ""} />}
      <P.Portal>
        <P.Content
          align="start"
          sideOffset={4}
          collisionPadding={8}
          onOpenAutoFocus={(e) => {
            if (withSearch) return;
            e.preventDefault();
            listRef.current?.focus();
          }}
          onKeyDown={onListKey}
          className="z-[70] flex max-h-[min(340px,var(--radix-popover-content-available-height))] w-[var(--radix-popover-trigger-width)] min-w-44 flex-col overflow-hidden rounded-md border border-line-strong bg-popover shadow-lg outline-none animate-pop-in"
        >
          {withSearch && (
            <div className="border-b border-line p-1.5">
              <SearchInput value={query} onChange={setQuery} delay={0} size="sm" autoFocus placeholder="Search…" />
            </div>
          )}
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            tabIndex={-1}
            aria-label={aria["aria-label"]}
            aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
            className="min-h-0 flex-1 overflow-y-auto p-1 outline-none"
          >
            {shown.length === 0 ? (
              <div className="flex flex-col items-center gap-1.5 px-2 py-5 text-center text-xs text-text-3">
                <SearchX aria-hidden className="size-4" />
                No matches
              </div>
            ) : (
              shown.map((o, i) => {
                const selected = o.value === value;
                const heading = o.group && o.group !== shown[i - 1]?.group ? o.group : null;
                return (
                  <div key={`${o.group ?? ""}:${o.value}`}>
                    {heading && <div className={cn("px-2 pt-2 pb-1 text-2xs font-medium tracking-wide text-text-3 uppercase", i > 0 && "mt-1 border-t border-line")}>{heading}</div>}
                    <div
                      id={`${listId}-${i}`}
                      data-index={i}
                      role="option"
                      aria-selected={selected}
                      aria-disabled={o.disabled || undefined}
                      onPointerMove={() => !o.disabled && active !== i && setActive(i)}
                      onClick={() => choose(o)}
                      className={cn(
                        "flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-text select-none",
                        i === active && "bg-hover",
                        selected && "font-medium",
                        o.disabled && "opacity-45",
                      )}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{o.label}</span>
                        {o.description && <span className="block text-xs font-normal text-text-3">{o.description}</span>}
                      </span>
                      <Check aria-hidden className={cn("size-3.5 shrink-0 text-accent", !selected && "invisible")} />
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </P.Content>
      </P.Portal>
    </P.Root>
  );
}
