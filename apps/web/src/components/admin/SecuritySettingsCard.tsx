"use client";

import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { labelOf } from "@growthdesk/shared";
import { Badge } from "@/components/ui/Badge";
import { Callout } from "@/components/ui/Callout";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { QueryState } from "@/components/ui/ErrorState";
import { SkeletonText } from "@/components/ui/Skeleton";
import { Switch } from "@/components/ui/Switch";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useMe, useWorkspace } from "@/lib/session";
import type { WorkspaceSecurity } from "@/lib/types";

/**
 * Settings → General → Security: an owner can require two-factor for every
 * member. Members without it are refused workspace pages and sent to enrol.
 * Admins with settings access see the state and who still needs to enrol.
 */
export function SecuritySettingsCard() {
  const ws = useWorkspace();
  const me = useMe();
  const key = ws.key("security");
  const security = useApiQuery<WorkspaceSecurity>(key, ws.path("/security"));
  const save = useApiMutation<WorkspaceSecurity, { requireTwoFactor: boolean }>({
    method: "PUT",
    path: ws.path("/security"),
    invalidate: [key],
    success: (r) => (r.requireTwoFactor ? "Two-factor is now required" : "Two-factor is now optional"),
  });
  const ownTwoFactor = me.data?.user.twoFactorEnabled ?? false;

  return (
    <Card>
      <CardHeader icon={<ShieldCheck />} title="Security" description="Protect the workspace against stolen passwords." />
      <QueryState query={security} loading={<SkeletonText lines={2} className="p-4" />}>
        {(s) => (
          <CardBody className="flex flex-col gap-3">
            <Switch
              checked={s.requireTwoFactor}
              disabled={!s.canChange || save.isPending || (!s.requireTwoFactor && !ownTwoFactor)}
              onCheckedChange={(requireTwoFactor) => save.mutate({ requireTwoFactor })}
              label="Require two-factor authentication"
              description="Everyone must use an authenticator app code when signing in. Members without it can't open the workspace until they turn it on."
            />
            {!s.canChange && <Callout tone="info">Only a workspace owner can change this.</Callout>}
            {s.canChange && !s.requireTwoFactor && !ownTwoFactor && (
              <Callout tone="info">
                Turn on two-factor for your own account first, in{" "}
                <Link href="/account#two-factor" className="font-medium text-accent-hi hover:underline">
                  your account settings
                </Link>
                .
              </Callout>
            )}
            {s.membersWithoutTwoFactor.length > 0 && (
              <div>
                <div className="mb-1.5 text-xs font-medium text-text-2">
                  {s.membersWithoutTwoFactor.length} {s.membersWithoutTwoFactor.length === 1 ? "member hasn't" : "members haven't"} turned on two-factor
                  {s.requireTwoFactor ? " and can't open the workspace yet" : ""}
                </div>
                <ul className="divide-y divide-line rounded-md border border-line">
                  {s.membersWithoutTwoFactor.map((m) => (
                    <li key={m.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                      <span className="min-w-0 truncate">
                        <span className="text-text">{m.name || m.email}</span>
                        {m.name && <span className="ml-2 text-xs text-text-3">{m.email}</span>}
                      </span>
                      <Badge quiet>{labelOf(m.role)}</Badge>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardBody>
        )}
      </QueryState>
    </Card>
  );
}
