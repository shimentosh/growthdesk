"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { unsavedStore } from "@/lib/unsaved";

/**
 * The host for `useUnsavedChanges`: mounted once (root providers). While any
 * editor is dirty it adds the browser's leave prompt and catches same-origin
 * link clicks — the sidebar included — before Next's router sees them.
 */
export function UnsavedChangesGuard() {
  const router = useRouter();
  const dirty = useSyncExternalStore(unsavedStore.subscribe, unsavedStore.isDirty, () => false);
  const [pending, setPending] = useState<{ to: string; message: string } | null>(null);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    // Capture phase, so the link's own (Next) handler never sees the click.
    const click = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]");
      if (!(a instanceof HTMLAnchorElement) || a.target === "_blank" || a.hasAttribute("download")) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      e.preventDefault();
      e.stopPropagation();
      setPending({ to: url.pathname + url.search + url.hash, message: unsavedStore.message() });
    };
    window.addEventListener("beforeunload", warn);
    document.addEventListener("click", click, true);
    return () => {
      window.removeEventListener("beforeunload", warn);
      document.removeEventListener("click", click, true);
    };
  }, [dirty]);

  return (
    <ConfirmDialog
      open={pending !== null}
      onOpenChange={(o) => {
        if (!o) setPending(null);
      }}
      title="Leave without saving?"
      description={pending?.message}
      confirmLabel="Leave"
      cancelLabel="Keep editing"
      onConfirm={() => {
        const to = pending?.to;
        setPending(null);
        unsavedStore.clear();
        if (to) router.push(to);
      }}
    />
  );
}
