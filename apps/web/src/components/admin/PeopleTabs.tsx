"use client";

import { Users, UsersRound } from "lucide-react";
import { NavTabs } from "@/components/ui/Tabs";
import { useWorkspace } from "@/lib/session";

/** Settings → Members & teams: the two tabs under the shared header (People is /settings/members, Teams is /settings/members/teams). */
export function PeopleTabs() {
  const ws = useWorkspace();
  return (
    <NavTabs
      aria-label="Members and teams"
      className="mb-5"
      items={[
        { href: ws.href("/settings/members"), label: "People", icon: <Users />, exact: true },
        { href: ws.href("/settings/members/teams"), label: "Teams", icon: <UsersRound /> },
      ]}
    />
  );
}

export const PEOPLE_TITLE = "Members & teams";
