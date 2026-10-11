"use client";

import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Modal } from "@/components/ui/Dialog";
import type { ApiKeyWithSecret } from "@/lib/types/api-keys";
import { CopyValue } from "./Copy";

/**
 * The full key, as returned by create. The API keeps only a digest of it, so
 * this is the one chance to copy it; a lost key is revoked and replaced.
 */
export function ApiKeySecretModal({ apiKey, onClose }: { apiKey: ApiKeyWithSecret | null; onClose: () => void }) {
  return (
    <Modal
      open={apiKey !== null}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      dismissOnOutside={false}
      title="Your new API key"
      description={apiKey?.name}
      footer={
        <Button variant="primary" onClick={onClose}>
          I've saved it
        </Button>
      }
    >
      {apiKey && (
        <div className="flex flex-col gap-4">
          <Callout tone="warn" title="You won't see this key again">
            Copy it into the system that will use it now. If it is lost, revoke it and create a new one.
          </Callout>
          <CopyValue value={apiKey.secret} label="Copy key" copied="API key copied" />
          <p className="text-xs text-text-2">
            Send it on every request as <code className="font-mono">Authorization: Bearer {apiKey.prefix}…</code>. Anyone holding it can act on this workspace within its scopes — keep it out of
            browsers, repositories and chat.
          </p>
        </div>
      )}
    </Modal>
  );
}
