"use client";

import { useState, type FormEvent } from "react";
import { Compass } from "lucide-react";
import { FORECAST_CATEGORY_LABELS, localDay, type ForecastCategory } from "@growthdesk/shared";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { Input, NativeSelect } from "@/components/ui/Input";
import { useApiMutation } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import type { DealDetail } from "@/lib/types/pipeline";
import { FORECAST_CATEGORY_OPTIONS, nextStepOverdue } from "./DealSignals";
import { calendarDateInput, fieldErrors } from "./utils";

/*
 * The deal page's forward-looking bits: how the owner rates it for the
 * forecast, what happens next and when, and the stale callout. All saved
 * through PATCH /deals/:id.
 */

/** "No progress for 16 days" — above the stage panel while the API marks the deal stale. */
export function StaleCallout({ deal }: { deal: DealDetail }) {
  const f = useFormat();
  if (!deal.stale) return null;
  return (
    <Callout tone="warn" title={`Stale · no progress for ${deal.stale.days} days`}>
      Last progress {f.date(deal.stale.since)}
      {deal.stage.rotDays ? `; ${deal.stage.name} flags deals after ${deal.stage.rotDays} days` : ""}. Log a call or a note, complete a task, set a next step or move it on.
    </Callout>
  );
}

/** Forecast category (saved on change) and the next step with its date (saved together). Key it by the deal id. */
export function DealForecastCard({ deal, canWrite }: { deal: DealDetail; canWrite: boolean }) {
  const ws = useWorkspace();
  const initial = { nextStep: deal.nextStep, nextStepAt: calendarDateInput(deal.nextStepAt) };
  const [v, setV] = useState(initial);
  const dirty = v.nextStep !== initial.nextStep || v.nextStepAt !== initial.nextStepAt;

  const save = useApiMutation<DealDetail, Record<string, unknown>>({
    method: "PATCH",
    path: ws.path(`/deals/${deal.id}`),
    // The forecast page reads the same deals.
    invalidate: [ws.key("deals"), ws.key("forecast")],
    success: (_, vars) => ("forecastCategory" in vars ? `Forecast: ${FORECAST_CATEGORY_LABELS[vars.forecastCategory as ForecastCategory]}` : "Next step saved"),
    errorToast: false,
    onSuccess: (d) => setV({ nextStep: d.nextStep, nextStepAt: calendarDateInput(d.nextStepAt) }),
  });
  const errors = fieldErrors(save.error);
  const overdue = nextStepOverdue(deal, localDay(new Date(), ws.timezone));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    // A calendar date ("2026-10-09"), stored by the API as UTC midnight like the expected close date.
    save.mutate({ nextStep: v.nextStep.trim(), nextStepAt: v.nextStepAt || null });
  };

  return (
    <Card>
      <CardHeader icon={<Compass />} title="Forecast & next step" />
      <form onSubmit={submit}>
        <CardBody className="flex flex-col gap-4">
          <Field label="Forecast category" hint={deal.status === "open" ? "Commit: you expect to win it this period. Omitted: leave it out of the forecast." : "Closed deals count by when they closed."} error={errors.forecastCategory}>
            <NativeSelect
              value={deal.forecastCategory}
              options={FORECAST_CATEGORY_OPTIONS}
              disabled={!canWrite || save.isPending}
              onChange={(e) => save.mutate({ forecastCategory: e.target.value })}
            />
          </Field>
          <Field label="Next step" error={errors.nextStep ?? (save.error && !errors.nextStepAt && !errors.forecastCategory ? save.error.message : undefined)}>
            <Input value={v.nextStep} onChange={(e) => setV((s) => ({ ...s, nextStep: e.target.value }))} maxLength={500} placeholder="e.g. Send the revised proposal" disabled={!canWrite} />
          </Field>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Due" error={errors.nextStepAt ?? (overdue && !dirty ? "This date has passed" : undefined)} className="min-w-40 flex-1">
              <Input type="date" value={v.nextStepAt} onChange={(e) => setV((s) => ({ ...s, nextStepAt: e.target.value }))} disabled={!canWrite} />
            </Field>
            {canWrite && dirty && (
              <>
                <Button onClick={() => setV(initial)}>Discard</Button>
                <Button variant="primary" type="submit" loading={save.isPending}>
                  Save
                </Button>
              </>
            )}
          </div>
        </CardBody>
      </form>
    </Card>
  );
}
