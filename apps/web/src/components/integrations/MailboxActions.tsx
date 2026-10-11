"use client";

import { useState } from "react";
import { Ellipsis, FolderSync, Globe, Send, ShieldCheck, Trash2 } from "lucide-react";
import { IconButton } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/DropdownMenu";
import { toast } from "@/components/ui/Toast";
import { useApiMutation } from "@/lib/query";
import { useWorkspace, workspaceDetailKey } from "@/lib/session";
import type { Mailbox, MailboxVerifyResult } from "@/lib/types/integrations";
import { TestSendModal } from "./TestSendModal";

/** Verify / sync / delete for one mailbox — shared by the list's row menu and the detail page's buttons. */
export function useMailboxMutations(box: Pick<Mailbox, "id" | "email">, opts: { onDeleted?: () => void; onVerified?: (r: MailboxVerifyResult) => void } = {}) {
  const ws = useWorkspace();
  const verify = useApiMutation<MailboxVerifyResult, void>({
    path: ws.path(`/mailboxes/${box.id}/verify`),
    invalidate: [ws.key("mailboxes"), ws.key("campaigns")],
    onSuccess: (r) => {
      if (r.status === "connected") toast.success(`${r.email} is working`, { description: r.checks.imap ? "SMTP and IMAP both accepted the sign-in." : "The SMTP server accepted the sign-in." });
      else toast.error(r.lastError || `${r.email} could not sign in`);
      opts.onVerified?.(r);
    },
  });
  const sync = useApiMutation<{ queued: boolean }, void>({
    path: ws.path(`/mailboxes/${box.id}/sync`),
    invalidate: [ws.key("mailboxes"), ws.key("campaigns")],
    success: "Checking for new mail — replies appear as they are read",
  });
  const remove = useApiMutation<{ deleted: boolean }, void>({
    method: "DELETE",
    path: ws.path(`/mailboxes/${box.id}`),
    // Only the list: refetching this mailbox's own record would 404 before the detail page navigates away.
    invalidate: [ws.key("mailboxes", "list"), ws.key("campaigns"), workspaceDetailKey(ws.id)],
    success: `${box.email} removed`,
    errorToast: false,
    onSuccess: () => opts.onDeleted?.(),
  });
  return { verify, sync, remove };
}

export function DeleteMailboxDialog({ box, open, onOpenChange, onConfirm }: { box: Pick<Mailbox, "email">; open: boolean; onOpenChange: (o: boolean) => void; onConfirm: () => Promise<unknown> }) {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Remove ${box.email}?`}
      description="Its stored credentials are wiped and nothing more is sent or read from it. Campaigns that used it skip it from now on; messages already sent stay in history."
      confirmLabel="Remove mailbox"
      onConfirm={onConfirm}
    />
  );
}

/** The row menu on the mailboxes list. */
export function MailboxMenu({ box, onOpenDetail }: { box: Mailbox; onOpenDetail: () => void }) {
  const ws = useWorkspace();
  const { verify, sync, remove } = useMailboxMutations(box);
  const [test, setTest] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const manage = ws.can("integrations.manage");
  const canSync = box.imapEnabled && ws.can(["integrations.manage", "inbox.read"]);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton label={`Actions for ${box.email}`} icon={<Ellipsis />} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {manage && (
            <DropdownMenuItem icon={<ShieldCheck />} disabled={verify.isPending} onSelect={() => verify.mutate()}>
              {verify.isPending ? "Checking…" : "Verify connection"}
            </DropdownMenuItem>
          )}
          {manage && (
            <DropdownMenuItem icon={<Send />} onSelect={() => setTest(true)}>
              Send test message
            </DropdownMenuItem>
          )}
          {canSync && (
            <DropdownMenuItem icon={<FolderSync />} disabled={sync.isPending} onSelect={() => sync.mutate()}>
              Check for replies now
            </DropdownMenuItem>
          )}
          <DropdownMenuItem icon={<Globe />} onSelect={onOpenDetail}>
            DNS &amp; settings
          </DropdownMenuItem>
          {manage && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem danger icon={<Trash2 />} onSelect={() => setConfirm(true)}>
                Remove
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {manage && <TestSendModal mailbox={box} open={test} onOpenChange={setTest} />}
      <DeleteMailboxDialog box={box} open={confirm} onOpenChange={setConfirm} onConfirm={() => remove.mutateAsync()} />
    </>
  );
}
