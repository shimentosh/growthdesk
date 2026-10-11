"use client";

/*
 * Who is signed in, and which workspace they are in.
 *
 *   const me = useMe();                 // query: { user, workspaces, lastWorkspaceId }
 *   const ws = useWorkspace();          // inside /w/[workspaceId]/… only
 *   ws.can("contacts.write")            // any-of when given an array
 *   ws.path("/contacts")                // API path  → /workspaces/:id/contacts
 *   ws.href("/contacts")                // app link  → /w/:id/contacts
 *   ws.key("contacts", "list")          // query key → ["ws", id, "contacts", "list"]
 *   const f = useFormat();              // dates/money in the workspace's zone & currency
 *
 * Permissions come from the API (GET /workspaces/:id → permissions), which
 * is the same list the server enforces. Hiding a control is a courtesy; the
 * API refuses regardless.
 */

import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { QueryKey } from "@tanstack/react-query";
import type { FeatureKey } from "@growthdesk/shared";
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
import { useApiQuery, wsKey } from "./query";
import type { Me, WorkspaceDetail } from "./types";

export const ME_KEY: QueryKey = ["me"];

/** The signed-in person and their workspaces. 401 → the api layer sends them to /login (except on public pages). */
export function useMe() {
  return useApiQuery<Me>(ME_KEY, "/auth/me", { staleTime: 60_000 });
}

export const workspaceDetailKey = (workspaceId: string): QueryKey => wsKey(workspaceId, "detail");

/** The raw workspace query. The shell uses it; pages use useWorkspace(). */
export function useWorkspaceDetailQuery(workspaceId: string) {
  return useApiQuery<WorkspaceDetail>(workspaceDetailKey(workspaceId), `/workspaces/${workspaceId}`, { staleTime: 60_000 });
}

export type WorkspaceContextValue = {
  id: string;
  name: string;
  slug: string;
  role: WorkspaceDetail["role"];
  permissions: string[];
  /** True when the role holds the permission (any of them, for an array). */
  can: (permission: string | readonly string[]) => boolean;
  /** True when the current plan includes the feature. */
  hasFeature: (feature: FeatureKey) => boolean;
  plan: WorkspaceDetail["plan"];
  timezone: string;
  currency: string;
  status: string;
  suspendedReason: string | null;
  settings: Record<string, unknown>;
  onboarding: WorkspaceDetail["onboarding"];
  detail: WorkspaceDetail;
  /** API path under this workspace: path("/contacts") → "/workspaces/:id/contacts". */
  path: (sub?: string) => string;
  /** App link under this workspace: href("/contacts") → "/w/:id/contacts". */
  href: (sub?: string) => string;
  /** Query key under this workspace: key("contacts") → ["ws", id, "contacts"]. */
  key: (...parts: unknown[]) => QueryKey;
};

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

const join = (base: string, sub?: string) => (sub ? `${base}${sub.startsWith("/") ? "" : "/"}${sub}` : base);

export function WorkspaceProvider({ detail, children }: { detail: WorkspaceDetail; children: ReactNode }) {
  const value = useMemo<WorkspaceContextValue>(() => {
    const held = new Set(detail.permissions);
    return {
      id: detail.id,
      name: detail.name,
      slug: detail.slug,
      role: detail.role,
      permissions: detail.permissions,
      can: (p) => (typeof p === "string" ? held.has(p) : p.some((x) => held.has(x))),
      hasFeature: (f) => Boolean(detail.plan.features?.[f]),
      plan: detail.plan,
      timezone: detail.timezone,
      currency: detail.currency,
      status: detail.status,
      suspendedReason: detail.suspendedReason,
      settings: detail.settings ?? {},
      onboarding: detail.onboarding,
      detail,
      path: (sub) => join(`/workspaces/${detail.id}`, sub),
      href: (sub) => join(`/w/${detail.id}`, sub),
      key: (...parts) => wsKey(detail.id, ...parts),
    };
  }, [detail]);
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

/** The current workspace. Only valid under /w/[workspaceId]. */
export function useWorkspace(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace() must be used inside a workspace page (/w/[workspaceId]/…)");
  return ctx;
}

/** The current workspace, or null outside one (shared components that work in both places). */
export function useOptionalWorkspace(): WorkspaceContextValue | null {
  return useContext(WorkspaceContext);
}

/** Renders children only when the role holds the permission (any-of for arrays). */
export function Can({ permission, children, fallback = null }: { permission: string | readonly string[]; children: ReactNode; fallback?: ReactNode }) {
  const ws = useWorkspace();
  return <>{ws.can(permission) ? children : fallback}</>;
}

/** Date and money formatters bound to the workspace's time zone and currency (browser zone outside a workspace). */
export function useFormat() {
  const ws = useOptionalWorkspace();
  const timeZone = ws?.timezone ?? browserTimeZone();
  const currency = ws?.currency ?? "USD";
  return useMemo(
    () => ({
      timeZone,
      currency,
      date: (v: DateInput, style?: "short" | "medium" | "long") => formatDate(v, { timeZone, style }),
      time: (v: DateInput) => formatTime(v, { timeZone }),
      dateTime: (v: DateInput) => formatDateTime(v, { timeZone }),
      smart: (v: DateInput) => formatSmartDate(v, { timeZone }),
      relative: (v: DateInput) => formatRelative(v, { timeZone }),
      /** Major units (deal values). For cents use formatMoney from @growthdesk/shared. */
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
