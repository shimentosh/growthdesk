"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card, CardBody } from "@/components/ui/Card";
import { FormError } from "@/components/ui/Field";
import { StepsEditor } from "@/components/sequences/StepsEditor";
import { useWorkspace } from "@/lib/session";
import type { CampaignDetail } from "@/lib/types/campaigns";
import { cleanSteps, stepsOf, type SequenceStep } from "@/lib/types/sequences";
import { lockedReason, useCampaignPatch } from "./common";

/**
 * The campaign's own copy of its steps, edited with the shared sequence
 * StepsEditor and saved as a whole list (PATCH steps). Editable while draft
 * or paused; the API re-validates and answers field errors keyed
 * steps.<i>.config.<key>, which the editor shows on the step.
 */
export function CampaignSteps({ campaign }: { campaign: CampaignDetail }) {
  const ws = useWorkspace();
  const [baseline, setBaseline] = useState<SequenceStep[]>(() => stepsOf(campaign.steps));
  const [steps, setSteps] = useState<SequenceStep[]>(baseline);
  const save = useCampaignPatch(campaign.id, "Steps saved");
  const locked = lockedReason(campaign.status);
  const readOnly = Boolean(locked) || !ws.can("campaigns.write");
  const dirty = JSON.stringify(baseline) !== JSON.stringify(steps);
  const startedBefore = campaign.status === "paused" && campaign.stats.enrolled > 0;
  const fields = save.error?.fields ?? {};

  return (
    <div className="flex flex-col gap-3">
      {locked && <Callout tone="info">{locked}</Callout>}
      {!locked && startedBefore && (
        <Callout tone="warn">
          Contacts already enrolled stay at their current step number when you save, so inserting or removing steps before where they are moves what they get next.
        </Callout>
      )}
      {save.error && !save.error.isPlanLimit && !Object.keys(fields).some((k) => k.startsWith("steps")) && <FormError error={save.error.message} />}
      <Card>
        <CardBody>
          <StepsEditor steps={steps} onChange={setSteps} readOnly={readOnly} errors={fields} />
        </CardBody>
      </Card>
      {!readOnly && (
        <div className="flex items-center justify-end gap-2">
          {dirty && <span className="text-xs text-text-3">Unsaved changes</span>}
          {dirty && (
            <Button
              onClick={() => {
                setSteps(baseline);
                save.reset();
              }}
              disabled={save.isPending}
            >
              Discard
            </Button>
          )}
          <Button
            variant="primary"
            disabled={!dirty}
            loading={save.isPending}
            onClick={() =>
              save.mutate(
                { steps: cleanSteps(steps) },
                {
                  onSuccess: (c) => {
                    const next = stepsOf(c.steps);
                    setBaseline(next);
                    setSteps(next);
                  },
                },
              )
            }
          >
            Save steps
          </Button>
        </div>
      )}
    </div>
  );
}
