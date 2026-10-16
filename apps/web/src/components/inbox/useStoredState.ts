"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * useState that is remembered in localStorage under `key` (per browser). Read
 * after mount, so the server render and the first client render agree; values
 * that fail `valid` (or unreadable storage) fall back to `initial`. Writing
 * never throws: in a private window it simply is not remembered.
 */
export function useStoredState<T>(key: string, initial: T, valid: (v: unknown) => v is T): [T, (next: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(initial);
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw === null) return;
      const parsed: unknown = JSON.parse(raw);
      if (valid(parsed)) setValue(parsed);
    } catch {
      // Unreadable storage: keep the default.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read once per key
  }, [key]);
  const set = useCallback(
    (next: T | ((prev: T) => T)) =>
      setValue((prev) => {
        const v = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
        try {
          window.localStorage.setItem(key, JSON.stringify(v));
        } catch {
          // Not remembered; still applies for this visit.
        }
        return v;
      }),
    [key],
  );
  return [value, set];
}

export const isBoolean = (v: unknown): v is boolean => typeof v === "boolean";
export const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
