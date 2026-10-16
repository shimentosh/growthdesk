"use client";

import { useApiQuery } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import type { ContactListState } from "./contactListState";

/** One choice of the Source filter: a lead source as first written, and how many contacts have it. */
export type LeadSourceCount = { source: string; count: number };

/**
 * The lead sources among the contacts this page lists (its stage and archive
 * controls — on Leads, the sources of leads), most used first. The other
 * filters are left out so the choices don't vanish as they are ticked.
 */
export function useLeadSources(state: Pick<ContactListState, "stage" | "archived">) {
  const ws = useWorkspace();
  const filter = { ...(state.stage.length ? { stage: state.stage } : {}), ...(state.archived ? { archived: state.archived } : {}) };
  return useApiQuery<LeadSourceCount[]>(ws.key("contacts", "lead-sources", filter), ws.path("/contacts/lead-sources"), {
    query: Object.keys(filter).length ? { filter } : undefined,
    staleTime: 60_000,
  });
}
