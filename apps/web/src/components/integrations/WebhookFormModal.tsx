"use client";

import { useState, type FormEvent } from "react";
import { Plus } from "lucide-react";
import type { z } from "zod";
import { WEBHOOK_EVENTS, type WebhookInput } from "@growthdesk/shared";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Modal } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { useApiMutation } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import { eventLabel, type WebhookEndpoint, type WebhookWithSecret } from "@/lib/types/integrations";

type WebhookInputT = z.input<typeof WebhookInput>;
type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/**
 * Add or edit an endpoint. Creating one returns its signing secret — the only
 * time the API reveals it — which the caller shows through `onCreated`.
 */
export function WebhookFormModal({
  endpoint,
  open,
  onOpenChange,
  onCreated,
}: {
  /** Edit this endpoint; omit to create one. */
  endpoint?: WebhookEndpoint | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (row: WebhookWithSecret) => void;
}) {
  const ws = useWorkspace();
  const editing = Boolean(endpoint);
  const [url, setUrl] = useState(endpoint?.url ?? "");
  const [description, setDescription] = useState(endpoint?.description ?? "");
  const [events, setEvents] = useState<Set<string>>(() => new Set(endpoint?.events ?? []));
  const [enabled, setEnabled] = useState(endpoint?.enabled ?? true);

  const save = useApiMutation<WebhookEndpoint | WebhookWithSecret, WebhookInputT>({
    method: editing ? "PATCH" : "POST",
    path: editing ? ws.path(`/webhooks/${endpoint?.id}`) : ws.path("/webhooks"),
    invalidate: [ws.key("webhooks")],
    success: editing ? "Endpoint saved" : "Endpoint added",
    errorToast: false,
    onSuccess: (row) => {
      onOpenChange(false);
      if (!editing && "secret" in row) onCreated?.(row);
    },
  });
  const fields = save.error?.fields ?? {};

  const toggle = (e: string, on: boolean) =>
    setEvents((prev) => {
      const next = new Set(prev);
      if (on) next.add(e);
      else next.delete(e);
      return next;
    });
  const all = events.size === WEBHOOK_EVENTS.length ? true : events.size ? "indeterminate" : false;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({
      url: url.trim(),
      description: description.trim(),
      events: WEBHOOK_EVENTS.filter((ev) => events.has(ev)) as WebhookEvent[],
      enabled,
    });
  };

  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (!o) save.reset();
        onOpenChange(o);
      }}
      size="lg"
      dismissOnOutside={false}
      title={editing ? "Edit endpoint" : "Add a webhook endpoint"}
      description="Growthdesk sends a signed JSON POST to this URL each time one of the chosen events happens."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)} disabled={save.isPending}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="webhook-form" icon={editing ? undefined : <Plus />} loading={save.isPending}>
            {editing ? "Save" : "Add endpoint"}
          </Button>
        </>
      }
    >
      <form id="webhook-form" onSubmit={submit} className="flex flex-col gap-4" noValidate>
        {save.error && !save.error.isPlanLimit && !Object.keys(fields).length && <FormError error={save.error.message} />}
        <Field label="Endpoint URL" required hint="Must be reachable from the public internet." error={fields.url}>
          <Input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/hooks/outreach" className="font-mono" autoComplete="off" />
        </Field>
        <Field label="Description" hint="Optional — what receives these events." error={fields.description}>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={200} />
        </Field>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-xs font-medium text-text-2">
            Events<span aria-hidden className="ml-0.5 text-bad">*</span>
          </legend>
          <Checkbox checked={all} onCheckedChange={(on) => setEvents(new Set(on ? WEBHOOK_EVENTS : []))} label="All events" />
          <div className="grid gap-2 border-t border-line pt-2 sm:grid-cols-2">
            {WEBHOOK_EVENTS.map((ev) => (
              <Checkbox
                key={ev}
                checked={events.has(ev)}
                onCheckedChange={(on) => toggle(ev, on)}
                label={eventLabel(ev)}
                description={<code className="font-mono">{ev}</code>}
              />
            ))}
          </div>
          {(fields.events || Object.keys(fields).some((k) => k.startsWith("events."))) && <p className="text-xs text-bad-ink">{fields.events ?? "Choose at least one event"}</p>}
        </fieldset>
        <Checkbox checked={enabled} onCheckedChange={setEnabled} label="Active" description="Inactive endpoints receive nothing." />
      </form>
    </Modal>
  );
}
