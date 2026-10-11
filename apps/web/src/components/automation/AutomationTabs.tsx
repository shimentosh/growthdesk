"use client";

import { ENTITY } from "@/components/ui/icons";
import { NavTabs } from "@/components/ui/Tabs";
import { useWorkspace } from "@/lib/session";

/** Workflows | Runs, under the automation page header. */
export function AutomationTabs({ awaiting }: { awaiting?: number }) {
  const ws = useWorkspace();
  return (
    <NavTabs
      aria-label="Automation"
      className="mb-4"
      items={[
        { href: ws.href("/automation"), label: "Workflows", icon: <ENTITY.workflows.icon />, exact: true },
        { href: ws.href("/automation/runs"), label: "Runs", icon: <ENTITY.runs.icon />, count: awaiting ? awaiting : undefined },
      ]}
    />
  );
}
