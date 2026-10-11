"use client";

import { useEffect, useRef } from "react";
import type { QueryKey } from "@tanstack/react-query";
import { useInvalidate } from "@/lib/query";
import { useWorkspace, workspaceDetailKey } from "@/lib/session";
import type { ImportStatus } from "@growthdesk/shared";

export const isActiveImport = (status: ImportStatus | string) => status === "pending" || status === "processing";

/** How often a screen re-reads an import while the worker is on it. */
export const IMPORT_POLL_MS = 2500;

/**
 * Refreshes what an import changes — contacts, companies, tags — when one
 * of the given imports stops running (pass the ids that are running now).
 */
export function useRefreshWhenImportsFinish(activeIds: string[], extra: QueryKey[] = []) {
  const ws = useWorkspace();
  const invalidate = useInvalidate();
  const previous = useRef<Set<string>>(new Set());
  const signature = activeIds.join(",");
  const extraRef = useRef(extra);
  useEffect(() => {
    extraRef.current = extra;
  });

  useEffect(() => {
    const now = new Set(signature ? signature.split(",") : []);
    const finished = [...previous.current].some((id) => !now.has(id));
    previous.current = now;
    if (finished) void invalidate(ws.key("contacts"), ws.key("companies"), ws.key("tags"), workspaceDetailKey(ws.id), ...extraRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
}
