"use client";

import { Megaphone } from "lucide-react";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Callout } from "@/components/ui/Callout";
import { QueryState } from "@/components/ui/ErrorState";
import { SkeletonText } from "@/components/ui/Skeleton";
import { Switch } from "@/components/ui/Switch";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useFormat } from "@/lib/session";

/*
 * The "Product emails" preference: news, tips and onboarding emails from the
 * product itself (platform marketing — apps/api/src/platform-growth). Account
 * emails (sign-in, security, billing, invitations) are not affected. Backed by
 * GET/PUT /auth/me/email-preferences; the change is recorded with the source
 * "account_settings".
 */

type Prefs = { marketingConsent: boolean; consentAt: string | null; unsubscribedAt: string | null; suppressed: boolean; productName: string };

const KEY = ["me", "email-preferences"] as const;

export function ProductEmailsCard() {
  const fmt = useFormat();
  const prefs = useApiQuery<Prefs>([...KEY], "/auth/me/email-preferences");
  const save = useApiMutation<Prefs, boolean>({
    method: "PUT",
    path: "/auth/me/email-preferences",
    body: (marketingConsent) => ({ marketingConsent }),
    invalidate: [[...KEY]],
    success: (p) => (p.marketingConsent ? "You'll receive product emails" : "Product emails turned off"),
  });

  return (
    <Card>
      <CardHeader icon={<Megaphone />} title="Product emails" description="News, tips and onboarding emails from us. Account emails about sign-in, security and billing always arrive." />
      <CardBody className="flex flex-col gap-4">
        <QueryState query={prefs} loading={<SkeletonText lines={2} />}>
          {(p) => {
            const on = save.isPending && save.variables !== undefined ? save.variables : p.marketingConsent;
            return (
              <>
                <Switch
                  checked={on}
                  disabled={save.isPending || p.suppressed}
                  onCheckedChange={(v) => save.mutate(v)}
                  label={`Send me product emails from ${p.productName}`}
                  description={
                    p.marketingConsent && p.consentAt
                      ? `On since ${fmt.date(p.consentAt, "medium")}.`
                      : p.unsubscribedAt
                        ? `Off since ${fmt.date(p.unsubscribedAt, "medium")}.`
                        : "Off. We never send these unless you turn them on."
                  }
                />
                {p.suppressed && (
                  <Callout tone="info">Earlier emails to your address bounced or were reported, so product emails stay off. Contact support if you would like that reviewed.</Callout>
                )}
              </>
            );
          }}
        </QueryState>
      </CardBody>
    </Card>
  );
}
