"use client";

import { useState, type FormEvent } from "react";
import { AudioLines, CircleAlert, Clock, KeyRound, ShieldCheck, Unplug } from "lucide-react";
import { AI_CALL_HARD_WINDOW, type AiCallingSettingsPatch } from "@growthdesk/shared";
import type { z } from "zod";
import { Badge, StatusBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { QueryState } from "@/components/ui/ErrorState";
import { Field, FormError } from "@/components/ui/Field";
import { ENTITY } from "@/components/ui/icons";
import { Input, NativeSelect } from "@/components/ui/Input";
import { KeyValueList } from "@/components/ui/KeyValue";
import { Section } from "@/components/ui/PageHeader";
import { SkeletonText } from "@/components/ui/Skeleton";
import { toast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";
import { useApiMutation } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import type { AiCallingConnection, AiCallingSetup } from "@/lib/types/ai-calling";
import type { ChannelIntegration } from "@/lib/types/integrations";
import { CartesiaConnectModal } from "./CartesiaConnectModal";
import { useAiCallingSetup } from "./hooks";

type SettingsPatchT = z.input<typeof AiCallingSettingsPatch>;

/** Monday first, as people read a week; values are 0 = Sunday … 6 = Saturday. */
const WEEK = [
  { day: 1, label: "Mon" },
  { day: 2, label: "Tue" },
  { day: 3, label: "Wed" },
  { day: 4, label: "Thu" },
  { day: 5, label: "Fri" },
  { day: 6, label: "Sat" },
  { day: 0, label: "Sun" },
];

/**
 * Settings → Calling, the AI half: the workspace's Cartesia account, the
 * number AI calls come from, and when they may be placed. The connection is a
 * channel integration, so verify / disconnect go through the channels API.
 */
export function AiCallingSettings() {
  const ws = useWorkspace();
  const setup = useAiCallingSetup();
  const manage = ws.can("integrations.manage");
  const [connecting, setConnecting] = useState(false);
  const [reconnect, setReconnect] = useState(false);

  return (
    <Section icon={<AudioLines />} title="AI calling (Cartesia)" description="Voice AI agents that call consenting contacts for you, from campaigns and workflows.">
      {!ws.can("calls.read") ? (
        <Card className="p-4 text-sm text-text-2">Your role cannot view AI calling.</Card>
      ) : (
        <QueryState
          query={setup}
          loading={
            <Card className="p-4">
              <SkeletonText lines={4} />
            </Card>
          }
        >
          {(s) =>
            s.connection ? (
              <Connected
                setup={s}
                connection={s.connection}
                onReconnect={() => {
                  setReconnect(true);
                  setConnecting(true);
                }}
              />
            ) : (
              <Card>
                <EmptyState
                  icon={<AudioLines />}
                  tint={ENTITY.aiAgents.tint}
                  title="Cartesia is not connected"
                  description={
                    <>
                      Voice AI agents place calls for you and record how each one went. You need a Cartesia API key from play.cartesia.ai/keys and a phone number on that account.
                      {!manage && " Ask a workspace admin to connect it."}
                    </>
                  }
                  action={
                    manage ? (
                      <Button
                        icon={<AudioLines />}
                        onClick={() => {
                          setReconnect(false);
                          setConnecting(true);
                        }}
                      >
                        Connect Cartesia
                      </Button>
                    ) : undefined
                  }
                />
                {s.reason && !/not connected/i.test(s.reason) && <p className="border-t border-line px-4 py-3 text-xs text-text-3">{s.reason}</p>}
              </Card>
            )
          }
        </QueryState>
      )}

      <Callout tone="info" title="Who AI agents may call">
        AI calls only reach contacts whose consent to be called is recorded as granted, never anyone on the do-not-contact list, only within the hours below in the contact&apos;s own time zone, and
        every agent says it is an AI when the call starts.
      </Callout>

      {manage && <CartesiaConnectModal open={connecting} onOpenChange={setConnecting} reconnect={reconnect} />}
    </Section>
  );
}

function Connected({ setup, connection: c, onReconnect }: { setup: AiCallingSetup; connection: AiCallingConnection; onReconnect: () => void }) {
  const ws = useWorkspace();
  const f = useFormat();
  const manage = ws.can("integrations.manage");
  const [confirm, setConfirm] = useState(false);
  const invalidate = [ws.key("ai-calling"), ws.key("channels"), ws.key("call-agents")];

  const verify = useApiMutation<ChannelIntegration, void>({
    path: ws.path(`/channels/${c.id}/verify`),
    invalidate,
    onSuccess: (r) => {
      if (r.status === "connected") toast.success(`${r.name} is working`);
      else toast.error(r.lastError || `${r.name} could not be verified`);
    },
  });
  const remove = useApiMutation<{ ok: boolean }, void>({
    method: "DELETE",
    path: ws.path(`/channels/${c.id}`),
    invalidate,
    success: `${c.name} disconnected`,
    errorToast: false,
  });
  const number = useApiMutation<AiCallingConnection, SettingsPatchT>({
    method: "PATCH",
    path: ws.path("/ai-calling/settings"),
    invalidate,
    success: (r) => `AI calls now come from ${r.phoneNumber}`,
  });

  return (
    <div className="flex flex-col gap-4">
      {setup.reason && (
        <Callout tone="warn" title="AI calls cannot be placed yet">
          {setup.reason}
        </Callout>
      )}
      <Card className="flex flex-col">
        <CardBody className="flex flex-col gap-4">
          <div className="flex flex-wrap items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="truncate text-sm font-semibold text-text-hi">{c.name}</h3>
                <StatusBadge value={c.status} />
                <Badge quiet>Cartesia</Badge>
              </div>
              <p className="mt-0.5 text-xs text-text-3">
                {c.lastEventAt ? `Last call event ${f.relative(c.lastEventAt)}` : "No call events yet"} · connected {f.date(c.createdAt)}
              </p>
            </div>
          </div>

          {c.lastError && (
            <p className="flex items-start gap-1.5 text-xs text-bad-ink">
              <CircleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
              <span className="min-w-0 break-words">{c.lastError}</span>
            </p>
          )}

          <Field
            label="Calls come from"
            error={number.error?.fields.phoneNumberId}
            hint={c.numbers.length ? undefined : "The account has no phone number. Buy or import one in Cartesia, then verify."}
          >
            <NativeSelect
              value={c.phoneNumberId ?? ""}
              disabled={!manage || number.isPending || !c.numbers.length}
              placeholder="Choose a number…"
              onChange={(e) => e.target.value && number.mutate({ phoneNumberId: e.target.value })}
              options={c.numbers.map((n) => ({ value: n.id, label: n.label ? `${n.number} · ${n.label}` : n.number }))}
              className="sm:max-w-sm"
            />
          </Field>

          <KeyValueList
            columns={2}
            items={[
              {
                label: "Call events",
                value: c.webhook.registered ? <Badge tone="ok">Webhook registered</Badge> : <Badge tone="warn">Checked every minute</Badge>,
                hint: c.webhook.registered ? "Results arrive as soon as a call ends." : c.webhook.note,
              },
              {
                label: "Results judged by",
                value: setup.aiAnalysis ? "An AI model" : "Keyword rules",
                hint: setup.aiAnalysis
                  ? "It reads each transcript for the outcome, interest and next step."
                  : "No AI model is available, so outcomes come from phrases like “not interested” or “call me back”.",
              },
            ]}
          />
        </CardBody>
        {manage && (
          <CardFooter>
            <div className="flex w-full flex-wrap items-center gap-2">
              <Button size="sm" icon={<ShieldCheck />} loading={verify.isPending} onClick={() => verify.mutate()}>
                Verify
              </Button>
              <Button size="sm" icon={<KeyRound />} onClick={onReconnect}>
                Replace API key
              </Button>
              <Button size="sm" variant="danger" icon={<Unplug />} className="ml-auto" onClick={() => setConfirm(true)}>
                Disconnect
              </Button>
            </div>
          </CardFooter>
        )}
      </Card>

      <CallingHours key={c.updatedAt} connection={c} />

      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Disconnect ${c.name}?`}
        description="Its API key is deleted and AI agents cannot call anyone until Cartesia is connected again. Agents and call history stay."
        confirmLabel="Disconnect"
        onConfirm={() => remove.mutateAsync()}
      />
    </div>
  );
}

/** HH:MM of the hard window, for the time inputs' bounds. */
const { from: EARLIEST, to: LATEST } = AI_CALL_HARD_WINDOW;

function CallingHours({ connection: c }: { connection: AiCallingConnection }) {
  const ws = useWorkspace();
  const manage = ws.can("integrations.manage");
  const initial = { windowFrom: c.settings.windowFrom, windowTo: c.settings.windowTo, days: c.settings.days, gap: String(c.settings.minHoursBetweenCalls) };
  const [v, setV] = useState(initial);
  const dirty = JSON.stringify(v) !== JSON.stringify(initial);
  const save = useApiMutation<AiCallingConnection, SettingsPatchT>({
    method: "PATCH",
    path: ws.path("/ai-calling/settings"),
    invalidate: [ws.key("ai-calling")],
    success: "Calling hours saved",
    errorToast: false,
  });
  const fields = save.error?.fields ?? {};
  const toggle = (day: number) => setV((p) => ({ ...p, days: p.days.includes(day) ? p.days.filter((d) => d !== day) : [...p.days, day].sort((a, b) => a - b) }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({ windowFrom: v.windowFrom, windowTo: v.windowTo, days: v.days, minHoursBetweenCalls: Number(v.gap) });
  };

  return (
    <Card>
      <CardHeader
        icon={<Clock />}
        title="Calling hours"
        description={`In each contact's own time zone (the workspace's, ${ws.timezone}, when theirs is unknown). Never before ${EARLIEST} or after ${LATEST}.`}
      />
      <form onSubmit={submit} noValidate>
        <fieldset disabled={!manage}>
          <CardBody className="flex flex-col gap-4">
            {save.error && !save.error.isPlanLimit && !Object.keys(fields).length && <FormError error={save.error.message} />}
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="From" error={fields.windowFrom}>
                <Input type="time" min={EARLIEST} max={LATEST} step={900} value={v.windowFrom} onChange={(e) => setV((p) => ({ ...p, windowFrom: e.target.value }))} />
              </Field>
              <Field label="Until" error={fields.windowTo}>
                <Input type="time" min={EARLIEST} max={LATEST} step={900} value={v.windowTo} onChange={(e) => setV((p) => ({ ...p, windowTo: e.target.value }))} />
              </Field>
              <Field label="Gap between calls" hint="Hours before the same person is AI-called again." error={fields.minHoursBetweenCalls}>
                <Input type="number" min={1} max={720} value={v.gap} onChange={(e) => setV((p) => ({ ...p, gap: e.target.value }))} />
              </Field>
            </div>
            <Field label="Days" error={fields.days}>
              <div role="group" aria-label="Days calls may be placed" className="flex flex-wrap gap-1.5">
                {WEEK.map((d) => {
                  const on = v.days.includes(d.day);
                  return (
                    <button
                      key={d.day}
                      type="button"
                      aria-pressed={on}
                      onClick={() => toggle(d.day)}
                      className={cn(
                        "h-8 min-w-12 rounded-sm border px-2.5 text-xs font-medium transition-colors disabled:opacity-50",
                        on ? "border-accent bg-tint-pick text-accent-ink" : "border-line-strong bg-ctl-face text-text-3 hover:text-text",
                      )}
                    >
                      {d.label}
                    </button>
                  );
                })}
              </div>
            </Field>
          </CardBody>
          {manage && (
            <CardFooter>
              {dirty && (
                <Button
                  onClick={() => {
                    setV(initial);
                    save.reset();
                  }}
                  disabled={save.isPending}
                >
                  Discard
                </Button>
              )}
              <Button variant="primary" type="submit" loading={save.isPending} disabled={!dirty}>
                Save hours
              </Button>
            </CardFooter>
          )}
        </fieldset>
      </form>
    </Card>
  );
}
