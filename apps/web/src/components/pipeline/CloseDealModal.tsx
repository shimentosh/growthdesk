"use client";

import { useState, type FormEvent } from "react";
import { Trophy, XCircle } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Dialog";
import { Field } from "@/components/ui/Field";
import { Textarea } from "@/components/ui/Input";
import type { DealStageRef } from "@/lib/types/pipeline";
import { useOpenKey } from "./utils";

export type CloseRequest = { dealId: string; dealName: string; stage: DealStageRef };

type Props = {
  request: CloseRequest | null;
  onCancel: () => void;
  /** Called with the optional reason; the caller performs the move. */
  onConfirm: (request: CloseRequest, reason: string) => void;
  pending?: boolean;
};

/**
 * Moving a deal into a Won or Lost stage closes it. This asks for the reason
 * the API keeps on the deal (MoveDealInput.reason → wonReason / lostReason).
 */
export function CloseDealModal(props: Props) {
  const key = useOpenKey(props.request !== null);
  return <CloseDealDialog key={key} {...props} />;
}

function CloseDealDialog({ request, onCancel, onConfirm, pending }: Props) {
  const [reason, setReason] = useState("");
  const won = request?.stage.kind === "won";
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (request) onConfirm(request, reason.trim());
  };
  return (
    <Modal
      open={request !== null}
      onOpenChange={(o) => !o && onCancel()}
      size="sm"
      title={won ? "Mark deal as won" : "Mark deal as lost"}
      description={request ? `“${request.dealName}” moves to ${request.stage.name} and is closed.` : undefined}
      footer={
        <>
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant={won ? "primary" : "danger"} type="submit" form="close-deal" icon={won ? <Trophy /> : <XCircle />} loading={pending}>
            {won ? "Mark won" : "Mark lost"}
          </Button>
        </>
      }
    >
      <form id="close-deal" onSubmit={submit}>
        <Field label={won ? "Why did it close?" : "Why was it lost?"} hint="Optional. Saved on the deal.">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={500} autoFocus />
        </Field>
      </form>
    </Modal>
  );
}
