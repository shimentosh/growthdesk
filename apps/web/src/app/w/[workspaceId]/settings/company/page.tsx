"use client";

import { CompanyProfileSettings } from "@/components/admin/CompanyProfileSettings";
import { RequirePermission } from "@/components/ui/RequirePermission";

export default function CompanyProfilePage() {
  return (
    <RequirePermission permission="settings.manage">
      <CompanyProfileSettings />
    </RequirePermission>
  );
}
