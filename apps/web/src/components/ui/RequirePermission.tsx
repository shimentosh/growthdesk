"use client";

import { Lock } from "lucide-react";
import type { ReactNode } from "react";
import { labelOf } from "@growthdesk/shared";
import { useWorkspace } from "@/lib/session";
import { EmptyState } from "./EmptyState";

/**
 * Gate a whole page (or section) on a permission. The nav already hides links
 * a role cannot use; this covers a pasted URL. The API enforces it either way.
 *
 *   <RequirePermission permission="billing.read"> …page… </RequirePermission>
 */
export function RequirePermission({ permission, children, fallback }: { permission: string | readonly string[]; children: ReactNode; fallback?: ReactNode }) {
  const ws = useWorkspace();
  if (ws.can(permission)) return <>{children}</>;
  return (
    <>
      {fallback ?? (
        <EmptyState
          icon={<Lock />}
          title="You don't have access to this"
          description={`Your role (${labelOf(ws.role)}) does not include this area. Ask a workspace admin if you need it.`}
        />
      )}
    </>
  );
}
