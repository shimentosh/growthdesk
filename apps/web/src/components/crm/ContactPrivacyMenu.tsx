"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Download, Eraser, ShieldUser } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/DropdownMenu";
import { useApiMutation } from "@/lib/query";
import { useWorkspace } from "@/lib/session";

/**
 * GDPR data-subject requests for one contact: download everything held about
 * them (contacts.export), or erase them for good (contacts.erase). Erasing
 * leaves a hashed entry on the suppression list so they are never imported
 * or contacted again (apps/api/src/lifecycle/contact-privacy.service.ts).
 */
export function ContactPrivacyMenu({ contactId, name }: { contactId: string; name: string }) {
  const ws = useWorkspace();
  const router = useRouter();
  const [confirm, setConfirm] = useState(false);
  const erase = useApiMutation<{ erased: boolean }, { confirm: "ERASE" }>({
    path: ws.path(`/contacts/${contactId}/erase`),
    invalidate: [ws.key("contacts"), ws.key("suppressions")],
    success: `${name}'s data was erased`,
    errorToast: false,
    onSuccess: () => router.push(ws.href("/contacts")),
  });
  const canExport = ws.can("contacts.export");
  const canErase = ws.can("contacts.erase");
  if (!canExport && !canErase) return null;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button icon={<ShieldUser />}>Privacy</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {canExport && (
            // An attachment response: the browser downloads it and stays on the page.
            <DropdownMenuItem icon={<Download />} onSelect={() => window.location.assign(`/api${ws.path(`/contacts/${contactId}/privacy-export`)}`)}>
              Export their data (JSON)
            </DropdownMenuItem>
          )}
          {canErase && (
            <DropdownMenuItem icon={<Eraser />} danger onSelect={() => setConfirm(true)}>
              Erase their data…
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Erase ${name}'s data?`}
        description="For a GDPR erasure request. The contact, records merged into it, their conversations, messages and calls are deleted permanently; deals and tasks stay, no longer linked to them. Their email addresses and phone numbers are kept only as a one-way hash on the suppression list, so they can't be imported, added or contacted again. Type ERASE to confirm."
        confirmLabel="Erase permanently"
        confirmText="ERASE"
        onConfirm={() => erase.mutateAsync({ confirm: "ERASE" })}
      />
    </>
  );
}
