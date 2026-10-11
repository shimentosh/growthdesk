"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Phone, PhoneCall, UserRound } from "lucide-react";
import { EntityTile } from "@/components/ui/icons";
import { CALL_OUTCOMES, isFinalCallStatus, labelOf, renderTemplate, variablesFor } from "@growthdesk/shared";
import { ContactPicker, contactLabel } from "@/components/pickers/Pickers";
import { fieldErrors, formLevelError, useOpenKey } from "@/components/pipeline/utils";
import { Badge, StatusBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Drawer } from "@/components/ui/Drawer";
import { Field, FormError } from "@/components/ui/Field";
import { Input, NativeSelect, Textarea } from "@/components/ui/Input";
import { formatDuration, utcToZonedInput, zonedInputToUtc } from "@/lib/format";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useFormat, useMe, useWorkspace } from "@/lib/session";
import type { CallRow, CallTarget } from "@/lib/types/calls";
import { durationInput, parseDuration, useAgentNumber, useCallScripts, useCallSetup } from "./callHooks";

const FIELDS = ["outcome", "notes", "durationSec", "callbackAt", "scriptId", "contactId", "toNumber", "agentNumber", "integrationId"] as const;

/** What the rep hears on the line, in words, while a Twilio call is live. */
const LIVE_TEXT: Record<string, string> = {
  queued: "Twilio is ringing your phone…",
  ringing: "Your phone is ringing — answer it to be connected.",
  in_progress: "On the line. Record the outcome when you're done.",
};

export type CallDrawerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Who to call. Omit to choose a contact in the drawer (or log a number without a contact). */
  contact?: CallTarget | null;
  /** The call task this call works off (the queue); recording an outcome completes it. */
  taskId?: string | null;
  dealId?: string | null;
  /** Why this contact cannot be called (shown, and calling is disabled). */
  blocked?: string | null;
  /** Record the outcome of an existing call instead of placing a new one. */
  call?: CallRow | null;
};

/**
 * One call, start to finish: the script, click-to-call through Twilio (when
 * it is connected and reachable) or dialling from your own phone, and the
 * outcome. Every opening starts fresh.
 */
export function CallDrawer(props: CallDrawerProps) {
  const key = useOpenKey(props.open);
  return <CallDrawerInner key={key} {...props} />;
}

function CallDrawerInner({ open, onOpenChange, contact: given, taskId, dealId, blocked, call: existing }: CallDrawerProps) {
  const ws = useWorkspace();
  const f = useFormat();
  const me = useMe();
  const tz = ws.timezone;
  const canCall = ws.can("calls.make");
  const setup = useCallSetup(open);
  const scripts = useCallScripts(open);

  const [picked, setPicked] = useState<CallTarget | null>(null);
  const contact: CallTarget | null = given ?? (existing?.contact ? { ...existing.contact } : null) ?? picked;
  const [toNumber, setToNumber] = useState("");
  const [scriptId, setScriptId] = useState<string>(existing?.scriptId ?? "");
  const [agentNumber, setAgentNumber] = useAgentNumber();
  const connected = (setup.data?.twilio ?? []).filter((t) => t.status === "connected");
  const [integrationId, setIntegrationId] = useState<string>("");
  const chosenIntegration = integrationId || connected[0]?.id || "";

  // The call this drawer is about: an existing one, or the one just placed through Twilio.
  const [placedId, setPlacedId] = useState<string | null>(null);
  const callId = existing?.id ?? placedId;
  // A placed call is polled until Twilio reports its end (derived state: stops once a final status is seen).
  const [ended, setEnded] = useState(false);
  const live = useApiQuery<CallRow>(ws.key("calls", "one", callId), callId ? ws.path(`/calls/${callId}`) : null, {
    refetchInterval: placedId && !ended ? 2000 : false,
  });
  const current = live.data ?? existing ?? null;
  const ringingOrLive = current ? !isFinalCallStatus(current.status) : false;
  if (placedId && !ended && live.data && !ringingOrLive) setEnded(true);

  const [outcome, setOutcome] = useState<string>(existing?.outcome ?? "");
  const [notes, setNotes] = useState(existing?.notes ?? "");
  const [duration, setDuration] = useState(durationInput(existing?.durationSec));
  const [callbackAt, setCallbackAt] = useState(utcToZonedInput(existing?.callbackAt, tz));
  const [durationError, setDurationError] = useState<string | null>(null);

  const invalidate = [ws.key("calls"), ws.key("contacts"), ws.key("tasks")];
  const dial = useApiMutation<CallRow, Record<string, unknown>>({
    path: ws.path("/calls/dial"),
    invalidate,
    errorToast: false,
    onSuccess: (c) => setPlacedId(c.id),
  });
  const log = useApiMutation<CallRow, Record<string, unknown>>({
    path: ws.path("/calls"),
    invalidate,
    success: "Call logged",
    errorToast: false,
    onSuccess: () => onOpenChange(false),
  });
  const record = useApiMutation<CallRow, Record<string, unknown>>({
    method: "PATCH",
    path: ws.path(`/calls/${callId}`),
    invalidate,
    success: "Outcome saved",
    errorToast: false,
    onSuccess: () => onOpenChange(false),
  });
  const saving = callId ? record : log;
  // Twilio measures its own calls; a logged call's length is whatever the rep says.
  const lengthEditable = !callId || current?.provider === "manual";
  const errors = { ...fieldErrors(dial.error), ...fieldErrors(saving.error) };

  const script = scripts.data?.find((s) => s.id === scriptId) ?? null;
  const rendered =
    script && contact
      ? renderTemplate(
          script.body,
          variablesFor(contact, {
            senderName: me.data?.user.name,
            senderEmail: me.data?.user.email,
          }),
        )
      : (script?.body ?? "");
  const name = contact
    ? contactLabel({
        fullName: contact.fullName,
        firstName: contact.firstName ?? null,
        lastName: contact.lastName ?? null,
        email: contact.email,
        phone: contact.phone,
      })
    : null;
  const number = contact?.phone || existing?.toNumber || "";
  const twilioReady = Boolean(setup.data?.clickToCall.available && chosenIntegration);
  const canDial = canCall && !callId && !blocked && Boolean(contact?.phone) && twilioReady;

  const placeCall = () => {
    if (!contact) return;
    dial.mutate({
      contactId: contact.id,
      integrationId: chosenIntegration,
      agentNumber: agentNumber.trim(),
      taskId: taskId ?? null,
      dealId: dealId ?? null,
      scriptId: scriptId || null,
    });
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const callback = callbackAt ? zonedInputToUtc(callbackAt, tz) : null;
    const seconds = lengthEditable ? parseDuration(duration) : null;
    if (seconds === undefined) {
      setDurationError("Use minutes:seconds, e.g. 4:30");
      return;
    }
    setDurationError(null);
    if (callId) {
      record.mutate({
        ...(outcome ? { outcome } : {}),
        notes,
        callbackAt: callback,
        // Only a changed script is sent: the one saved on the call may have been deleted since.
        ...(scriptId !== (current?.scriptId ?? "") ? { scriptId: scriptId || null } : {}),
        ...(lengthEditable ? { durationSec: seconds } : {}),
      });
      return;
    }
    log.mutate({
      contactId: contact?.id ?? null,
      toNumber: contact ? undefined : toNumber.trim() || undefined,
      taskId: taskId ?? null,
      dealId: dealId ?? null,
      outcome,
      notes,
      ...(seconds !== null ? { durationSec: seconds } : {}),
      callbackAt: callback,
      scriptId: scriptId || null,
    });
  };

  const title = existing ? "Call outcome" : name ? `Call ${name}` : "Log a call";

  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      icon={<EntityTile of="calls" size="md" />}
      description={number ? number : undefined}
      width="lg"
      actions={
        contact ? (
          <Button size="sm" variant="ghost" icon={<UserRound />} href={ws.href(`/contacts/${contact.id}`)}>
            Open contact
          </Button>
        ) : undefined
      }
      footer={
        canCall ? (
          <>
            <Button onClick={() => onOpenChange(false)}>{callId ? "Close" : "Cancel"}</Button>
            <Button variant="primary" type="submit" form="call-form" loading={saving.isPending} disabled={!outcome && !callId}>
              {callId ? "Save outcome" : "Log call"}
            </Button>
          </>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-5">
        {!given && !existing && !placedId && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Contact" error={errors.contactId}>
              <ContactPicker
                value={picked?.id ?? null}
                onChange={(_, c) =>
                  setPicked(
                    c
                      ? {
                          id: c.id,
                          fullName: c.fullName,
                          firstName: c.firstName,
                          lastName: c.lastName,
                          email: c.email,
                          phone: c.phone,
                          company: c.company,
                        }
                      : null,
                  )
                }
              />
            </Field>
            {!picked && (
              <Field label="Or the number you called" hint="For a call to someone not in your contacts." error={errors.toNumber}>
                <Input value={toNumber} onChange={(e) => setToNumber(e.target.value)} placeholder="+14155550123" inputMode="tel" />
              </Field>
            )}
          </div>
        )}

        {blocked && (
          <Callout tone="bad" title="This contact cannot be called">
            {blocked}
          </Callout>
        )}

        {(scripts.data?.length ?? 0) > 0 && (
          <div className="flex flex-col gap-2">
            <Field label="Script">
              <NativeSelect
                value={scriptId}
                onChange={(e) => setScriptId(e.target.value)}
                options={[{ value: "", label: "No script" }, ...scripts.data!.map((s) => ({ value: s.id, label: s.name }))]}
              />
            </Field>
            {script && <div className="max-h-64 overflow-y-auto rounded-md border border-line bg-s-2 p-3 text-sm whitespace-pre-wrap text-text">{rendered}</div>}
          </div>
        )}

        {/* Placing the call: Twilio, or the rep's own phone. */}
        {!existing && !placedId && contact && !blocked && canCall && (
          <div className="flex flex-col gap-3 rounded-md border border-line p-3">
            {!contact.phone ? (
              <p className="text-sm text-text-2">{name} has no phone number on file. Add one on the contact to call them.</p>
            ) : twilioReady ? (
              <>
                <div className="flex items-center gap-1.5 text-xs font-semibold text-text-hi">
                  <PhoneCall aria-hidden className="size-3.5 text-text-2" />
                  Call through Twilio
                </div>
                <p className="text-xs text-text-2">Twilio rings your phone first; answer it and you are connected to {contact.phone}. Calls are not recorded.</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Your phone" required hint="Kept in this browser only." error={errors.agentNumber}>
                    <Input value={agentNumber} onChange={(e) => setAgentNumber(e.target.value)} placeholder="+14155550100" inputMode="tel" autoComplete="tel" />
                  </Field>
                  {connected.length > 1 && (
                    <Field label="Call from" error={errors.integrationId}>
                      <NativeSelect
                        value={chosenIntegration}
                        onChange={(e) => setIntegrationId(e.target.value)}
                        options={connected.map((t) => ({
                          value: t.id,
                          label: `${t.name} (${t.callerId})`,
                        }))}
                      />
                    </Field>
                  )}
                </div>
                <FormError error={formLevelError(dial.error, FIELDS)} />
                <div>
                  <Button variant="primary" icon={<PhoneCall />} loading={dial.isPending} disabled={!canDial || !agentNumber.trim()} onClick={placeCall}>
                    Call now
                  </Button>
                </div>
              </>
            ) : (
              <>
                <p className="text-sm text-text-2">
                  Dial{" "}
                  <a href={`tel:${contact.phone}`} className="font-medium text-accent-hi hover:underline">
                    {contact.phone}
                  </a>{" "}
                  from your own phone, then log the call below.
                </p>
                {setup.data?.clickToCall.reason && (
                  <p className="text-xs text-text-3">
                    Click-to-call is off: {setup.data.clickToCall.reason}
                    {ws.can("integrations.read") && (
                      <>
                        {" "}
                        <Link href={ws.href("/settings/calling")} className="text-accent-hi hover:underline">
                          Calling settings
                        </Link>
                      </>
                    )}
                  </p>
                )}
              </>
            )}
          </div>
        )}

        {current && (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-line px-3 py-2 text-sm">
            <Phone aria-hidden className="size-4 text-text-3" />
            <StatusBadge value={current.status} />
            {current.provider === "twilio" ? <Badge quiet>Twilio</Badge> : <Badge quiet>Logged</Badge>}
            <span className="text-text-2">
              {ringingOrLive
                ? (LIVE_TEXT[current.status] ?? "")
                : current.durationSec
                  ? `Talked ${formatDuration(current.durationSec)}`
                  : current.endedAt
                    ? `Ended ${f.relative(current.endedAt)}`
                    : ""}
            </span>
          </div>
        )}

        {canCall ? (
          <form id="call-form" onSubmit={submit} className="flex flex-col gap-4">
            <FormError error={formLevelError(saving.error, FIELDS)} />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Outcome" required={!callId} error={errors.outcome}>
                <NativeSelect
                  value={outcome}
                  onChange={(e) => setOutcome(e.target.value)}
                  placeholder="Choose…"
                  options={CALL_OUTCOMES.map((o) => ({
                    value: o,
                    label: labelOf(o),
                  }))}
                />
              </Field>
              {lengthEditable && (
                <Field label="Length" hint="minutes:seconds" error={durationError ?? errors.durationSec}>
                  <Input value={duration} onChange={(e) => setDuration(e.target.value)} placeholder="4:30" inputMode="numeric" />
                </Field>
              )}
              <Field label="Call back" hint={`Adds a call task to your list (${tz}).`} error={errors.callbackAt}>
                <Input type="datetime-local" value={callbackAt} onChange={(e) => setCallbackAt(e.target.value)} />
              </Field>
            </div>
            {outcome === "do_not_call" && <Callout tone="warn">The number is added to the do-not-contact list, so nobody in this workspace can call or WhatsApp it again.</Callout>}
            <Field label="Notes" error={errors.notes}>
              <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={5} maxLength={10000} />
            </Field>
            {taskId && !callId && <p className="text-xs text-text-3">Logging the call completes its task on your call list.</p>}
          </form>
        ) : (
          current && (
            <div className="flex flex-col gap-1 text-sm">
              <span className="text-text-3">Outcome</span>
              <span className="text-text">{current.outcome ? labelOf(current.outcome) : "Not recorded"}</span>
              {current.notes && <p className="mt-2 whitespace-pre-wrap text-text-2">{current.notes}</p>}
            </div>
          )
        )}
      </div>
    </Drawer>
  );
}
