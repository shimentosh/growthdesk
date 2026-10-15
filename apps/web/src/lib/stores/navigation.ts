import { create } from "zustand";

/*
 * Client-side navigation state: which route the person just asked for, while
 * Next is still fetching it. Server data stays in TanStack Query (lib/query);
 * this store only holds UI state that several distant components share —
 * the top progress bar, and the sidebar / settings menu highlighting the
 * clicked item before the page has arrived.
 *
 * Started by a same-origin link click (components/shell/NavigationProgress)
 * or by code that navigates (`navigation.start(href)` before `router.push`);
 * finished when the URL actually changes, or after a safety timeout.
 */

type NavigationState = {
  /** The pathname being navigated to, or null when idle. */
  pendingPath: string | null;
  startedAt: number;
  start: (href: string) => void;
  done: () => void;
};

/** Long enough for a cold dev compile; a navigation that never lands stops spinning after this. */
const GIVE_UP_MS = 20_000;
let giveUp: ReturnType<typeof setTimeout> | null = null;

export const useNavigationStore = create<NavigationState>()((set) => ({
  pendingPath: null,
  startedAt: 0,
  start: (href) => {
    let path: string;
    try {
      path = new URL(href, window.location.href).pathname;
    } catch {
      return;
    }
    if (giveUp) clearTimeout(giveUp);
    giveUp = setTimeout(() => set({ pendingPath: null }), GIVE_UP_MS);
    set({ pendingPath: path, startedAt: Date.now() });
  },
  done: () => {
    if (giveUp) clearTimeout(giveUp);
    giveUp = null;
    set({ pendingPath: null });
  },
}));

/** For code outside React (and handlers): `navigation.start(href); router.push(href)`. */
export const navigation = {
  start: (href: string) => useNavigationStore.getState().start(href),
  done: () => useNavigationStore.getState().done(),
};

/**
 * The path a menu should treat as current: the one being opened, else the real
 * one — so a click highlights its item at once, the way an app does.
 */
export function useActivePath(pathname: string): string {
  const pending = useNavigationStore((s) => s.pendingPath);
  return pending ?? pathname;
}
