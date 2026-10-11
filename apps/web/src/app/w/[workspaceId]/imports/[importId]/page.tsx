"use client";

import { useParams } from "next/navigation";
import { ImportDetailView } from "@/components/imports/ImportDetail";
import { Page } from "@/components/ui/PageHeader";
import { RequirePermission } from "@/components/ui/RequirePermission";

/** One import: progress while it runs, then its counts, settings and failed rows. */
export default function ImportPage() {
  const { importId } = useParams<{ importId: string }>();
  return (
    <Page width="capped">
      <RequirePermission permission="contacts.import">
        <ImportDetailView id={importId} />
      </RequirePermission>
    </Page>
  );
}
