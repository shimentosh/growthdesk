"use client";

/*
 * Server state. Everything read from the API goes through TanStack Query via
 * the two hooks below, so loading / error / refetch behave the same on every
 * page.
 *
 *   const contacts = useApiQuery<Paged<Contact>>(ws.key("contacts", "list"), ws.path("/contacts"), {
 *     query: { page, pageSize, filter: { q } },   // appended to the key automatically
 *     keepPrevious: true,                         // no flash between pages
 *   });
 *
 *   const save = useApiMutation<Contact, ContactInputT>({
 *     method: "PATCH",
 *     path: (vars) => ws.path(`/contacts/${id}`),
 *     invalidate: [ws.key("contacts")],
 *     success: "Contact saved",
 *   });
 *   save.mutate(values);
 *
 * Query keys: workspace data lives under ["ws", workspaceId, resource, …]
 * (use `ws.key(...)` from useWorkspace), so invalidating ws.key("contacts")
 * refreshes every contacts list and record at once.
 */

import {
  keepPreviousData,
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { toast } from "@/components/ui/Toast";
import { api, ApiError, get, type QueryParams } from "./api";
import { showUpgrade } from "./upgrade";

export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: true,
        // A 4xx will not get better by asking again; network blips and 5xx might.
        retry: (failures, error) => {
          if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
          return failures < 2;
        },
      },
      mutations: { retry: false },
    },
  });
}

export function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(makeQueryClient);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

export type ApiQueryOptions<T> = {
  /** Query-string parameters. Appended to the key, so different params cache separately. */
  query?: QueryParams;
  enabled?: boolean;
  staleTime?: number;
  refetchInterval?: number | false;
  /** Keep showing the previous page's data while the next one loads (tables). */
  keepPrevious?: boolean;
  select?: (data: T) => T;
};

/**
 * GET `path` (an API path without /api) under `key`. Pass `path: null` to
 * hold the query until its inputs exist.
 */
export function useApiQuery<T>(key: QueryKey, path: string | null, options: ApiQueryOptions<T> = {}): UseQueryResult<T, ApiError> {
  const queryKey = options.query ? [...key, options.query] : key;
  return useQuery<T, ApiError>({
    queryKey,
    queryFn: ({ signal }) => get<T>(path as string, { signal, query: options.query }),
    enabled: path !== null && (options.enabled ?? true),
    staleTime: options.staleTime,
    refetchInterval: options.refetchInterval,
    placeholderData: options.keepPrevious ? keepPreviousData : undefined,
    select: options.select,
  });
}

export type ApiMutationConfig<TData, TVars> = {
  /** Default POST. */
  method?: "POST" | "PATCH" | "PUT" | "DELETE";
  path: string | ((vars: TVars) => string);
  /** The JSON body. Default: the variables themselves (none for DELETE). */
  body?: (vars: TVars) => unknown;
  /** Query keys (prefixes) to refetch after success. */
  invalidate?: QueryKey[] | ((data: TData, vars: TVars) => QueryKey[]);
  /** A success toast. */
  success?: string | ((data: TData, vars: TVars) => string);
  /**
   * Toast the error message (default true). Forms that show the error inline
   * pass false. A 402 plan limit always opens the upgrade dialog instead.
   */
  errorToast?: boolean;
  onSuccess?: (data: TData, vars: TVars) => void | Promise<void>;
  onError?: (error: ApiError, vars: TVars) => void;
};

export function useApiMutation<TData = unknown, TVars = void>(
  config: ApiMutationConfig<TData, TVars>,
): UseMutationResult<TData, ApiError, TVars> {
  const qc = useQueryClient();
  return useMutation<TData, ApiError, TVars>({
    mutationFn: (vars) => {
      const method = config.method ?? "POST";
      const path = typeof config.path === "function" ? config.path(vars) : config.path;
      const body = config.body ? config.body(vars) : method === "DELETE" ? undefined : vars;
      return api<TData>(path, { method, body: body === undefined || body === null ? undefined : body });
    },
    onSuccess: async (data, vars) => {
      const keys = typeof config.invalidate === "function" ? config.invalidate(data, vars) : (config.invalidate ?? []);
      await Promise.all(keys.map((queryKey) => qc.invalidateQueries({ queryKey })));
      if (config.success) toast.success(typeof config.success === "function" ? config.success(data, vars) : config.success);
      await config.onSuccess?.(data, vars);
    },
    onError: (error, vars) => {
      config.onError?.(error, vars);
      if (error instanceof ApiError && error.isPlanLimit) {
        if (!showUpgrade(error)) toast.warn(error.message);
        return;
      }
      if (error instanceof ApiError && error.isAuth) return; // already on its way to /login
      if (config.errorToast !== false) toast.error(error);
    },
  });
}

/** Refetch several keys (prefixes) at once: `const invalidate = useInvalidate(); invalidate(ws.key("tasks"))`. */
export function useInvalidate() {
  const qc = useQueryClient();
  return (...keys: QueryKey[]) => Promise.all(keys.map((queryKey) => qc.invalidateQueries({ queryKey })));
}

/** ["ws", workspaceId, ...parts] — the key prefix convention for workspace data. */
export const wsKey = (workspaceId: string, ...parts: unknown[]): QueryKey => ["ws", workspaceId, ...parts];
