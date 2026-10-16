"use client";

import { useMemo, useState } from "react";
import { FileText, Pencil, Plus, Sparkles, Trash2, X } from "lucide-react";
import {
  DEFAULT_DISCORD_TEMPLATE,
  DISCORD_LIMITS,
  DISCORD_TEMPLATE_PRESETS,
  discordEventLabel,
  renderDiscordMessage,
  validateDiscordTemplate,
  type DiscordTemplateBodyT,
  type DiscordTemplatePreset,
} from "@growthdesk/shared";
import { Badge } from "@/components/ui/Badge";
import { Button, IconButton } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card } from "@/components/ui/Card";
import { Checkbox } from "@/components/ui/Checkbox";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { Drawer } from "@/components/ui/Drawer";
import { QueryState } from "@/components/ui/ErrorState";
import { Field, FormError } from "@/components/ui/Field";
import { Input, NativeSelect, Textarea } from "@/components/ui/Input";
import { SkeletonText } from "@/components/ui/Skeleton";
import { copyText } from "@/components/integrations/Copy";
import { toast } from "@/components/ui/Toast";
import { messageOf, post } from "@/lib/api";
import { useApiMutation, useApiQuery, useInvalidate } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import type { DiscordEventEntry, DiscordField, DiscordSample, DiscordTemplate, DiscordTemplates as TemplatesT } from "@/lib/types/discord";
import { DiscordPreview } from "./DiscordPreview";

const clone = (b: DiscordTemplateBodyT): DiscordTemplateBodyT => JSON.parse(JSON.stringify(b)) as DiscordTemplateBodyT;

/** The event to preview against: the first one with recent activity, else deal.won, else the first. */
export function pickPreviewEvent(events: DiscordEventEntry[] | undefined, prefer?: string[]): string {
  if (!events?.length) return "";
  const pool = prefer?.length ? events.filter((e) => prefer.includes(e.type)) : events;
  const list = pool.length ? pool : events;
  return (list.find((e) => e.recentCount > 0) ?? list.find((e) => e.type === "deal.won") ?? list[0]!).type;
}

/** A sample context for an event type (a real recent event when there is one) and the variables it offers. */
export function useEventContext(type: string) {
  const ws = useWorkspace();
  const sample = useApiQuery<DiscordSample>(ws.key("discord", "sample", type), type ? ws.path("/discord/sample") : null, { query: { type }, staleTime: 60_000 });
  const fields = useApiQuery<DiscordField[]>(ws.key("discord", "fields", type), type ? ws.path("/discord/fields") : null, { query: { types: type }, staleTime: 60_000 });
  return { sample, fields };
}

/** Variables for the chosen event, click to copy {{path}}. */
function Variables({ fields }: { fields: DiscordField[] | undefined }) {
  const [q, setQ] = useState("");
  const shown = (fields ?? []).filter((f) => !q || f.path.toLowerCase().includes(q.toLowerCase())).slice(0, 80);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-text-2">Variables</span>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter" className="h-7 w-36 text-xs" />
      </div>
      <p className="text-xs text-text-3">
        Click to copy, then paste into any text. <code className="font-mono">{"{{path|fallback}}"}</code> shows the fallback when there is no value.
      </p>
      <ul className="max-h-60 overflow-y-auto rounded-md border border-line">
        {shown.map((f) => (
          <li key={f.path}>
            <button type="button" onClick={() => void copyText(`{{${f.path}}}`, `{{${f.path}}} copied`)} className="flex w-full items-baseline gap-2 px-2.5 py-1.5 text-left hover:bg-ctl-hover">
              <code className="shrink-0 font-mono text-xs text-text-hi">{f.path}</code>
              <span className="min-w-0 flex-1 truncate text-xs text-text-3">{f.example}</span>
            </button>
          </li>
        ))}
        {shown.length === 0 && <li className="px-2.5 py-2 text-xs text-text-3">No variables.</li>}
      </ul>
    </div>
  );
}

/** The template form: message, embed, fields, buttons. Controlled. */
function TemplateBodyForm({ body, onChange, errors }: { body: DiscordTemplateBodyT; onChange: (b: DiscordTemplateBodyT) => void; errors: Record<string, string> }) {
  const e = body.embed;
  const setEmbed = (patch: Partial<DiscordTemplateBodyT["embed"]>) => onChange({ ...body, embed: { ...e, ...patch } });
  return (
    <div className="flex flex-col gap-4">
      <Field label="Message" hint="Plain text above the embed. Optional when the embed has content." error={errors.content}>
        <Textarea
          rows={2}
          value={body.content}
          maxLength={DISCORD_LIMITS.content}
          onChange={(ev) => onChange({ ...body, content: ev.target.value })}
          placeholder="New deal won by {{event.actor.name}}"
        />
      </Field>

      <div className="flex flex-col gap-3 rounded-lg border border-line p-3.5">
        <Checkbox checked={e.enabled} onCheckedChange={(v) => setEmbed({ enabled: v })} label="Embed" description="A card with a coloured bar, title, text and fields." />
        {e.enabled && (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_7rem]">
              <Field label="Title">
                <Input value={e.title} maxLength={DISCORD_LIMITS.title} onChange={(ev) => setEmbed({ title: ev.target.value })} />
              </Field>
              <Field label="Colour">
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    aria-label="Colour"
                    value={/^#[0-9a-fA-F]{6}$/.test(e.color) ? e.color : "#5865F2"}
                    onChange={(ev) => setEmbed({ color: ev.target.value })}
                    className="h-8 w-9 shrink-0 cursor-pointer rounded border border-line bg-transparent"
                  />
                  <Input value={e.color} onChange={(ev) => setEmbed({ color: ev.target.value })} className="font-mono" maxLength={7} />
                </div>
              </Field>
            </div>
            <Field label="Title link" error={errors["embed.url"]}>
              <Input value={e.url} maxLength={DISCORD_LIMITS.url} onChange={(ev) => setEmbed({ url: ev.target.value })} placeholder="{{event.link}}" className="font-mono" />
            </Field>
            <Field label="Description">
              <Textarea rows={3} value={e.description} maxLength={DISCORD_LIMITS.description} onChange={(ev) => setEmbed({ description: ev.target.value })} />
            </Field>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Author line">
                <Input value={e.author} maxLength={DISCORD_LIMITS.author} onChange={(ev) => setEmbed({ author: ev.target.value })} />
              </Field>
              <Field label="Footer">
                <Input value={e.footer} maxLength={DISCORD_LIMITS.footer} onChange={(ev) => setEmbed({ footer: ev.target.value })} />
              </Field>
            </div>
            <Checkbox checked={e.timestamp} onCheckedChange={(v) => setEmbed({ timestamp: v })} label="Show when the event happened" />

            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-text-2">Fields</span>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Plus />}
                  disabled={e.fields.length >= DISCORD_LIMITS.fields}
                  onClick={() =>
                    setEmbed({
                      fields: [...e.fields, { name: "", value: "", inline: true }],
                    })
                  }
                >
                  Add field
                </Button>
              </div>
              {e.fields.map((f, i) => (
                <div key={i} className="grid grid-cols-[7rem_minmax(0,1fr)_auto_auto] items-center gap-2">
                  <Input
                    aria-label="Field name"
                    value={f.name}
                    maxLength={DISCORD_LIMITS.fieldName}
                    onChange={(ev) =>
                      setEmbed({
                        fields: e.fields.map((x, j) => (j === i ? { ...x, name: ev.target.value } : x)),
                      })
                    }
                    placeholder="Name"
                    className="w-full"
                  />
                  <Input
                    aria-label="Field value"
                    value={f.value}
                    maxLength={DISCORD_LIMITS.fieldValue}
                    onChange={(ev) =>
                      setEmbed({
                        fields: e.fields.map((x, j) => (j === i ? { ...x, value: ev.target.value } : x)),
                      })
                    }
                    placeholder="{{contact.email}}"
                    className="w-full font-mono"
                  />
                  <Checkbox
                    checked={f.inline}
                    onCheckedChange={(v) =>
                      setEmbed({
                        fields: e.fields.map((x, j) => (j === i ? { ...x, inline: v } : x)),
                      })
                    }
                    label="Inline"
                  />
                  <IconButton label="Remove field" icon={<X />} onClick={() => setEmbed({ fields: e.fields.filter((_, j) => j !== i) })} />
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-text-2">Link buttons</span>
          <Button
            size="sm"
            variant="ghost"
            icon={<Plus />}
            disabled={body.buttons.length >= DISCORD_LIMITS.buttons}
            onClick={() =>
              onChange({
                ...body,
                buttons: [...body.buttons, { label: "", url: "" }],
              })
            }
          >
            Add button
          </Button>
        </div>
        {body.buttons.map((b, i) => (
          <div key={i} className="flex flex-wrap items-start gap-2">
            <Input
              aria-label="Button label"
              value={b.label}
              maxLength={DISCORD_LIMITS.buttonLabel}
              onChange={(ev) =>
                onChange({
                  ...body,
                  buttons: body.buttons.map((x, j) => (j === i ? { ...x, label: ev.target.value } : x)),
                })
              }
              placeholder="Label"
              className="w-36"
            />
            <Field error={errors[`buttons.${i}.url`]} className="min-w-40 flex-1">
              <Input
                aria-label="Button link"
                value={b.url}
                maxLength={DISCORD_LIMITS.url}
                onChange={(ev) =>
                  onChange({
                    ...body,
                    buttons: body.buttons.map((x, j) => (j === i ? { ...x, url: ev.target.value } : x)),
                  })
                }
                placeholder="{{event.link}}"
                className="font-mono"
              />
            </Field>
            <IconButton
              label="Remove button"
              icon={<X />}
              onClick={() =>
                onChange({
                  ...body,
                  buttons: body.buttons.filter((_, j) => j !== i),
                })
              }
            />
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Checkbox checked={body.omitEmptyFields} onCheckedChange={(v) => onChange({ ...body, omitEmptyFields: v })} label="Hide fields with no value" />
        <Field label="When a variable has no value">
          <NativeSelect
            value={body.missing}
            onChange={(ev) =>
              onChange({
                ...body,
                missing: ev.target.value as DiscordTemplateBodyT["missing"],
              })
            }
            options={[
              { value: "blank", label: "Leave it blank" },
              { value: "skip", label: "Don't post the message" },
            ]}
          />
        </Field>
      </div>
    </div>
  );
}

/** Create or edit a template, with a live preview against a real or sample event. */
function TemplateEditor({
  template,
  preset,
  events,
  onClose,
}: {
  template: DiscordTemplate | null;
  /** Start a new template from a ready-made one. */
  preset?: DiscordTemplatePreset;
  events: DiscordEventEntry[] | undefined;
  onClose: () => void;
}) {
  const ws = useWorkspace();
  const canManage = ws.can("integrations.manage");
  const [name, setName] = useState(template?.name ?? preset?.name ?? "");
  const [description, setDescription] = useState(template?.description ?? preset?.description ?? "");
  const [body, setBody] = useState<DiscordTemplateBodyT>(() => clone(template?.body ?? preset?.body ?? DEFAULT_DISCORD_TEMPLATE));
  const [eventType, setEventType] = useState(() => pickPreviewEvent(events, preset?.events));
  const { sample, fields } = useEventContext(eventType);

  const issues = useMemo(
    () =>
      validateDiscordTemplate(
        body,
        fields.data?.map((f) => f.path),
      ),
    [body, fields.data],
  );
  const rendered = useMemo(() => (sample.data ? renderDiscordMessage(body, sample.data.context) : null), [body, sample.data]);

  const save = useApiMutation<DiscordTemplate, void>({
    method: template ? "PUT" : "POST",
    path: ws.path(template ? `/discord/templates/${template.id}` : "/discord/templates"),
    body: () => ({
      name: name.trim(),
      description: description.trim(),
      ...body,
    }),
    invalidate: [ws.key("discord")],
    success: template ? "Template saved" : "Template created",
    errorToast: false,
    onSuccess: () => onClose(),
  });
  const errors = { ...issues.errors, ...(save.error?.fields ?? {}) };

  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      width="xl"
      dismissOnOutside={false}
      title={template ? `Edit “${template.name}”` : "New template"}
      footer={
        <>
          <Button onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          {canManage && (
            <Button variant="primary" loading={save.isPending} disabled={!name.trim() || Object.keys(issues.errors).length > 0} onClick={() => save.mutate()}>
              Save template
            </Button>
          )}
        </>
      }
    >
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,340px)]">
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Name" required error={save.error?.fields?.name}>
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="Deal won" autoFocus />
            </Field>
            <Field label="Note" hint="What it's for. Optional.">
              <Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
            </Field>
          </div>
          <TemplateBodyForm body={body} onChange={setBody} errors={errors} />
          <FormError error={save.error && !Object.keys(save.error.fields ?? {}).length ? messageOf(save.error) : null} />
        </div>

        <div className="flex flex-col gap-3 lg:sticky lg:top-0 lg:self-start">
          <Field label="Preview with">
            <NativeSelect
              value={eventType}
              onChange={(e) => setEventType(e.target.value)}
              options={(events ?? []).map((ev) => ({
                value: ev.type,
                label: ev.label,
                description: ev.type,
              }))}
            />
          </Field>
          {sample.data && <p className="text-xs text-text-3">{sample.data.source === "event" ? "Using the latest real event of this type." : "No event of this type yet: using sample data."}</p>}
          {sample.isLoading ? <SkeletonText lines={5} /> : <DiscordPreview message={rendered?.message ?? null} empty={rendered?.skip ?? undefined} />}
          {rendered?.skip && <Callout tone="warn">Not posted for this event: {rendered.skip}</Callout>}
          {issues.warnings.map((w) => (
            <Callout key={w} tone="info">
              {w}
            </Callout>
          ))}
          <Variables fields={fields.data} />
        </div>
      </div>
    </Drawer>
  );
}

function TemplateRow({ t, onEdit }: { t: DiscordTemplate; onEdit: () => void }) {
  const ws = useWorkspace();
  const canManage = ws.can("integrations.manage");
  const [confirm, setConfirm] = useState(false);
  const remove = useApiMutation<unknown, void>({
    method: "DELETE",
    path: ws.path(`/discord/templates/${t.id}`),
    invalidate: [ws.key("discord")],
    success: "Template deleted",
    errorToast: false,
  });
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <FileText aria-hidden className="size-4 shrink-0 text-text-3" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-text-hi">{t.name}</div>
        <div className="truncate text-xs text-text-3">
          {t.description || t.body.embed.title || t.body.content || "—"} · {t.ruleCount === 0 ? "not used" : `${t.ruleCount} ${t.ruleCount === 1 ? "rule" : "rules"}`}
        </div>
      </div>
      <Button size="sm" variant="ghost" icon={<Pencil />} onClick={onEdit}>
        {canManage ? "Edit" : "View"}
      </Button>
      {canManage && <IconButton label={`Delete ${t.name}`} icon={<Trash2 />} onClick={() => setConfirm(true)} />}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Delete “${t.name}”?`}
        description={t.ruleCount ? "Rules still use it; give them another template first." : "This cannot be undone."}
        confirmLabel="Delete"
        onConfirm={() => remove.mutateAsync()}
      />
    </li>
  );
}

/** The ready-made templates: add one as it is, or open it in the editor first. */
function PresetGallery({ existing, onCustomise }: { existing: Set<string>; onCustomise: (p: DiscordTemplatePreset) => void }) {
  const ws = useWorkspace();
  const invalidate = useInvalidate();
  const canManage = ws.can("integrations.manage");
  const [busy, setBusy] = useState<string | null>(null);
  const missing = DISCORD_TEMPLATE_PRESETS.filter((p) => !existing.has(p.name));

  const add = async (presets: DiscordTemplatePreset[], key: string) => {
    setBusy(key);
    let added = 0;
    try {
      for (const p of presets) {
        await post(ws.path("/discord/templates"), { name: p.name, description: p.description, ...p.body });
        added++;
      }
      toast.success(added === 1 ? `“${presets[0]!.name}” added` : `${added} templates added`);
    } catch (e) {
      toast.error(added ? `${added} added, then: ${messageOf(e)}` : messageOf(e));
    } finally {
      setBusy(null);
      await invalidate(ws.key("discord"));
    }
  };

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-text-hi">
            <Sparkles aria-hidden className="size-4 text-accent-hi" />
            Ready-made templates
          </h2>
          <p className="text-xs text-text-3">Add one as it is, or customise it first. Added templates are yours to edit.</p>
        </div>
        {canManage && missing.length > 1 && (
          <Button size="sm" icon={<Plus />} loading={busy === "all"} disabled={busy !== null} onClick={() => void add(missing, "all")}>
            Add all {missing.length}
          </Button>
        )}
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {DISCORD_TEMPLATE_PRESETS.map((p) => {
          const added = existing.has(p.name);
          return (
            <Card key={p.key} className="flex flex-col gap-2 overflow-hidden border-l-4 p-3.5" style={{ borderLeftColor: p.body.embed.enabled ? p.body.embed.color || undefined : undefined }}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-text-hi">{p.name}</div>
                  <p className="mt-0.5 text-xs text-text-3">{p.description}</p>
                </div>
                {added && (
                  <Badge tone="ok" dot>
                    Added
                  </Badge>
                )}
              </div>
              <div className="flex flex-wrap gap-1">
                {p.events.map((e) => (
                  <Badge key={e} quiet>
                    {discordEventLabel(e)}
                  </Badge>
                ))}
              </div>
              <div className="mt-auto flex gap-2 pt-1">
                {canManage && !added && (
                  <Button size="sm" variant="primary" icon={<Plus />} loading={busy === p.key} disabled={busy !== null} onClick={() => void add([p], p.key)}>
                    Add
                  </Button>
                )}
                <Button size="sm" variant="ghost" icon={<Pencil />} disabled={busy !== null} onClick={() => onCustomise(p)}>
                  {canManage ? (added ? "Customise a copy" : "Customise") : "Preview"}
                </Button>
              </div>
            </Card>
          );
        })}
      </div>
    </section>
  );
}

/** The Templates tab. */
export function DiscordTemplates() {
  const ws = useWorkspace();
  const canManage = ws.can("integrations.manage");
  const list = useApiQuery<TemplatesT>(ws.key("discord", "templates"), ws.path("/discord/templates"));
  const events = useApiQuery<DiscordEventEntry[]>(ws.key("discord", "events"), ws.path("/discord/events"));
  const [editing, setEditing] = useState<DiscordTemplate | DiscordTemplatePreset | "new" | null>(null);
  const existing = new Set((list.data?.items ?? []).map((t) => t.name));

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-text-2">How a message looks. A rule with no template uses the default: the event, its contact and deal, and a button into Growthdesk.</p>
          {canManage && (
            <Button variant="secondary" icon={<Plus />} onClick={() => setEditing("new")}>
              New template
            </Button>
          )}
        </div>
        <QueryState query={list} loading={<SkeletonText lines={4} />}>
          {(d) => (
            <Card>
              <ul className="divide-y divide-line">
                <li className="flex items-center gap-3 px-4 py-3">
                  <FileText aria-hidden className="size-4 shrink-0 text-text-3" />
                  <div className="min-w-0 flex-1 text-sm font-medium text-text-hi">Default</div>
                  <Badge quiet>Built in</Badge>
                </li>
                {d.items.map((t) => (
                  <TemplateRow key={t.id} t={t} onEdit={() => setEditing(t)} />
                ))}
              </ul>
            </Card>
          )}
        </QueryState>
      </section>

      {list.data && <PresetGallery existing={existing} onCustomise={setEditing} />}

      {editing && (
        <TemplateEditor
          template={editing !== "new" && "id" in editing ? editing : null}
          preset={editing !== "new" && "key" in editing ? editing : undefined}
          events={events.data}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
