"use client";

import { CloudOff, Lock, RefreshCw, SearchX, TriangleAlert } from "lucide-react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ApiError, messageOf } from "@/lib/api";
import { cn } from "@/lib/cn";
import { Button } from "./Button";
import { EmptyState } from "./EmptyState";
import { LoadingBlock } from "./Skeleton";
import { UpgradePrompt } from "./UpgradePrompt";

/**
 * What a failed load shows. Reads the error and picks the right story:
 * 402 → the upgrade prompt, 403 → no access, 404 → not found, offline/502 →
 * cannot reach the server, anything else → the message with a retry.
 */
export function ErrorState({
  error,
  title,
  onRetry,
  compact,
  className,
}: {
  error: unknown;
  title?: string;
  onRetry?: () => void;
  compact?: boolean;
  className?: string;
}) {
  if (error instanceof ApiError && error.isPlanLimit) return <UpgradePrompt error={error} className={className} />;

  const api = error instanceof ApiError ? error : null;
  const retry = onRetry ? (
    <Button size="sm" icon={<RefreshCw />} onClick={onRetry}>
      Try again
    </Button>
  ) : undefined;

  if (api?.isForbidden) {
    return <EmptyState compact={compact} className={className} icon={<Lock />} title={title ?? "You don't have access to this"} description={api.message} />;
  }
  if (api?.isNotFound) {
    return <EmptyState compact={compact} className={className} icon={<SearchX />} title={title ?? "Not found"} description={api.message} />;
  }
  if (api?.isOffline || api?.status === 502 || api?.status === 503) {
    return (
      <EmptyState
        compact={compact}
        className={className}
        icon={<CloudOff />}
        title={title ?? "Can't reach Growthdesk"}
        description={api.message}
        action={retry}
      />
    );
  }
  return (
    <EmptyState
      compact={compact}
      className={className}
      icon={<TriangleAlert />}
      title={title ?? "Something went wrong"}
      description={messageOf(error)}
      action={retry}
    />
  );
}

/**
 * Loading → error → empty → data, for one query, in one line:
 *
 *   <QueryState query={contacts} isEmpty={(d) => d.items.length === 0} empty={<EmptyState … />}>
 *     {(data) => <ContactTable rows={data.items} />}
 *   </QueryState>
 */
export function QueryState<T>({
  query,
  children,
  loading,
  isEmpty,
  empty,
  errorTitle,
  className,
}: {
  query: UseQueryResult<T, unknown>;
  children: (data: T) => ReactNode;
  loading?: ReactNode;
  isEmpty?: (data: T) => boolean;
  empty?: ReactNode;
  errorTitle?: string;
  className?: string;
}) {
  if (query.isPending) return <>{loading ?? <LoadingBlock className={className} />}</>;
  if (query.isError && query.data === undefined) {
    return <ErrorState error={query.error} title={errorTitle} onRetry={() => void query.refetch()} className={cn(className)} />;
  }
  const data = query.data as T;
  if (isEmpty?.(data) && empty) return <>{empty}</>;
  return <>{children(data)}</>;
}
