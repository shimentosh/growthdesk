"use client";

/*
 * Who is signed in. A slimmed copy of apps/web/src/lib/session.tsx: the
 * operator console has no workspace context, so dates are shown in the
 * browser's time zone and money defaults to USD.
 *
 *   const me = useMe();      // query: { user, workspaces, lastWorkspaceId }
 *   const f = useFormat();   // dates/money in the browser's zone
 */

import { useMemo } from "react";
import type { QueryKey } from "@tanstack/react-query";
import { post } from "./api";
import {
  browserTimeZone,
  formatCurrency,
  formatDate,
  formatDateTime,
  formatRelative,
  formatSmartDate,
  formatTime,
  type DateInput,
} from "./format";
import { useApiQuery } from "./query";
import type { Me } from "./types";

export const ME_KEY: QueryKey = ["me"];

/** The signed-in person. 401 → the api layer sends them to /login (except on /login itself). */
export function useMe() {
  return useApiQuery<Me>(ME_KEY, "/auth/me", { staleTime: 60_000 });
}

/** Date and money formatters bound to the browser's time zone. */
export function useFormat() {
  const timeZone = browserTimeZone();
  const currency = "USD";
  return useMemo(
    () => ({
      timeZone,
      currency,
      date: (v: DateInput, style?: "short" | "medium" | "long") => formatDate(v, { timeZone, style }),
      time: (v: DateInput) => formatTime(v, { timeZone }),
      dateTime: (v: DateInput) => formatDateTime(v, { timeZone }),
      smart: (v: DateInput) => formatSmartDate(v, { timeZone }),
      relative: (v: DateInput) => formatRelative(v, { timeZone }),
      /** Major units. For cents use formatMoney from @growthdesk/shared. */
      money: (amount: number | null | undefined, code?: string) => formatCurrency(amount, code ?? currency),
    }),
    [timeZone, currency],
  );
}

/** Signs out and reloads into /login, which also drops every cached query. */
export async function signOut() {
  try {
    await post("/auth/logout", undefined, { noAuthRedirect: true });
  } finally {
    window.location.assign("/login");
  }
}
