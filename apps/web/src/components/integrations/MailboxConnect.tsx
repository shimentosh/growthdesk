"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { ApiError, get } from "@/lib/api";
import { useWorkspace } from "@/lib/session";
import { Button } from "@/components/ui/Button";
import { toast } from "@/components/ui/Toast";
import { showUpgrade } from "@/lib/upgrade";
import type { OAuthStart } from "@/lib/types/integrations";
import { MailboxConnectWizard } from "./MailboxConnectWizard";

export type OAuthMailboxProvider = "gmail" | "microsoft";

/**
 * "Connect with Google / Microsoft 365": asks the API for the provider's
 * consent URL and sends the browser there. The provider returns to
 * /api/mailboxes/oauth/<provider>/callback, which redirects back to the
 * mailboxes page with ?connected=1 or ?error=… (handled by that page).
 * An installation without the OAuth client answers 503 with a message
 * saying so, which is shown as is.
 */
export function useOAuthStart() {
  const ws = useWorkspace();
  const [pending, setPending] = useState<OAuthMailboxProvider | null>(null);
  const start = async (provider: OAuthMailboxProvider) => {
    setPending(provider);
    try {
      const { url } = await get<OAuthStart>(ws.path(`/mailboxes/oauth/${provider}/start`));
      window.location.assign(url);
    } catch (e) {
      setPending(null);
      if (e instanceof ApiError && e.isPlanLimit) {
        if (!showUpgrade(e)) toast.warn(e.message);
        return;
      }
      toast.error(e);
    }
  };
  return { start, pending };
}

/** "Connect mailbox": opens the guided dialog (address → provider and password → domain records). */
export function ConnectMailboxMenu({ variant = "primary" }: { variant?: "primary" | "secondary" }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant={variant} icon={<Plus />} onClick={() => setOpen(true)}>
        Connect mailbox
      </Button>
      <MailboxConnectWizard open={open} onOpenChange={setOpen} />
    </>
  );
}
