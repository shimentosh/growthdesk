"use client";

/*
 * The contacts table's state lives in the URL, so back/forward, reload and a
 * pasted link all land on the same rows:
 *
 *   ?q=acme&status=new,contacted&owner=me&tag=vip&hasEmail=yes&noNextAction=1
 *    &view=<savedViewId>&sort=fullName&dir=asc&page=2&pageSize=50
 *
 * `toFilter()` turns it into the ContactFilter JSON the API reads from the
 * `filter` query parameter.
 */

import { useCallback, useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  CONTACT_STATUSES,
  PRIORITIES,
  QUALIFICATIONS,
  SORTABLE_CONTACT_FIELDS,
  type ContactFilterT,
  type ContactStatus,
  type Priority,
  type Qualification,
} from "@growthdesk/shared";

export type SortField = (typeof SORTABLE_CONTACT_FIELDS)[number];
export type YesNo = "yes" | "no" | "";

export type ContactListState = {
  q: string;
  status: ContactStatus[];
  qualification: Qualification[];
  priority: Priority[];
  /** "me", "none", a user id, or "" for anyone. */
  owner: string;
  tag: string[];
  hasEmail: YesNo;
  hasPhone: YesNo;
  noNextAction: boolean;
  companyId: string;
  view: string;
  sort: SortField;
  dir: "asc" | "desc";
  page: number;
  pageSize: number;
};

export const DEFAULT_SORT: SortField = "createdAt";
export const DEFAULT_PAGE_SIZE = 50;
export const PAGE_SIZES = [25, 50, 100, 200];

/** The keys that narrow the rows (changing one drops the active saved view). */
export const FILTER_KEYS = ["q", "status", "qualification", "priority", "owner", "tag", "hasEmail", "hasPhone", "noNextAction", "companyId"] as const;

const list = <T extends string>(raw: string | null, allowed: readonly T[]): T[] =>
  (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is T => (allowed as readonly string[]).includes(s));

const yesNo = (raw: string | null): YesNo => (raw === "yes" || raw === "no" ? raw : "");

export function parseState(sp: URLSearchParams): ContactListState {
  const sort = sp.get("sort") ?? "";
  const page = Number(sp.get("page"));
  const pageSize = Number(sp.get("pageSize"));
  return {
    q: sp.get("q") ?? "",
    status: list(sp.get("status"), CONTACT_STATUSES),
    qualification: list(sp.get("qualification"), QUALIFICATIONS),
    priority: list(sp.get("priority"), PRIORITIES),
    owner: sp.get("owner") ?? "",
    tag: (sp.get("tag") ?? "").split(",").map((t) => t.trim()).filter(Boolean),
    hasEmail: yesNo(sp.get("hasEmail")),
    hasPhone: yesNo(sp.get("hasPhone")),
    noNextAction: sp.get("noNextAction") === "1",
    companyId: sp.get("companyId") ?? "",
    view: sp.get("view") ?? "",
    sort: (SORTABLE_CONTACT_FIELDS as readonly string[]).includes(sort) ? (sort as SortField) : DEFAULT_SORT,
    dir: sp.get("dir") === "asc" ? "asc" : "desc",
    page: Number.isInteger(page) && page > 0 ? page : 1,
    pageSize: PAGE_SIZES.includes(pageSize) ? pageSize : DEFAULT_PAGE_SIZE,
  };
}

/** The ContactFilter the API expects, with empty parts left out (undefined when nothing narrows). */
export function toFilter(s: ContactListState): ContactFilterT | undefined {
  const f: Record<string, unknown> = {};
  if (s.q.trim()) f.q = s.q.trim();
  if (s.status.length) f.status = s.status;
  if (s.qualification.length) f.qualification = s.qualification;
  if (s.priority.length) f.priority = s.priority;
  if (s.owner) f.ownerId = s.owner;
  if (s.tag.length) f.tag = s.tag;
  if (s.hasEmail) f.hasEmail = s.hasEmail === "yes";
  if (s.hasPhone) f.hasPhone = s.hasPhone === "yes";
  if (s.noNextAction) f.noNextAction = true;
  if (s.companyId) f.companyId = s.companyId;
  return Object.keys(f).length ? (f as ContactFilterT) : undefined;
}

/** The reverse, for applying a saved view's stored filters to the URL. Unknown keys are ignored. */
export function fromFilter(filters: Record<string, unknown>): Partial<ContactListState> {
  const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const bool = (v: unknown): YesNo => (v === true ? "yes" : v === false ? "no" : "");
  return {
    q: typeof filters.q === "string" ? filters.q : "",
    status: list(arr(filters.status).join(","), CONTACT_STATUSES),
    qualification: list(arr(filters.qualification).join(","), QUALIFICATIONS),
    priority: list(arr(filters.priority).join(","), PRIORITIES),
    owner: typeof filters.ownerId === "string" ? filters.ownerId : "",
    tag: arr(filters.tag),
    hasEmail: bool(filters.hasEmail),
    hasPhone: bool(filters.hasPhone),
    noNextAction: filters.noNextAction === true,
    companyId: typeof filters.companyId === "string" ? filters.companyId : "",
  };
}

/** How many filters (not search, not view) are on — the number on the Filters button. */
export function activeFilterCount(s: ContactListState): number {
  return (
    (s.status.length ? 1 : 0) +
    (s.qualification.length ? 1 : 0) +
    (s.priority.length ? 1 : 0) +
    (s.owner ? 1 : 0) +
    (s.tag.length ? 1 : 0) +
    (s.hasEmail ? 1 : 0) +
    (s.hasPhone ? 1 : 0) +
    (s.noNextAction ? 1 : 0) +
    (s.companyId ? 1 : 0)
  );
}

function serialize(s: ContactListState): string {
  const p = new URLSearchParams();
  const set = (k: string, v: string) => {
    if (v) p.set(k, v);
  };
  set("q", s.q.trim());
  set("status", s.status.join(","));
  set("qualification", s.qualification.join(","));
  set("priority", s.priority.join(","));
  set("owner", s.owner);
  set("tag", s.tag.join(","));
  set("hasEmail", s.hasEmail);
  set("hasPhone", s.hasPhone);
  if (s.noNextAction) p.set("noNextAction", "1");
  set("companyId", s.companyId);
  set("view", s.view);
  if (s.sort !== DEFAULT_SORT) p.set("sort", s.sort);
  if (s.dir !== "desc") p.set("dir", s.dir);
  if (s.page > 1) p.set("page", String(s.page));
  if (s.pageSize !== DEFAULT_PAGE_SIZE) p.set("pageSize", String(s.pageSize));
  return p.toString();
}

/**
 * The parsed state and a setter. Any change to a filter goes back to page 1
 * and leaves the saved view (its rows no longer match what it stores).
 * `replace` updates the URL without a history entry (typing in search).
 */
export function useContactListState() {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const state = useMemo(() => parseState(new URLSearchParams(sp.toString())), [sp]);

  const update = useCallback(
    (patch: Partial<ContactListState>, opts: { replace?: boolean } = {}) => {
      const next = { ...state, ...patch };
      const touchesFilter = FILTER_KEYS.some((k) => k in patch);
      if (touchesFilter) {
        if (!("page" in patch)) next.page = 1;
        if (!("view" in patch)) next.view = "";
      }
      if (("sort" in patch || "dir" in patch || "pageSize" in patch) && !("page" in patch)) next.page = 1;
      const qs = serialize(next);
      const href = qs ? `${pathname}?${qs}` : pathname;
      if (opts.replace) router.replace(href, { scroll: false });
      else router.push(href, { scroll: false });
    },
    [state, router, pathname],
  );

  const clearFilters = useCallback(
    () =>
      update({
        q: "",
        status: [],
        qualification: [],
        priority: [],
        owner: "",
        tag: [],
        hasEmail: "",
        hasPhone: "",
        noNextAction: false,
        companyId: "",
      }),
    [update],
  );

  return { state, update, clearFilters };
}
