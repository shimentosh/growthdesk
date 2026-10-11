"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/Field";
import { Modal } from "@/components/ui/Dialog";
import { useApiMutation } from "@/lib/query";
import { ME_KEY, useMe } from "@/lib/session";
import { TermsConsent } from "./TermsConsent";

/**
 * Asks once for the Terms and Privacy Policy when the account has no record
 * of accepting them: Google sign-ups (the Google button skips the form) and
 * accounts created before the consent line existed. Password and invitation
 * sign-ups accept on the form, so they never see this.
 */
export function TermsGate() {
  const me = useMe();
  const [ticked, setTicked] = useState(false);
  const accept = useApiMutation<{ acceptedAt: string }, { accept: true }>({ path: "/account/terms", invalidate: [ME_KEY], errorToast: false });
  const needed = Boolean(me.data && !me.data.user.termsAcceptedAt);
  if (!needed) return null;
  return (
    <Modal
      open
      onOpenChange={() => undefined}
      dismissOnOutside={false}
      title="Before you continue"
      description="Please confirm you agree to our Terms of Service and Privacy Policy."
      footer={
        <Button variant="primary" disabled={!ticked} loading={accept.isPending} onClick={() => accept.mutate({ accept: true })}>
          Continue
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <FormError error={accept.error?.message} />
        <TermsConsent checked={ticked} onCheckedChange={setTicked} />
      </div>
    </Modal>
  );
}
