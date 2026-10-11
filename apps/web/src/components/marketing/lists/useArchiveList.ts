"use client";

import { toast } from "@/components/ui/Toast";
import { useApiMutation } from "@/lib/query";
import type { MarketingList } from "@/lib/types/marketing";
import { useMarketing } from "../common";

/**
 * Archive or restore a list (POST marketing/lists/:id/archive). A list a
 * live campaign is sending to answers 409 with the campaign's name; archive
 * through a ConfirmDialog (mutateAsync), which shows that message in place.
 */
export function useArchiveList() {
  const mk = useMarketing();
  const mutation = useApiMutation<MarketingList, { list: MarketingList; archived: boolean }>({
    path: ({ list }) => mk.path(`/lists/${list.id}/archive`),
    body: ({ archived }) => ({ archived }),
    invalidate: [mk.key("lists"), mk.key("contacts")],
    success: (l, v) => (v.archived ? `${l.name} archived` : `${l.name} restored`),
    // Archiving shows its error inside the confirm dialog; restore with `restore()`, which toasts it.
    errorToast: false,
  });
  const restore = (list: MarketingList) => mutation.mutate({ list, archived: false }, { onError: (e) => toast.error(e) });
  return { ...mutation, restore };
}
