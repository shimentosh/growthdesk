"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Asks before unsaved edits are lost: the browser's own prompt for reloads
 * and closing the tab, and `pending` (an href) for in-app links, which the
 * caller turns into a confirm dialog — `leave()` then goes there.
 */
export function useLeaveGuard(dirty: boolean) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);

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
      setPending(url.pathname + url.search + url.hash);
    };
    window.addEventListener("beforeunload", warn);
    document.addEventListener("click", click, true);
    return () => {
      window.removeEventListener("beforeunload", warn);
      document.removeEventListener("click", click, true);
    };
  }, [dirty]);

  return {
    pending,
    stay: () => setPending(null),
    leave: () => {
      const to = pending;
      setPending(null);
      if (to) router.push(to);
    },
  };
}
