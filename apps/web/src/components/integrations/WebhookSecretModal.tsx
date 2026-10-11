"use client";

import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Modal } from "@/components/ui/Dialog";
import type { WebhookWithSecret } from "@/lib/types/integrations";
import { CopyValue } from "./Copy";

/**
 * The signing secret, as returned by create / rotate. The API stores it
 * encrypted and never returns it again, so this is the one chance to copy it.
 */
export function WebhookSecretModal({ endpoint, onClose }: { endpoint: WebhookWithSecret | null; onClose: () => void }) {
  return (
    <Modal
      open={endpoint !== null}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      dismissOnOutside={false}
      title="Signing secret"
      description={endpoint ? <span className="font-mono break-all">{endpoint.url}</span> : undefined}
      footer={
        <Button variant="primary" onClick={onClose}>
          I've saved it
        </Button>
      }
    >
      {endpoint && (
        <div className="flex flex-col gap-4">
          <Callout tone="warn" title="You won't see this secret again">
            Copy it into the receiving app now. If it is lost, rotate the secret to get a new one.
          </Callout>
          <CopyValue value={endpoint.secret} label="Copy secret" copied="Secret copied" />
          <div className="flex flex-col gap-1.5 text-xs text-text-2">
            <p>
              Each request carries an <code className="font-mono">X-Growthdesk-Signature</code> header of the form{" "}
              <code className="font-mono">t=&lt;unix seconds&gt;,v1=&lt;signature&gt;</code>.
            </p>
            <p>
              To check it, compute the HMAC-SHA256 of <code className="font-mono">&lt;t&gt;.&lt;raw request body&gt;</code> with this secret, hex-encoded, and compare it with{" "}
              <code className="font-mono">v1</code>.
            </p>
          </div>
        </div>
      )}
    </Modal>
  );
}
