"use client";

import { useState } from "react";
import { ChevronDown, Mail, Plus, Server } from "lucide-react";
import { ApiError, get } from "@/lib/api";
import { useWorkspace } from "@/lib/session";
import { Button } from "@/components/ui/Button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/DropdownMenu";
import { toast } from "@/components/ui/Toast";
import { showUpgrade } from "@/lib/upgrade";
import type { OAuthStart } from "@/lib/types/integrations";
import { SmtpConnectModal } from "./SmtpConnectModal";

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

/** The "Connect mailbox" menu: Google, Microsoft 365, or SMTP/IMAP (which opens the form). */
export function ConnectMailboxMenu({ variant = "primary" }: { variant?: "primary" | "secondary" }) {
  const { start, pending } = useOAuthStart();
  const [smtp, setSmtp] = useState(false);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant={variant} icon={<Plus />} iconRight={<ChevronDown />} loading={pending !== null}>
            {pending ? "Opening sign-in…" : "Connect mailbox"}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-60">
          <DropdownMenuLabel>Sign in with</DropdownMenuLabel>
          <DropdownMenuItem icon={<Mail />} onSelect={() => void start("gmail")}>
            Google (Gmail, Workspace)
          </DropdownMenuItem>
          <DropdownMenuItem icon={<Mail />} onSelect={() => void start("microsoft")}>
            Microsoft 365 / Outlook
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem icon={<Server />} onSelect={() => setSmtp(true)}>
            Any provider (SMTP / IMAP)
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <SmtpConnectModal open={smtp} onOpenChange={setSmtp} />
    </>
  );
}
