"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { navigation, useNavigationStore } from "@/lib/stores/navigation";

/*
 * A thin bar across the top of the window while a page is on its way, so a
 * click always answers at once. Starts on a same-origin link click that goes
 * somewhere new (bubble phase: UnsavedChangesGuard's capture handler stops
 * clicks it holds, and those never reach here), finishes when the URL changes.
 * Mounted once, in the root providers.
 *
 * Quick navigations (under 120 ms, e.g. a cached page) never show the bar.
 */

const SHOW_AFTER_MS = 120;

function isPlainNavigation(e: MouseEvent): string | null {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return null;
  const a = (e.target as Element | null)?.closest?.("a[href]");
  if (!(a instanceof HTMLAnchorElement)) return null;
  if ((a.target && a.target !== "_self") || a.hasAttribute("download") || a.dataset.noProgress !== undefined) return null;
  let url: URL;
  try {
    url = new URL(a.href, window.location.href);
  } catch {
    return null;
  }
  if (url.origin !== window.location.origin) return null;
  // The API proxy and static files are not pages.
  if (url.pathname.startsWith("/api/") || /\.[a-z0-9]+$/i.test(url.pathname)) return null;
  if (url.pathname === window.location.pathname && url.search === window.location.search) return null;
  return url.href;
}

export function NavigationProgress() {
  const pathname = usePathname();
  const search = useSearchParams();
  const pending = useNavigationStore((s) => s.pendingPath);
  const [visible, setVisible] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const shown = useRef(false);

  // Start on link clicks.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const href = isPlainNavigation(e);
      if (href) navigation.start(href);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  // Back / forward.
  useEffect(() => {
    const onPop = () => navigation.start(window.location.href);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // The URL changed: the new page is in.
  const url = `${pathname}?${search.toString()}`;
  useEffect(() => {
    navigation.done();
  }, [url]);

  // Show only if it takes a moment; on finish, run to 100% and fade.
  useEffect(() => {
    if (pending) {
      setFinishing(false);
      const t = setTimeout(() => {
        shown.current = true;
        setVisible(true);
      }, SHOW_AFTER_MS);
      return () => clearTimeout(t);
    }
    if (!shown.current) return;
    shown.current = false;
    setFinishing(true);
    const t = setTimeout(() => {
      setVisible(false);
      setFinishing(false);
    }, 320);
    return () => clearTimeout(t);
  }, [pending]);

  if (!visible) return null;
  return (
    <div
      role="progressbar"
      aria-label="Loading page"
      aria-busy={!finishing}
      className="pointer-events-none fixed inset-x-0 top-0 z-[100] h-[2px] overflow-hidden"
      style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
    >
      <div className={finishing ? "gd-nav-bar gd-nav-bar-done" : "gd-nav-bar"} />
    </div>
  );
}
