"use client";

import { SendingSetup } from "@/components/marketing/setup/SendingSetup";
import { EntityTile } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/PageHeader";
import { RequirePermission } from "@/components/ui/RequirePermission";

/** Settings → Sending domains: marketing's email service and the domains it sends from. */
export default function SendingDomainsPage() {
  return (
    <RequirePermission permission="marketing.read">
      <PageHeader
        icon={<EntityTile of="sendingDomains" />}
        title="Sending domains"
        description="The email service and domains marketing campaigns send from. Outreach mailboxes are set up separately."
      />
      <SendingSetup />
    </RequirePermission>
  );
}
