"use client";

import { toast } from "@/components/ui/Toast";
import { useApiMutation } from "@/lib/query";
import { useMe, useWorkspace } from "@/lib/session";

/**
 * Platform admins (and owners) can copy a design into the email template
 * library every workspace browses: POST /admin/email-designs/import makes a
 * DRAFT there, to review and publish in the operator console. The console is
 * another origin, reached through /admin (a full page load; src/proxy.ts
 * redirects), like the top bar's "Switch to admin".
 */
export function usePublishToLibrary() {
  const ws = useWorkspace();
  const me = useMe();
  const role = me.data?.user.platformRole;
  const allowed = role === "admin" || role === "owner";
  const mutation = useApiMutation<{ id: string; name: string }, { designId: string }>({
    path: "/admin/email-designs/import",
    body: (v) => ({ workspaceId: ws.id, designId: v.designId }),
    onSuccess: (entry) => {
      toast.success("Added to the template library as a draft", {
        description: `Review and publish “${entry.name}” in the admin console.`,
        duration: 9000,
        action: { label: "Open in admin", onClick: () => window.location.assign(`/admin/library/email-templates/${entry.id}`) },
      });
    },
  });
  return { allowed, mutation };
}
