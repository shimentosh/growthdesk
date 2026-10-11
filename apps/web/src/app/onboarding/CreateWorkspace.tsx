"use client";

import { useState, type FormEvent } from "react";
import { BUSINESS_TYPES } from "@growthdesk/shared";
import { AuthCard } from "@/components/account/AuthFrame";
import { MaintenanceBanner } from "@/components/shell/PlatformNotices";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Field, FormError } from "@/components/ui/Field";
import { Input, NativeSelect } from "@/components/ui/Input";
import { LoadingBlock } from "@/components/ui/Skeleton";
import { UpgradePrompt } from "@/components/ui/UpgradePrompt";
import { toast } from "@/components/ui/Toast";
import { ApiError, fieldsOf, messageOf, post } from "@/lib/api";
import { browserTimeZone } from "@/lib/format";
import { signOut, useMe } from "@/lib/session";

const BUSINESS_LABELS: Record<(typeof BUSINESS_TYPES)[number], string> = {
  agency: "Agency",
  saas: "SaaS",
  consulting: "Consulting",
  freelancer: "Freelancer",
  ecommerce: "E-commerce",
  services: "Services",
  recruiting: "Recruiting",
  other: "Other",
};

/**
 * The first workspace. While the platform requires a confirmed email (the
 * default), the API refuses to create one until the email is confirmed, so an
 * unverified person sees the resend option instead of a form that can only fail.
 */
export function CreateWorkspace() {
  const me = useMe();
  const [name, setName] = useState("");
  const [businessType, setBusinessType] = useState<string>("other");
  const [busy, setBusy] = useState(false);
  const [resending, setResending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  // A 402: the billing account already has as many workspaces as its plan allows.
  const [limit, setLimit] = useState<ApiError | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFields({});
    setLimit(null);
    try {
      const ws = await post<{ id: string }>("/workspaces", { name, businessType, timezone: browserTimeZone() });
      window.location.assign(`/w/${ws.id}`);
    } catch (err) {
      if (err instanceof ApiError && err.isPlanLimit) setLimit(err);
      else {
        setFields(fieldsOf(err));
        setError(messageOf(err));
      }
      setBusy(false);
    }
  }

  async function resend() {
    setResending(true);
    try {
      await post("/auth/resend-verification");
      toast.success("Verification email sent");
    } catch (err) {
      toast.error(err);
    } finally {
      setResending(false);
    }
  }

  if (me.isPending) return <LoadingBlock />;
  if (me.isError) return <Callout tone="bad">{messageOf(me.error)}</Callout>;

  const user = me.data.user;
  // New workspaces join the billing account this person owns; its owner role is where billing lives.
  const billingHome = me.data.workspaces.find((w) => w.role === "owner");
  return (
    <AuthCard
      title="Set up your workspace"
      description={
        <>
          Signed in as {user.email}.{" "}
          <button type="button" onClick={() => void signOut()} className="font-medium text-accent-hi hover:underline">
            Sign out
          </button>
        </>
      }
    >
      <MaintenanceBanner className="mb-3" />
      {limit ? (
        <div className="flex flex-col gap-3">
          <UpgradePrompt error={limit} upgradeHref={billingHome ? `/w/${billingHome.id}/billing` : undefined} />
          {billingHome && (
            <div className="flex justify-end">
              <Button variant="ghost" href={`/w/${billingHome.id}`}>
                Back to {billingHome.name}
              </Button>
            </div>
          )}
        </div>
      ) : !user.emailVerified && me.data.emailVerificationRequired !== false ? (
        <Callout
          tone="warn"
          title="Confirm your email first"
          action={
            <Button size="sm" loading={resending} onClick={resend}>
              Resend
            </Button>
          }
        >
          We sent a link to {user.email}. Open it, then come back here.
        </Callout>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
          <FormError error={Object.keys(fields).length ? null : error} />
          <Field label="Workspace name" error={fields.name} hint="Usually your company or team name.">
            <Input autoFocus required value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="What kind of business?" error={fields.businessType}>
            <NativeSelect
              value={businessType}
              onChange={(e) => setBusinessType(e.target.value)}
              options={BUSINESS_TYPES.map((t) => ({ value: t, label: BUSINESS_LABELS[t] }))}
            />
          </Field>
          <Button type="submit" variant="primary" loading={busy} className="mt-1 w-full">
            Create workspace
          </Button>
        </form>
      )}
    </AuthCard>
  );
}
