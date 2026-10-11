"use client";

import { useMemo, useState, type FormEvent } from "react";
import { Bell, Building, Palette } from "lucide-react";
import { BUSINESS_TYPES } from "@growthdesk/shared";
import { ThemePicker } from "@/components/account/ThemePicker";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/Card";
import { Checkbox } from "@/components/ui/Checkbox";
import { Field, FormError } from "@/components/ui/Field";
import { Input, NativeSelect } from "@/components/ui/Input";
import { EntityTile } from "@/components/ui/icons";
import { KeyValueList } from "@/components/ui/KeyValue";
import { PageHeader } from "@/components/ui/PageHeader";
import { currencies, timeZones, zoneAbbreviation } from "@/lib/format";
import { useApiMutation } from "@/lib/query";
import { useWorkspace, workspaceDetailKey } from "@/lib/session";
import type { WorkspaceDetail } from "@/lib/types";
import { BUSINESS_LABELS, countryName } from "./labels";
import { SecuritySettingsCard } from "./SecuritySettingsCard";

type BusinessType = (typeof BUSINESS_TYPES)[number];

type WorkspacePatch = {
  name?: string;
  businessType?: BusinessType;
  timezone?: string;
  currency?: string;
  settings?: Record<string, unknown>;
};

const asBusiness = (v: string): BusinessType => (BUSINESS_TYPES.includes(v as BusinessType) ? (v as BusinessType) : "other");

/** settings.defaultCountry — the region phone numbers without a +country prefix are read in. */
const readCountry = (settings: Record<string, unknown>) => (typeof settings.defaultCountry === "string" ? settings.defaultCountry : "");

/** settings.notifications.email — off only when explicitly false (the API's rule). */
const readEmailNotifications = (settings: Record<string, unknown>) => {
  const n = settings.notifications as { email?: unknown } | undefined;
  return n?.email !== false;
};

function useSaveWorkspace(success: string) {
  const ws = useWorkspace();
  return useApiMutation<WorkspaceDetail, WorkspacePatch>({
    method: "PATCH",
    path: ws.path(),
    invalidate: [workspaceDetailKey(ws.id)],
    success,
    errorToast: false,
  });
}

function WorkspaceForm() {
  const ws = useWorkspace();
  const zones = useMemo(() => timeZones(), []);
  const currencyOptions = useMemo(() => currencies().map((c) => ({ value: c.code, label: c.label })), []);
  const [name, setName] = useState(ws.name);
  const [businessType, setBusinessType] = useState<BusinessType>(asBusiness(ws.detail.businessType));
  const [timezone, setTimezone] = useState(ws.timezone);
  const [currency, setCurrency] = useState(ws.currency);
  const [country, setCountry] = useState(readCountry(ws.settings));
  const save = useSaveWorkspace("Workspace saved");
  const fields = save.error?.fields ?? {};

  const countryCode = country.trim().toUpperCase();
  const countryLabel = countryCode ? countryName(countryCode) : null;
  const countryError = countryCode && !countryLabel ? "Use a two-letter country code, such as US, GB or DE." : undefined;

  const dirty =
    name.trim() !== ws.name ||
    businessType !== ws.detail.businessType ||
    timezone !== ws.timezone ||
    currency !== ws.currency ||
    countryCode !== readCountry(ws.settings);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (countryError) return;
    const body: WorkspacePatch = { name: name.trim(), businessType, timezone, currency };
    if (countryCode !== readCountry(ws.settings)) body.settings = { defaultCountry: countryCode };
    save.mutate(body);
  }

  return (
    <Card>
      <CardHeader icon={<Building />} title="Workspace" description="Dates are shown in the workspace time zone for everyone on the team." />
      <form onSubmit={submit} noValidate>
        <CardBody className="grid gap-4 sm:grid-cols-2">
          <FormError className="sm:col-span-2" error={save.error && !Object.keys(fields).length ? save.error.message : null} />
          <Field label="Name" error={fields.name} className="sm:col-span-2">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required />
          </Field>
          <Field label="Business type" error={fields.businessType}>
            <NativeSelect
              value={businessType}
              onChange={(e) => setBusinessType(asBusiness(e.target.value))}
              options={BUSINESS_TYPES.map((t) => ({ value: t, label: BUSINESS_LABELS[t] }))}
            />
          </Field>
          <Field label="Currency" error={fields.currency} hint="For deal values and reports.">
            <NativeSelect value={currency} onChange={(e) => setCurrency(e.target.value)} options={currencyOptions} />
          </Field>
          <Field label="Time zone" error={fields.timezone} hint={`Now ${zoneAbbreviation(timezone)}.`}>
            <NativeSelect value={timezone} onChange={(e) => setTimezone(e.target.value)}>
              {!zones.includes(timezone) && <option value={timezone}>{timezone}</option>}
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z.replace(/_/g, " ")}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field
            label="Default country for phone numbers"
            error={countryError ?? fields["settings.defaultCountry"]}
            hint={countryLabel ? `${countryLabel}. Numbers without a country prefix are read as ${countryLabel} numbers.` : "Numbers without a +country prefix are read in this country. Leave empty to require the prefix."}
          >
            <Input value={country} onChange={(e) => setCountry(e.target.value.toUpperCase())} maxLength={2} placeholder="e.g. US" autoComplete="off" className="uppercase" />
          </Field>
        </CardBody>
        <CardFooter>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!dirty || !name.trim() || Boolean(countryError)}>
            Save changes
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

function NotificationsForm() {
  const ws = useWorkspace();
  const initial = readEmailNotifications(ws.settings);
  const [email, setEmail] = useState(initial);
  const save = useSaveWorkspace("Notification settings saved");

  function submit(e: FormEvent) {
    e.preventDefault();
    // The API merges settings one level deep, so send the whole notifications object.
    const current = (ws.settings.notifications ?? {}) as Record<string, unknown>;
    save.mutate({ settings: { notifications: { ...current, email } } });
  }

  return (
    <Card>
      <CardHeader icon={<Bell />} title="Notifications" description="Everyone gets in-app notifications in the bell. This decides whether they are emailed too." />
      <form onSubmit={submit} noValidate>
        <CardBody className="flex flex-col gap-3">
          <FormError error={save.error?.message} />
          <Checkbox
            checked={email}
            onCheckedChange={setEmail}
            label="Email notifications to members"
            description="Replies, task reminders and workflow notifications marked for email also go to each person's email address."
          />
        </CardBody>
        <CardFooter>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={email === initial}>
            Save changes
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

function ReadOnlyWorkspace() {
  const ws = useWorkspace();
  const country = readCountry(ws.settings);
  return (
    <Card>
      <CardHeader icon={<Building />} title="Workspace" />
      <CardBody className="flex flex-col gap-4">
        <Callout tone="info">Only people who can change workspace settings can edit these.</Callout>
        <KeyValueList
          items={[
            { label: "Name", value: ws.name },
            { label: "Business type", value: BUSINESS_LABELS[asBusiness(ws.detail.businessType)] },
            { label: "Time zone", value: `${ws.timezone.replace(/_/g, " ")} (${zoneAbbreviation(ws.timezone)})` },
            { label: "Currency", value: ws.currency },
            { label: "Default country for phone numbers", value: country ? (countryName(country) ?? country) : null },
            { label: "Email notifications", value: readEmailNotifications(ws.settings) ? "On" : "Off" },
          ]}
        />
      </CardBody>
    </Card>
  );
}

/** Settings → General: the workspace's name, zone, currency and defaults, plus the person's own appearance. */
export function GeneralSettings() {
  const ws = useWorkspace();
  const canManage = ws.can("settings.manage");
  return (
    <>
      <PageHeader icon={<EntityTile of="general" />} title="General" description="The workspace's name, time zone, currency and defaults." />
      <div className="flex flex-col gap-5">
        {canManage ? (
          <>
            <WorkspaceForm />
            <NotificationsForm />
            <SecuritySettingsCard />
          </>
        ) : (
          <ReadOnlyWorkspace />
        )}
        <Card>
          <CardHeader icon={<Palette />} title="Appearance" description="Just for you, on this browser. Applies right away." />
          <CardBody>
            <ThemePicker />
          </CardBody>
        </Card>
      </div>
    </>
  );
}
