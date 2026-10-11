"use client";

import { ImportHistory } from "@/components/imports/ImportHistory";
import { ImportWizard } from "@/components/imports/ImportWizard";
import { EntityTile } from "@/components/ui/icons";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { RequirePermission } from "@/components/ui/RequirePermission";

/** Contact imports: the CSV wizard on top, every past import below. */
export default function ImportsPage() {
  return (
    <Page width="capped">
      <RequirePermission permission="contacts.import">
        <PageHeader
          title="Imports"
          icon={<EntityTile of="imports" />}
          description="Bring contacts in from a CSV file. Rows are matched to existing contacts by email, then phone."
        />
        <div className="flex flex-col gap-5">
          <ImportWizard />
          <ImportHistory />
        </div>
      </RequirePermission>
    </Page>
  );
}
