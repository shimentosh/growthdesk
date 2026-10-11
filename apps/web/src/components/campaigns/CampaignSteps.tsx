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
 *
 * Once anyone is enrolled the existing steps keep their number, kind and
 * branch sizes (an enrollment's place is a step number): content and timing
 * can change and steps can be added at the end. The same rule is checked
 * here, to say so before saving, and enforced by the API.
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
  const restructured = startedBefore && dirty && changesStructure(baseline, steps);
  const fields = save.error?.fields ?? {};

  return (
    <div className="flex flex-col gap-3">
      {locked && <Callout tone="info">{locked}</Callout>}
      {!locked && startedBefore && (
        <Callout tone={restructured ? "bad" : "info"}>
          Contacts are already enrolled, and each one&apos;s place is kept by step number. You can edit what a step sends and when, and add steps at the end, but not insert,
          remove, reorder or change the kind of existing steps. Duplicate the campaign to restructure it.
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
            disabled={!dirty || restructured}
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

const lanes = (s: SequenceStep) => `${Number(s.config.thenLength ?? 0)}/${Number(s.config.elseLength ?? 0)}`;

/** Mirrors the API's structureChange: true when an existing step is removed, moved, swapped or its branch resized. */
function changesStructure(before: SequenceStep[], after: SequenceStep[]): boolean {
  if (after.length < before.length) return true;
  return before.some((s, i) => s.type !== after[i]!.type || (s.type === "branch" && lanes(s) !== lanes(after[i]!)));
}
