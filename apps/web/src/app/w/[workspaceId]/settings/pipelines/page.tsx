"use client";

import { useState } from "react";
import { Plus, SquareKanban } from "lucide-react";
import { NewPipelineModal, PipelineEditor } from "@/components/pipeline/PipelineEditor";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { EntityTile } from "@/components/ui/icons";
import { QueryState } from "@/components/ui/ErrorState";
import { PageHeader } from "@/components/ui/PageHeader";
import { RequirePermission } from "@/components/ui/RequirePermission";
import { SkeletonText } from "@/components/ui/Skeleton";
import { useApiQuery } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import type { Pipeline } from "@/lib/types/pipeline";

/** Settings → Pipelines. Renders inside the settings layout, so no <Page> frame here. */
export default function PipelinesSettingsPage() {
  return (
    <RequirePermission permission="deals.read">
      <PipelinesSettings />
    </RequirePermission>
  );
}

function PipelinesSettings() {
  const ws = useWorkspace();
  const canManage = ws.can("pipelines.manage");
  const [creating, setCreating] = useState(false);
  const pipelines = useApiQuery<Pipeline[]>(ws.key("pipelines"), ws.path("/pipelines"));

  return (
    <>
      <PageHeader
        icon={<EntityTile of="pipelines" />}
        title="Pipelines"
        description="The stages deals move through, in order. Entering a Won or Lost stage closes a deal."
        actions={
          canManage ? (
            <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>
              New pipeline
            </Button>
          ) : undefined
        }
      />
      {!canManage && (
        <Callout className="mb-4">Your role can view pipelines but not change them. Ask a workspace admin to edit stages.</Callout>
      )}
      <QueryState
        query={pipelines}
        loading={<SkeletonText lines={8} />}
        isEmpty={(d) => d.length === 0}
        empty={
          <Card>
            <EmptyState
              icon={<SquareKanban />}
              tint="orange"
              title="No pipelines"
              description="Create a pipeline to start tracking deals."
              action={
                canManage ? (
                  <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>
                    New pipeline
                  </Button>
                ) : undefined
              }
            />
          </Card>
        }
      >
        {(list) => (
          <div className="flex flex-col gap-5">
            {list.map((p) => (
              <PipelineEditor key={p.id} pipeline={p} canManage={canManage} />
            ))}
          </div>
        )}
      </QueryState>
      <NewPipelineModal open={creating} onOpenChange={setCreating} />
    </>
  );
}
