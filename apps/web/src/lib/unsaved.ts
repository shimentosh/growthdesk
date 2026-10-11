"use client";

/*
 * Router-level unsaved-changes guard. An editor calls
 * `useUnsavedChanges(dirty, "Your changes to this workflow will be lost.")`;
 * while any registered editor is dirty, <UnsavedChangesGuard/> (mounted once
 * in the root providers) asks before the page is left:
 *   - reload / close tab / typed URL → the browser's own prompt (beforeunload)
 *   - any same-origin link (sidebar, breadcrumbs, top bar, in-page links) → a confirm dialog
 * Programmatic `router.push` after a save is not intercepted: callers navigate
 * on purpose, once their edits are stored.
 */
import { useEffect, useId } from "react";

type Listener = () => void;

const DEFAULT_MESSAGE = "Your unsaved changes will be lost.";
const dirtyGuards = new Map<string, string>();
const listeners = new Set<Listener>();
const emit = () => listeners.forEach((l) => l());

export const unsavedStore = {
  subscribe(listener: Listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  /** True while some editor on the page has unsaved edits. */
  isDirty: () => dirtyGuards.size > 0,
  /** The message of the most recently registered dirty editor. */
  message: () => [...dirtyGuards.values()].at(-1) ?? DEFAULT_MESSAGE,
  /** Forget every guard (the person chose to leave). */
  clear() {
    dirtyGuards.clear();
    emit();
  },
};

/** Registers an editor's dirty state with the page-leave guard. */
export function useUnsavedChanges(dirty: boolean, message = DEFAULT_MESSAGE) {
  const id = useId();
  useEffect(() => {
    if (!dirty) return;
    dirtyGuards.set(id, message);
    emit();
    return () => {
      dirtyGuards.delete(id);
      emit();
    };
  }, [id, dirty, message]);
}
