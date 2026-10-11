"use client";

import { useState } from "react";
import { Send } from "lucide-react";
import { SkippedList, plural, skippedTotal } from "@/components/campaigns/common";
import { CampaignPicker, type CampaignSummary } from "@/components/pickers/Pickers";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Modal } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { useApiMutation } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import type { EnrollResult } from "@/lib/types/campaigns";

/** The API only enrolls into a campaign that has been launched and has not finished. */
const ENROLLABLE = ["scheduled", "running", "paused"] as const;

/**
 * POST /campaigns/:id/enroll for the selected contacts. The answer is shown
 * as the API gives it: how many were enrolled, and how many were skipped and why.
 */
export function AddToCampaignModal({
  open,
  onOpenChange,
  contactIds,
  onEnrolled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contactIds: string[];
  /** After a successful enroll (the selection can be cleared once the dialog closes). */
  onEnrolled?: (result: EnrollResult) => void;
}) {
  const ws = useWorkspace();
  const [campaign, setCampaign] = useState<CampaignSummary | null>(null);
  const [result, setResult] = useState<EnrollResult | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);

  const enroll = useApiMutation<EnrollResult, { campaignId: string }>({
    path: ({ campaignId }) => ws.path(`/campaigns/${campaignId}/enroll`),
    body: () => ({ contactIds }),
    // Campaign stats and enrollments, and each contact's "Sequences" card.
    invalidate: [ws.key("campaigns"), ws.key("contacts"), ws.key("analytics")],
    errorToast: false,
    onSuccess: (r) => {
      setResult(r);
      onEnrolled?.(r);
    },
  });

  const reset = () => {
    setCampaign(null);
    setResult(null);
    setPickError(null);
    enroll.reset();
  };
  const change = (o: boolean) => {
    if (enroll.isPending) return;
    if (!o) reset();
    onOpenChange(o);
  };

  const submit = () => {
    if (!campaign) {
      setPickError("Choose a campaign.");
      return;
    }
    enroll.mutate({ campaignId: campaign.id });
  };

  const skipped = result ? skippedTotal(result.skipped) : 0;
  const n = contactIds.length;

  return (
    <Modal
      open={open}
      onOpenChange={change}
      title={`Add ${plural(n, "contact")} to a campaign`}
      description={result ? undefined : "They start the campaign's sequence from its first step, on its schedule."}
      footer={
        result ? (
          <Button variant="primary" onClick={() => change(false)}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={() => change(false)}>Cancel</Button>
            <Button variant="primary" icon={<Send />} loading={enroll.isPending} onClick={submit}>
              Enroll
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="flex flex-col gap-3">
          <Callout tone={result.enrolled > 0 ? "ok" : "warn"}>
            {result.enrolled > 0
              ? `${plural(result.enrolled, "contact")} enrolled in “${campaign?.name ?? "the campaign"}”.`
              : `No one was enrolled in “${campaign?.name ?? "the campaign"}”.`}
            {skipped > 0 ? ` ${plural(skipped, "contact")} skipped.` : ""}
          </Callout>
          {result.skipped.length > 0 && (
            <div>
              <p className="mb-1 text-xs text-text-3">Skipped</p>
              <SkippedList items={result.skipped} />
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <FormError error={enroll.error ? (enroll.error.fields.contactIds ?? enroll.error.message) : null} />
          <Field label="Campaign" required error={pickError} hint="Only launched campaigns (scheduled, running or paused) take new contacts.">
            <CampaignPicker
              value={campaign?.id ?? null}
              valueLabel={campaign?.name}
              statuses={ENROLLABLE}
              onChange={(_id, c) => {
                setPickError(null);
                setCampaign(c);
              }}
            />
          </Field>
        </div>
      )}
    </Modal>
  );
}
