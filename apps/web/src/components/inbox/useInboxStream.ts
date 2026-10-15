"use client";

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useWorkspace } from "@/lib/session";

/**
 * Live inbox: listens to GET /inbox/stream (Server-Sent Events) and refetches
 * what an event touches — the list, the rail's counts, the sidebar badge, and
 * the open conversation when it is the one that changed. Bursts are coalesced
 * (one refetch per 400 ms). EventSource reconnects by itself; the queries'
 * slow polling covers any gap while it is down.
 */
export function useInboxStream() {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const pending = useRef<{ ids: Set<string>; timer: ReturnType<typeof setTimeout> | null }>({ ids: new Set(), timer: null });
  const path = `/api${ws.path("/inbox/stream")}`;
  const listKey = ws.key("inbox", "list");
  const facetsKey = ws.key("inbox", "facets");
  const unreadKey = ws.key("inbox", "unread");
  const detailKey = (id: string) => ws.key("inbox", "detail", id);

  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    const es = new EventSource(path, { withCredentials: true });
    const state = pending.current;
    const flush = () => {
      state.timer = null;
      const ids = [...state.ids];
      state.ids.clear();
      void qc.invalidateQueries({ queryKey: listKey });
      void qc.invalidateQueries({ queryKey: facetsKey });
      void qc.invalidateQueries({ queryKey: unreadKey });
      for (const id of ids) void qc.invalidateQueries({ queryKey: detailKey(id) });
    };
    const onConversation = (e: MessageEvent<string>) => {
      try {
        const data = JSON.parse(e.data) as { conversationId?: string };
        if (data.conversationId) state.ids.add(data.conversationId);
      } catch {
        // A malformed event still means "something changed".
      }
      state.timer ??= setTimeout(flush, 400);
    };
    es.addEventListener("conversation", onConversation as EventListener);
    return () => {
      es.removeEventListener("conversation", onConversation as EventListener);
      es.close();
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keys derive from the path's workspace
  }, [path, qc]);
}
