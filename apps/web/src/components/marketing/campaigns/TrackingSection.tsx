"use client";

import { Activity } from "lucide-react";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Switch } from "@/components/ui/Switch";
import type { SectionProps } from "./CampaignEditor";

/** Open and click tracking switches. */
export function TrackingSection({ value, set, disabled }: SectionProps) {
  return (
    <Card className="max-w-[720px]">
      <CardHeader icon={<Activity />} title="Tracking" description="What the report counts. Turning tracking off makes the email a little more private for recipients." />
      <CardBody className="flex flex-col gap-4">
        <Switch
          checked={value.trackOpens}
          onCheckedChange={(v) => set("trackOpens", v)}
          disabled={disabled}
          label="Track opens"
          description="Adds a tiny invisible image. Some mail apps load images for privacy or block them, so opens are an estimate."
        />
        <Switch
          checked={value.trackClicks}
          onCheckedChange={(v) => set("trackClicks", v)}
          disabled={disabled}
          label="Track clicks"
          description="Links pass through a short redirect so each click is counted, then go straight to the page."
        />
      </CardBody>
    </Card>
  );
}
