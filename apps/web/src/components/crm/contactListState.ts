"use client";

/*
 * The contacts table's state lives in the URL, so back/forward, reload and a
 * pasted link all land on the same rows:
 *
 *   ?q=acme&status=new,contacted&owner=me&tag=vip&hasEmail=yes&noNextAction=1
 *    &source=Clientdesk%20%C2%B7%20Website&source=-   (one per source; "-" = none recorded)
 *    &view=<savedViewId>&sort=fullName&dir=asc&page=2&pageSize=50
 *    &stage=lead,sales&list=<listId>&archived=only
 *
 * `stage` has a per-page default (Contacts shows contacts, Leads shows leads):
 * absent means that default, and "all" means every stage.
 *
 * `toFilter()` turns it into the ContactFilter JSON the API reads from the
 * `filter` query parameter.
 */

import { useCallback, useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  CONTACT_STATUSES,
  LIFECYCLE_STAGES,
  PRIORITIES,
  QUALIFICATIONS,
  SORTABLE_CONTACT_FIELDS,
  type ContactFilterT,
  type ContactStatus,
  type LifecycleStage,
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
  /** Lead sources (contact.leadSource, case ignored); "" = no source recorded. */
  source: string[];
  /** Orders from the connected client portal: none placed, bought (one paid or more), bought again (two or more). */
  orders: "" | "none" | "buyer" | "one" | "repeat";
  /** A client in the connected portal, or not. */
  client: YesNo;
  /** A client for at least this many days; 0 = any. */
  clientForDays: number;
  /** Ordered before, but not in this many days; 0 = any. */
  noOrderForDays: number;
  hasEmail: YesNo;
  hasPhone: YesNo;
  noNextAction: boolean;
  companyId: string;
  /** Lifecycle stages shown; empty = every stage. */
  stage: LifecycleStage[];
  /** Members of one lead list ("" = any). */
  listId: string;
  /** "" leaves archived people out, "only" shows just them. */
  archived: "" | "only";
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
export const FILTER_KEYS = ["q", "status", "qualification", "priority", "owner", "tag", "source", "orders", "client", "clientForDays", "noOrderForDays", "hasEmail", "hasPhone", "noNextAction", "companyId", "stage", "listId", "archived"] as const;

/** Per-page defaults: which stages a page shows when the URL does not say. */
export type ListDefaults = { stage: readonly LifecycleStage[] };
const NO_DEFAULTS: ListDefaults = { stage: [] };

const list = <T extends string>(raw: string | null, allowed: readonly T[]): T[] =>
  (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is T => (allowed as readonly string[]).includes(s));

const ORDER_FILTERS = ["none", "buyer", "one", "repeat"] as const;

/** A whole number of days, 1–3650; anything else is "any" (0). */
const days = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 3650 ? n : 0;
};

/** A source in the URL: one `source` parameter each (sources may hold commas); "-" stands for "none recorded". */
const NO_SOURCE = "-";

const yesNo = (raw: string | null): YesNo => (raw === "yes" || raw === "no" ? raw : "");

export function parseState(sp: URLSearchParams, defaults: ListDefaults = NO_DEFAULTS): ContactListState {
  const sort = sp.get("sort") ?? "";
  const stage = sp.get("stage");
  const page = Number(sp.get("page"));
  const pageSize = Number(sp.get("pageSize"));
  return {
    q: sp.get("q") ?? "",
    status: list(sp.get("status"), CONTACT_STATUSES),
    qualification: list(sp.get("qualification"), QUALIFICATIONS),
    priority: list(sp.get("priority"), PRIORITIES),
    owner: sp.get("owner") ?? "",
    tag: (sp.get("tag") ?? "").split(",").map((t) => t.trim()).filter(Boolean),
    source: [...new Set(sp.getAll("source").map((v) => (v === NO_SOURCE ? "" : v.trim())))],
    orders: ORDER_FILTERS.includes(sp.get("orders") as (typeof ORDER_FILTERS)[number]) ? (sp.get("orders") as ContactListState["orders"]) : "",
    client: yesNo(sp.get("client")),
    clientForDays: days(sp.get("clientForDays")),
    noOrderForDays: days(sp.get("noOrderForDays")),
    hasEmail: yesNo(sp.get("hasEmail")),
    hasPhone: yesNo(sp.get("hasPhone")),
    noNextAction: sp.get("noNextAction") === "1",
    companyId: sp.get("companyId") ?? "",
    stage: stage === null ? [...defaults.stage] : stage === "all" ? [] : list(stage, LIFECYCLE_STAGES),
    listId: sp.get("list") ?? "",
    archived: sp.get("archived") === "only" ? "only" : "",
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
  if (s.source.length) f.leadSource = s.source;
  if (s.orders) f.orders = s.orders;
  if (s.client) f.client = s.client === "yes";
  if (s.clientForDays) f.clientForDays = s.clientForDays;
  if (s.noOrderForDays) f.noOrderForDays = s.noOrderForDays;
  if (s.hasEmail) f.hasEmail = s.hasEmail === "yes";
  if (s.hasPhone) f.hasPhone = s.hasPhone === "yes";
  if (s.noNextAction) f.noNextAction = true;
  if (s.companyId) f.companyId = s.companyId;
  if (s.stage.length) f.stage = s.stage;
  if (s.listId) f.listId = s.listId;
  if (s.archived) f.archived = s.archived;
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
    source: typeof filters.leadSource === "string" ? [filters.leadSource] : arr(filters.leadSource),
    orders: ORDER_FILTERS.includes(filters.orders as (typeof ORDER_FILTERS)[number]) ? (filters.orders as ContactListState["orders"]) : "",
    client: bool(filters.client),
    clientForDays: days(filters.clientForDays),
    noOrderForDays: days(filters.noOrderForDays),
    hasEmail: bool(filters.hasEmail),
    hasPhone: bool(filters.hasPhone),
    noNextAction: filters.noNextAction === true,
    companyId: typeof filters.companyId === "string" ? filters.companyId : "",
    // Stage, list and archived are page controls: a view changes them only when it stored them.
    ...(Array.isArray(filters.stage) ? { stage: list(arr(filters.stage).join(","), LIFECYCLE_STAGES) } : {}),
    ...(typeof filters.listId === "string" ? { listId: filters.listId } : {}),
    ...(filters.archived === "only" ? { archived: "only" as const } : {}),
  };
}

/** How many filters (not search, not view, not the stage/list/archived controls) are on — the number on the Filters button. */
export function activeFilterCount(s: ContactListState): number {
  return (
    (s.status.length ? 1 : 0) +
    (s.qualification.length ? 1 : 0) +
    (s.priority.length ? 1 : 0) +
    (s.owner ? 1 : 0) +
    (s.tag.length ? 1 : 0) +
    (s.source.length ? 1 : 0) +
    (s.orders ? 1 : 0) +
    (s.client ? 1 : 0) +
    (s.clientForDays ? 1 : 0) +
    (s.noOrderForDays ? 1 : 0) +
    (s.hasEmail ? 1 : 0) +
    (s.hasPhone ? 1 : 0) +
    (s.noNextAction ? 1 : 0) +
    (s.companyId ? 1 : 0)
  );
}

const sameStages = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));

function serialize(s: ContactListState, defaults: ListDefaults): string {
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
  for (const src of s.source) p.append("source", src || NO_SOURCE);
  set("orders", s.orders);
  set("client", s.client);
  if (s.clientForDays) p.set("clientForDays", String(s.clientForDays));
  if (s.noOrderForDays) p.set("noOrderForDays", String(s.noOrderForDays));
  set("hasEmail", s.hasEmail);
  set("hasPhone", s.hasPhone);
  if (s.noNextAction) p.set("noNextAction", "1");
  set("companyId", s.companyId);
  if (!sameStages(s.stage, defaults.stage)) p.set("stage", s.stage.length ? s.stage.join(",") : "all");
  set("list", s.listId);
  set("archived", s.archived);
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
export function useContactListState(defaults: ListDefaults = NO_DEFAULTS) {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const defaultStage = defaults.stage.join(",");
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the stage list's contents, not the array's identity
  const stable = useMemo<ListDefaults>(() => ({ stage: defaults.stage }), [defaultStage]);
  const state = useMemo(() => parseState(new URLSearchParams(sp.toString()), stable), [sp, stable]);

  const update = useCallback(
    (patch: Partial<ContactListState>, opts: { replace?: boolean } = {}) => {
      const next = { ...state, ...patch };
      const touchesFilter = FILTER_KEYS.some((k) => k in patch);
      if (touchesFilter) {
        if (!("page" in patch)) next.page = 1;
        if (!("view" in patch)) next.view = "";
      }
      if (("sort" in patch || "dir" in patch || "pageSize" in patch) && !("page" in patch)) next.page = 1;
      const qs = serialize(next, stable);
      const href = qs ? `${pathname}?${qs}` : pathname;
      if (opts.replace) router.replace(href, { scroll: false });
      else router.push(href, { scroll: false });
    },
    [state, router, pathname, stable],
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
        source: [],
        orders: "",
        client: "",
        clientForDays: 0,
        noOrderForDays: 0,
        hasEmail: "",
        hasPhone: "",
        noNextAction: false,
        companyId: "",
      }),
    [update],
  );

  return { state, update, clearFilters };
}
