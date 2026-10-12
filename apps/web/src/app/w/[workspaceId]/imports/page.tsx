"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { ImportHistory } from "@/components/imports/ImportHistory";
import { ImportWizard } from "@/components/imports/ImportWizard";
import { EntityTile } from "@/components/ui/icons";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { RequirePermission } from "@/components/ui/RequirePermission";
import { LoadingBlock } from "@/components/ui/Skeleton";

/** Contact imports: the CSV wizard on top, every past import below. ?listId= preselects the lead list. */
export default function ImportsPage() {
  return (
    <Page width="capped">
      <RequirePermission permission="contacts.import">
        <PageHeader
          title="Imports"
          icon={<EntityTile of="imports" />}
          description="Bring leads in from a CSV file into a lead list. Rows are matched to existing people by email, then phone."
        />
        <div className="flex flex-col gap-5">
          {/* useSearchParams needs a Suspense boundary above it. */}
          <Suspense fallback={<LoadingBlock />}>
            <Wizard />
          </Suspense>
          <ImportHistory />
        </div>
      </RequirePermission>
    </Page>
  );
}

function Wizard() {
  const listId = useSearchParams().get("listId") ?? undefined;
  return <ImportWizard key={listId ?? ""} listId={listId} />;
}
