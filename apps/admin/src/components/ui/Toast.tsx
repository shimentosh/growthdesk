"use client";

import Link from "next/link";
import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from "lucide-react";
import { messageOf } from "@/lib/api";
import { cn } from "@/lib/cn";

/*
 * Toasts: a tiny module-level store (no provider needed to *raise* one) and a
 * <Toaster/> mounted once in the root providers.
 *
 *   toast.success("Contact saved")
 *   toast.error(error)                      // ApiError / Error / string
 *   toast.info("Import started", { description: "We'll notify you when it finishes." })
 *   toast("Copied")                          // neutral
 *
 * At most four are on screen (the oldest goes first); each dismisses itself
 * (errors stay longer) and pauses while hovered.
 */

export type ToastTone = "neutral" | "ok" | "info" | "warn" | "bad";

export type ToastAction = { label: string; href?: string; onClick?: () => void };

export type ToastOptions = {
  tone?: ToastTone;
  description?: ReactNode;
  action?: ToastAction;
  /** Milliseconds on screen. Default 4500 (7000 for errors). 0 keeps it until dismissed. */
  duration?: number;
};

type ToastItem = Required<Pick<ToastOptions, "tone" | "duration">> & {
  id: number;
  title: ReactNode;
  description?: ReactNode;
  action?: ToastAction;
};

const MAX = 4;
let items: ToastItem[] = [];
let seq = 0;
const listeners = new Set<() => void>();
const EMPTY: ToastItem[] = [];

function emit() {
  listeners.forEach((l) => l());
}

function push(title: ReactNode, options: ToastOptions = {}): number {
  const tone = options.tone ?? "neutral";
  const item: ToastItem = {
    id: ++seq,
    title,
    tone,
    description: options.description,
    action: options.action,
    duration: options.duration ?? (tone === "bad" ? 7000 : 4500),
  };
  items = [...items, item].slice(-MAX);
  emit();
  return item.id;
}

function dismiss(id?: number) {
  items = id === undefined ? [] : items.filter((t) => t.id !== id);
  emit();
}

type ToastFn = ((title: ReactNode, options?: ToastOptions) => number) & {
  success: (title: ReactNode, options?: Omit<ToastOptions, "tone">) => number;
  info: (title: ReactNode, options?: Omit<ToastOptions, "tone">) => number;
  warn: (title: ReactNode, options?: Omit<ToastOptions, "tone">) => number;
  /** Accepts anything thrown: shows its message. */
  error: (error: unknown, options?: Omit<ToastOptions, "tone">) => number;
  dismiss: (id?: number) => void;
};

export const toast: ToastFn = Object.assign((title: ReactNode, options?: ToastOptions) => push(title, options), {
  success: (title: ReactNode, options?: Omit<ToastOptions, "tone">) => push(title, { ...options, tone: "ok" }),
  info: (title: ReactNode, options?: Omit<ToastOptions, "tone">) => push(title, { ...options, tone: "info" }),
  warn: (title: ReactNode, options?: Omit<ToastOptions, "tone">) => push(title, { ...options, tone: "warn" }),
  error: (error: unknown, options?: Omit<ToastOptions, "tone">) =>
    push(typeof error === "string" ? error : messageOf(error), { ...options, tone: "bad" }),
  dismiss,
});

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

const TONE: Record<ToastTone, { edge: string; wash: string; icon: ReactNode }> = {
  neutral: { edge: "border-line-strong", wash: "", icon: null },
  ok: { edge: "border-ok-edge", wash: "bg-ok-wash", icon: <CircleCheck className="size-4 text-ok-ink" aria-hidden /> },
  info: { edge: "border-info-edge", wash: "bg-info-wash", icon: <Info className="size-4 text-accent-ink" aria-hidden /> },
  warn: { edge: "border-warn-edge", wash: "bg-warn-wash", icon: <TriangleAlert className="size-4 text-warn-ink" aria-hidden /> },
  bad: { edge: "border-bad-edge", wash: "bg-bad-wash", icon: <CircleAlert className="size-4 text-bad-ink" aria-hidden /> },
};

function ToastView({ item }: { item: ToastItem }) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const start = () => {
    if (!item.duration) return;
    timer.current = setTimeout(() => dismiss(item.id), item.duration);
  };
  const stop = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  useEffect(() => {
    start();
    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);

  const tone = TONE[item.tone];
  return (
    // The wash is a translucent tint, so it sits on an opaque popover layer.
    <div
      role={item.tone === "bad" ? "alert" : "status"}
      onMouseEnter={stop}
      onMouseLeave={start}
      onFocus={stop}
      onBlur={start}
      className={cn("pointer-events-auto w-full overflow-hidden rounded-md border bg-popover shadow-lg animate-toast-in", tone.edge)}
    >
     <div className={cn("flex items-start gap-2.5 px-3 py-2.5", tone.wash)}>
      {tone.icon && <span className="mt-0.5 shrink-0">{tone.icon}</span>}
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-text">{item.title}</div>
        {item.description && <div className="mt-0.5 text-xs text-text-2">{item.description}</div>}
        {item.action && (
          <div className="mt-1.5">
            {item.action.href ? (
              <Link
                href={item.action.href}
                onClick={() => {
                  item.action?.onClick?.();
                  dismiss(item.id);
                }}
                className="text-xs font-semibold text-accent-hi hover:text-accent"
              >
                {item.action.label}
              </Link>
            ) : (
              <button
                type="button"
                onClick={() => {
                  item.action?.onClick?.();
                  dismiss(item.id);
                }}
                className="text-xs font-semibold text-accent-hi hover:text-accent"
              >
                {item.action.label}
              </button>
            )}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={() => dismiss(item.id)}
        aria-label="Dismiss notification"
        className="-mr-1 shrink-0 rounded-xs p-0.5 text-text-3 hover:bg-hover hover:text-text"
      >
        <X className="size-3.5" aria-hidden />
      </button>
     </div>
    </div>
  );
}

/** Mounted once, in the root providers. */
export function Toaster() {
  const list = useSyncExternalStore(subscribe, () => items, () => EMPTY);
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-3 bottom-3 z-[100] flex flex-col items-end gap-2 sm:inset-x-auto sm:right-4 sm:bottom-4 sm:w-[360px]"
    >
      {list.map((t) => (
        <ToastView key={t.id} item={t} />
      ))}
    </div>
  );
}
