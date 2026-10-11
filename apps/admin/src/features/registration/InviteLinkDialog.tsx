"use client";

import { Copy } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Modal } from "@/components/ui/Dialog";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { toast } from "@/components/ui/Toast";
import { useFormat } from "@/lib/session";
import type { CreatedInvite } from "./types";

/** After an invitation is created: whether it was emailed, and its one-time link to pass on by hand. */
export function InviteLinkDialog({ created, onClose }: { created: CreatedInvite | null; onClose: () => void }) {
  const f = useFormat();
  const copy = async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.url);
      toast.success("Link copied");
    } catch {
      toast.error("Could not copy. Select the link and copy it yourself.");
    }
  };
  return (
    <Modal
      open={created !== null}
      onOpenChange={(v) => !v && onClose()}
      title="Invitation created"
      description={created ? `For ${created.invite.email}` : undefined}
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      {created && (
        <div className="flex flex-col gap-3">
          {created.emailed ? (
            <Callout tone="ok">The sign-up invitation was emailed to {created.invite.email}.</Callout>
          ) : (
            <Callout tone="warn">The invitation email could not be sent. Share the link below yourself.</Callout>
          )}
          <Field label="Sign-up link" hint={`Shown only this once. It works for ${created.invite.email} only, once, until ${f.dateTime(created.invite.expiresAt)}.`}>
            <div className="flex gap-2">
              <Input readOnly value={created.url} onFocus={(e) => e.currentTarget.select()} className="font-mono text-xs" />
              <Button icon={<Copy />} onClick={copy}>
                Copy
              </Button>
            </div>
          </Field>
        </div>
      )}
    </Modal>
  );
}
