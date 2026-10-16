"use client";

import { useMemo, useState } from "react";
import { FlaskConical, Pencil, Plus, Route, Send, Trash2, X } from "lucide-react";
import { DISCORD_CONDITION_OPS, DISCORD_CONDITION_OP_LABELS, describeDiscordCondition, type DiscordCondition, type DiscordUnroutedMode } from "@growthdesk/shared";
import { Badge } from "@/components/ui/Badge";
import { Button, IconButton } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/Card";
import { Checkbox } from "@/components/ui/Checkbox";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { Drawer } from "@/components/ui/Drawer";
import { QueryState } from "@/components/ui/ErrorState";
import { Field, FormError } from "@/components/ui/Field";
import { Input, NativeSelect } from "@/components/ui/Input";
import { SkeletonText } from "@/components/ui/Skeleton";
import { Switch } from "@/components/ui/Switch";
import { messageOf } from "@/lib/api";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import type { DiscordDestination, DiscordEventEntry, DiscordField, DiscordOverview, DiscordRule, DiscordTemplates, DiscordTestResult, DiscordUnrouted } from "@/lib/types/discord";
import { DiscordPreview } from "./DiscordPreview";
import { DiscordQuickMap, MAP_NAMES } from "./DiscordQuickMap";

type Draft = {
  name: string;
  events: string[];
  destinationIds: string[];
  templateId: string | null;
  conditions: DiscordCondition[];
  enabled: boolean;
};

const noValue = (op: DiscordCondition["op"]) => op === "exists" || op === "not_exists";

/** A searchable list of checkboxes. */
function CheckList<T extends string>({
  items,
  selected,
  onChange,
  empty,
  max,
}: {
  items: { value: T; label: string; hint?: string }[];
  selected: T[];
  onChange: (v: T[]) => void;
  empty: string;
  max?: number;
}) {
  const [q, setQ] = useState("");
  const shown = items.filter((i) => !q || `${i.label} ${i.hint ?? ""}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="flex flex-col gap-2">
      {items.length > 8 && <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter" className="h-8" />}
      <ul className="max-h-56 overflow-y-auto rounded-md border border-line">
        {shown.map((i) => {
          const on = selected.includes(i.value);
          return (
            <li key={i.value} className="px-2.5 py-1.5">
              <Checkbox
                checked={on}
                disabled={!on && max !== undefined && selected.length >= max}
                onCheckedChange={(v) => onChange(v ? [...selected, i.value] : selected.filter((s) => s !== i.value))}
                label={
                  <span>
                    {i.label}
                    {i.hint && <span className="ml-1.5 text-xs text-text-3">{i.hint}</span>}
                  </span>
                }
              />
            </li>
          );
        })}
        {shown.length === 0 && <li className="px-2.5 py-2 text-xs text-text-3">{empty}</li>}
      </ul>
    </div>
  );
}

/** Runs the draft against a real or sample event; can also post it to the chosen channels as a test. */
function RuleTest({ draft, ruleId }: { draft: Draft; ruleId: string | null }) {
  const ws = useWorkspace();
  const [eventType, setEventType] = useState(draft.events[0] ?? "");
  const type = draft.events.includes(eventType) ? eventType : (draft.events[0] ?? "");
  const run = useApiMutation<DiscordTestResult, { post: boolean }>({
    path: ws.path(ruleId ? `/discord/rules/${ruleId}/test` : "/discord/rules/test"),
    body: ({ post }) => ({
      eventType: type,
      templateId: draft.templateId,
      conditions: draft.conditions,
      destinationIds: post ? draft.destinationIds : [],
    }),
    invalidate: [ws.key("discord", "deliveries")],
    errorToast: false,
  });
  const r = run.data;
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line p-3.5">
      <div className="text-sm font-semibold text-text-hi">Try it</div>
      {draft.events.length === 0 ? (
        <p className="text-xs text-text-3">Choose an event first.</p>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-2">
            {draft.events.length > 1 && (
              <Field label="Event" className="min-w-48 flex-1">
                <NativeSelect value={type} onChange={(e) => setEventType(e.target.value)} options={draft.events.map((e) => ({ value: e, label: e }))} />
              </Field>
            )}
            <Button icon={<FlaskConical />} loading={run.isPending && !run.variables?.post} disabled={run.isPending} onClick={() => run.mutate({ post: false })}>
              Preview
            </Button>
            <Button icon={<Send />} loading={run.isPending && run.variables?.post} disabled={run.isPending || draft.destinationIds.length === 0} onClick={() => run.mutate({ post: true })}>
              Send test
            </Button>
          </div>
          <FormError error={run.error ? messageOf(run.error) : null} />
          {r && (
            <div className="flex flex-col gap-2">
              <p className="text-xs text-text-3">{r.source === "event" ? "Against the latest real event of this type." : "No event of this type yet: sample data."}</p>
              {r.conditions.met ? <Callout tone="ok">The conditions match this event.</Callout> : <Callout tone="warn">Would not post: {r.conditions.failed} does not hold for this event.</Callout>}
              <DiscordPreview message={r.message} empty={r.skip ?? undefined} />
              {r.warnings.map((w) => (
                <Callout key={w} tone="info">
                  {w}
                </Callout>
              ))}
              {r.deliveries.map((d) => (
                <div key={d.id} className="flex items-center gap-2 text-xs">
                  <Badge tone={d.status === "sent" ? "ok" : d.status === "failed" ? "bad" : "info"} dot>
                    {d.status}
                  </Badge>
                  <span className="text-text-2">#{d.channelName}</span>
                  {d.error && <span className="text-bad">{d.error}</span>}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function RuleEditor({
  rule,
  destinations,
  events,
  templates,
  onClose,
}: {
  rule: DiscordRule | null;
  destinations: DiscordDestination[];
  events: DiscordEventEntry[];
  templates: DiscordTemplates | undefined;
  onClose: () => void;
}) {
  const ws = useWorkspace();
  const canManage = ws.can("integrations.manage");
  const [draft, setDraft] = useState<Draft>(() =>
    rule
      ? {
          name: rule.name,
          events: rule.events,
          destinationIds: rule.destinationIds,
          templateId: rule.templateId,
          conditions: rule.conditions,
          enabled: rule.enabled,
        }
      : {
          name: "",
          events: [],
          destinationIds: destinations.length === 1 ? [destinations[0]!.id] : [],
          templateId: null,
          conditions: [],
          enabled: true,
        },
  );
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const fields = useApiQuery<DiscordField[]>(ws.key("discord", "fields", draft.events.join(",")), draft.events.length ? ws.path("/discord/fields") : null, {
    query: { types: draft.events.join(",") },
    staleTime: 60_000,
  });

  const save = useApiMutation<DiscordRule, void>({
    method: rule ? "PUT" : "POST",
    path: ws.path(rule ? `/discord/rules/${rule.id}` : "/discord/rules"),
    body: () => ({ ...draft, name: draft.name.trim() }),
    invalidate: [ws.key("discord")],
    success: rule ? "Rule saved" : "Rule created",
    errorToast: false,
    onSuccess: () => onClose(),
  });
  const errs = save.error?.fields ?? {};
  const fieldOptions = (fields.data ?? []).map((f) => ({
    value: f.path,
    label: f.path,
    description: f.example || undefined,
  }));

  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      width="lg"
      dismissOnOutside={false}
      title={rule ? `Edit “${rule.name}”` : "New rule"}
      description="When one of these events happens and the conditions hold, post it to these channels."
      footer={
        <>
          <Button onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          {canManage && (
            <Button variant="primary" loading={save.isPending} disabled={!draft.name.trim() || !draft.events.length || !draft.destinationIds.length} onClick={() => save.mutate()}>
              Save rule
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <Field label="Name" required error={errs.name}>
          <Input value={draft.name} onChange={(e) => set({ name: e.target.value })} maxLength={120} placeholder="Deals won → #sales" autoFocus />
        </Field>

        <Field label="When" error={errs.events} hint={`${draft.events.length} chosen. Events with recent activity show how many happened lately.`}>
          <CheckList
            items={events.map((e) => ({
              value: e.type,
              label: e.label,
              hint: e.recentCount ? `${e.type} · ${e.recentCount} recently` : e.type,
            }))}
            selected={draft.events}
            onChange={(v) => set({ events: v })}
            empty="No events match."
            max={50}
          />
        </Field>

        <Field label="Post to" error={errs.destinationIds}>
          {destinations.length === 0 ? (
            <p className="text-xs text-text-3">No channels yet. Add some on the Servers &amp; channels tab.</p>
          ) : (
            <CheckList
              items={destinations.map((d) => ({
                value: d.id,
                label: `#${d.name}`,
                hint: [d.guildName, d.group].filter(Boolean).join(" · "),
              }))}
              selected={draft.destinationIds}
              onChange={(v) => set({ destinationIds: v })}
              empty="No channels match."
              max={10}
            />
          )}
        </Field>

        <Field label="Template" error={errs.templateId}>
          <NativeSelect
            value={draft.templateId ?? ""}
            onChange={(e) => set({ templateId: e.target.value || null })}
            options={[
              { value: "", label: "Default" },
              ...(templates?.items ?? []).map((t) => ({
                value: t.id,
                label: t.name,
              })),
            ]}
          />
        </Field>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-text-2">Only if (all must hold)</span>
            <Button
              size="sm"
              variant="ghost"
              icon={<Plus />}
              disabled={draft.conditions.length >= 10 || !draft.events.length}
              onClick={() =>
                set({
                  conditions: [...draft.conditions, { field: "", op: "is", value: "" }],
                })
              }
            >
              Add condition
            </Button>
          </div>
          {draft.conditions.length === 0 && <p className="text-xs text-text-3">No conditions: every chosen event posts.</p>}
          {draft.conditions.map((c, i) => {
            const patch = (p: Partial<DiscordCondition>) =>
              set({
                conditions: draft.conditions.map((x, j) => (j === i ? { ...x, ...p } : x)),
              });
            return (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <div className="min-w-44 flex-1">
                  <NativeSelect aria-label="Field" value={c.field} onChange={(e) => patch({ field: e.target.value })} placeholder="Field…" options={fieldOptions} />
                </div>
                <div className="w-40">
                  <NativeSelect
                    aria-label="Operator"
                    value={c.op}
                    onChange={(e) => patch({ op: e.target.value as DiscordCondition["op"] })}
                    options={DISCORD_CONDITION_OPS.map((op) => ({
                      value: op,
                      label: DISCORD_CONDITION_OP_LABELS[op],
                    }))}
                  />
                </div>
                {!noValue(c.op) && <Input aria-label="Value" value={c.value} onChange={(e) => patch({ value: e.target.value })} maxLength={200} className="w-36" />}
                <IconButton
                  label="Remove condition"
                  icon={<X />}
                  onClick={() =>
                    set({
                      conditions: draft.conditions.filter((_, j) => j !== i),
                    })
                  }
                />
              </div>
            );
          })}
        </div>

        <Switch checked={draft.enabled} onCheckedChange={(v) => set({ enabled: v })} label="On" description="Off keeps the rule without posting." />
        <FormError error={save.error && !Object.keys(errs).length ? messageOf(save.error) : null} />
        {canManage && <RuleTest draft={draft} ruleId={rule?.id ?? null} />}
      </div>
    </Drawer>
  );
}

function RuleRow({ rule, destinations, onEdit }: { rule: DiscordRule; destinations: DiscordDestination[]; onEdit: () => void }) {
  const ws = useWorkspace();
  const f = useFormat();
  const canManage = ws.can("integrations.manage");
  const [confirm, setConfirm] = useState(false);
  const toggle = useApiMutation<DiscordRule, boolean>({
    method: "PATCH",
    path: ws.path(`/discord/rules/${rule.id}`),
    body: (enabled) => ({ enabled }),
    invalidate: [ws.key("discord")],
  });
  const remove = useApiMutation<unknown, void>({
    method: "DELETE",
    path: ws.path(`/discord/rules/${rule.id}`),
    invalidate: [ws.key("discord")],
    success: "Rule deleted",
  });
  const channels = rule.destinationIds.map((id) => destinations.find((d) => d.id === id)?.name ?? "removed channel");
  return (
    <li className="flex items-start gap-3 px-4 py-3.5">
      <Switch
        checked={toggle.isPending ? Boolean(toggle.variables) : rule.enabled}
        disabled={!canManage || toggle.isPending}
        onCheckedChange={(v) => toggle.mutate(v)}
        aria-label={`${rule.name} on`}
        size="sm"
      />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-text-hi">{rule.name}</div>
        <div className="mt-0.5 text-xs text-text-2">
          {rule.events.length <= 3 ? rule.events.join(", ") : `${rule.events.slice(0, 3).join(", ")} +${rule.events.length - 3}`} → {channels.map((c) => `#${c}`).join(", ")}
        </div>
        {rule.conditions.length > 0 && <div className="mt-0.5 text-xs text-text-3">If {rule.conditions.map(describeDiscordCondition).join(" and ")}</div>}
        <div className="mt-0.5 text-xs text-text-3">
          {rule.templateName ?? "Default template"} · {rule.lastMatchedAt ? `last posted ${f.relative(rule.lastMatchedAt)}` : "hasn't matched yet"}
        </div>
      </div>
      <Button size="sm" variant="ghost" icon={<Pencil />} onClick={onEdit}>
        {canManage ? "Edit" : "View"}
      </Button>
      {canManage && <IconButton label={`Delete ${rule.name}`} icon={<Trash2 />} onClick={() => setConfirm(true)} />}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Delete “${rule.name}”?`}
        description="Messages it has waiting are canceled. Its past deliveries stay in the log."
        confirmLabel="Delete"
        onConfirm={() => remove.mutateAsync()}
      />
    </li>
  );
}

const UNROUTED: Record<DiscordUnroutedMode, string> = {
  ignore: "Ignore them",
  log: "Count them, so you can see what isn't routed",
  fallback: "Post them to a fallback channel",
};

/** What happens to events no enabled rule takes. */
function Unrouted({ overview, destinations }: { overview: DiscordOverview; destinations: DiscordDestination[] }) {
  const ws = useWorkspace();
  const f = useFormat();
  const canManage = ws.can("integrations.manage");
  const [mode, setMode] = useState(overview.settings.unrouted);
  const [fallback, setFallback] = useState(overview.settings.fallbackDestinationId ?? "");
  const counts = useApiQuery<DiscordUnrouted>(ws.key("discord", "unrouted"), mode === "log" || overview.settings.unrouted === "log" ? ws.path("/discord/unrouted") : null);
  const save = useApiMutation<unknown, void>({
    method: "PUT",
    path: ws.path("/discord/settings"),
    body: () => ({
      unrouted: mode,
      fallbackDestinationId: mode === "fallback" ? fallback || null : null,
    }),
    invalidate: [ws.key("discord")],
    success: "Saved",
    errorToast: false,
  });
  const clear = useApiMutation<unknown, void>({
    method: "DELETE",
    path: ws.path("/discord/unrouted"),
    invalidate: [ws.key("discord", "unrouted")],
    success: "Counts cleared",
  });
  const dirty = mode !== overview.settings.unrouted || (mode === "fallback" && fallback !== (overview.settings.fallbackDestinationId ?? ""));

  return (
    <Card>
      <CardHeader icon={<Route />} title="Events no rule takes" description="Every other event in the workspace." />
      <CardBody className="flex flex-col gap-3">
        <NativeSelect
          value={mode}
          disabled={!canManage}
          onChange={(e) => setMode(e.target.value as DiscordUnroutedMode)}
          options={(Object.keys(UNROUTED) as DiscordUnroutedMode[]).map((k) => ({ value: k, label: UNROUTED[k] }))}
        />
        {mode === "fallback" && (
          <Field label="Fallback channel" error={save.error?.fields?.fallbackDestinationId}>
            <NativeSelect
              value={fallback}
              disabled={!canManage}
              onChange={(e) => setFallback(e.target.value)}
              placeholder="Choose a channel"
              options={destinations.map((d) => ({
                value: d.id,
                label: `#${d.name}`,
                description: d.guildName,
              }))}
            />
          </Field>
        )}
        {mode === "log" && counts.data && (
          <div className="flex flex-col gap-1">
            {counts.data.length === 0 ? (
              <p className="text-xs text-text-3">Nothing unrouted so far.</p>
            ) : (
              <ul className="divide-y divide-line rounded-md border border-line">
                {counts.data.map((u) => (
                  <li key={u.eventType} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <code className="min-w-0 flex-1 truncate font-mono text-xs text-text-hi">{u.eventType}</code>
                    <span className="text-xs text-text-2">{u.count}×</span>
                    <span className="text-xs text-text-3">last {f.relative(u.lastAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <FormError error={save.error && !save.error.fields?.fallbackDestinationId ? messageOf(save.error) : null} />
      </CardBody>
      {canManage && (dirty || (mode === "log" && counts.data?.length)) ? (
        <CardFooter>
          {mode === "log" && Boolean(counts.data?.length) && !dirty && (
            <Button variant="ghost" loading={clear.isPending} onClick={() => clear.mutate()}>
              Clear counts
            </Button>
          )}
          {dirty && (
            <Button variant="primary" loading={save.isPending} disabled={mode === "fallback" && !fallback} onClick={() => save.mutate()}>
              Save
            </Button>
          )}
        </CardFooter>
      ) : null}
    </Card>
  );
}

/** The Rules tab. */
export function DiscordRules({ overview }: { overview: DiscordOverview }) {
  const ws = useWorkspace();
  const canManage = ws.can("integrations.manage");
  const rules = useApiQuery<DiscordRule[]>(ws.key("discord", "rules"), ws.path("/discord/rules"));
  const destinations = useApiQuery<DiscordDestination[]>(ws.key("discord", "destinations"), ws.path("/discord/destinations"));
  const events = useApiQuery<DiscordEventEntry[]>(ws.key("discord", "events"), ws.path("/discord/events"));
  const templates = useApiQuery<DiscordTemplates>(ws.key("discord", "templates"), ws.path("/discord/templates"));
  const [editing, setEditing] = useState<DiscordRule | "new" | null>(null);
  const ready = destinations.data !== undefined && events.data !== undefined;
  const dests = useMemo(() => destinations.data ?? [], [destinations.data]);

  const add = canManage ? (
    <Button variant="secondary" icon={<Plus />} disabled={!ready} onClick={() => setEditing("new")}>
      New rule
    </Button>
  ) : undefined;

  const custom = (rules.data ?? []).filter((r) => !MAP_NAMES.has(r.name));

  return (
    <div className="flex flex-col gap-6">
      {destinations.data?.length === 0 && (
        <Callout tone="info" title="First, choose your channels">
          Connect your server and tick the channels Growthdesk may post in on the Servers &amp; channels tab. Then pick one for each notification here.
        </Callout>
      )}
      <QueryState query={rules} loading={<SkeletonText lines={8} />}>
        {(rows) => <DiscordQuickMap rules={rows} destinations={dests} templates={templates.data} onEdit={setEditing} />}
      </QueryState>

      {rules.data && (
        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-text-hi">Custom rules</h2>
              <p className="text-xs text-text-3">For anything else: several events, several channels, or conditions such as “only deals over $10,000”.</p>
            </div>
            {add}
          </div>
          {custom.length > 0 ? (
            <Card>
              <ul className="divide-y divide-line">
                {custom.map((r) => (
                  <RuleRow key={r.id} rule={r} destinations={dests} onEdit={() => setEditing(r)} />
                ))}
              </ul>
            </Card>
          ) : (
            <p className="text-xs text-text-3">None yet.</p>
          )}
        </section>
      )}

      <Unrouted key={`${overview.settings.unrouted}-${overview.settings.fallbackDestinationId}`} overview={overview} destinations={dests} />

      {editing && ready && <RuleEditor rule={editing === "new" ? null : editing} destinations={dests} events={events.data!} templates={templates.data} onClose={() => setEditing(null)} />}
    </div>
  );
}
