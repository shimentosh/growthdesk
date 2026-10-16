"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp, FlaskConical, Plus, Route, Save, Trash2 } from "lucide-react";
import type { LeadRoutingT, RoutingAssignT, RoutingMode, RoutingRuleT } from "@growthdesk/shared";
import { MemberChecklist, TagListInput } from "@/components/automation/fields";
import { useMarketingLists } from "@/components/marketing/common";
import { ContactPicker, contactLabel } from "@/components/pickers/Pickers";
import { Badge } from "@/components/ui/Badge";
import { Button, IconButton } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Checkbox } from "@/components/ui/Checkbox";
import { QueryState } from "@/components/ui/ErrorState";
import { Field, FormError } from "@/components/ui/Field";
import { EntityTile } from "@/components/ui/icons";
import { Input, NativeSelect } from "@/components/ui/Input";
import { PageHeader } from "@/components/ui/PageHeader";
import { RequirePermission } from "@/components/ui/RequirePermission";
import { SkeletonText } from "@/components/ui/Skeleton";
import { Switch } from "@/components/ui/Switch";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import { useUnsavedChanges } from "@/lib/unsaved";

/*
 * Settings → Lead routing (PUT /lead-routing; rules in packages/shared/src/lead-routing.ts):
 * who owns a new lead, by ordered rules and a fallback, for every lead however it arrives.
 */

const MODES: { value: RoutingMode; label: string; hint: string }[] = [
  { value: "round_robin", label: "Round robin", hint: "Each person in turn." },
  { value: "balanced", label: "Fewest open leads", hint: "Whoever holds the fewest leads in progress — evens out workload." },
  { value: "user", label: "One person", hint: "Always the same teammate." },
];

const newRule = (): RoutingRuleT => ({
  id: `r_${Math.random().toString(36).slice(2, 10)}`,
  name: "New rule",
  enabled: true,
  when: { leadSources: [], lists: [], tags: [], countries: [] },
  assign: { mode: "round_robin", userIds: [] },
});

/** "a, b , c" ⇄ ["a", "b", "c"] for free-text conditions. */
const splitWords = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

function WordsInput({ value, onChange, placeholder }: { value: string[]; onChange: (v: string[]) => void; placeholder: string }) {
  const [text, setText] = useState(value.join(", "));
  return <Input value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)} onBlur={() => onChange(splitWords(text))} />;
}

/** Teams to pick a pool from (GET /teams). */
function useTeamOptions() {
  const ws = useWorkspace();
  const teams = useApiQuery<{ teams: { id: string; name: string; members: unknown[] }[] }>(ws.key("teams"), ws.path("/teams"));
  return (teams.data?.teams ?? []).map((t) => ({ value: t.id, label: `${t.name} · ${t.members.length} ${t.members.length === 1 ? "person" : "people"}` }));
}

function AssignEditor({ value, onChange }: { value: RoutingAssignT; onChange: (v: RoutingAssignT) => void }) {
  const mode = MODES.find((m) => m.value === value.mode)!;
  const teams = useTeamOptions();
  const byTeam = Boolean(value.teamId);
  return (
    <div className="grid gap-3">
      <Field label="Assign to" hint={mode.hint}>
        <NativeSelect
          value={value.mode}
          className="w-auto min-w-48"
          onChange={(e) => {
            const m = e.target.value as RoutingMode;
            onChange(m === "user" ? { mode: m, teamId: null, userIds: value.userIds.slice(0, 1) } : { ...value, mode: m });
          }}
          options={MODES.map((m) => ({ value: m.value, label: m.label }))}
        />
      </Field>
      {value.mode !== "user" && (
        <Field label="From">
          <NativeSelect
            value={byTeam ? "team" : "people"}
            className="w-auto min-w-48"
            onChange={(e) => onChange(e.target.value === "team" ? { ...value, teamId: teams[0]?.value ?? null, userIds: [] } : { ...value, teamId: null })}
            options={[
              { value: "people", label: "These people" },
              { value: "team", label: "A team (as it is when the lead arrives)" },
            ]}
          />
        </Field>
      )}
      {value.mode !== "user" && byTeam ? (
        <Field label="Team" hint={teams.length ? "New members join the rotation automatically." : "Create teams under Settings → Teams first."}>
          <NativeSelect value={value.teamId ?? ""} onChange={(e) => onChange({ ...value, teamId: e.target.value || null })} options={teams} placeholder="Choose a team" />
        </Field>
      ) : (
        <MemberChecklist
          value={value.userIds}
          onChange={(ids) => onChange({ ...value, teamId: null, userIds: value.mode === "user" ? ids.filter((i) => !value.userIds.includes(i)).slice(-1) : ids })}
          emptyHint={value.mode === "user" ? "Choose one teammate." : "Choose the teammates who take turns."}
        />
      )}
    </div>
  );
}

function RuleCard({
  rule,
  index,
  count,
  onChange,
  onMove,
  onRemove,
}: {
  rule: RoutingRuleT;
  index: number;
  count: number;
  onChange: (r: RoutingRuleT) => void;
  onMove: (to: number) => void;
  onRemove: () => void;
}) {
  const lists = useMarketingLists();
  const when = rule.when;
  const setWhen = (patch: Partial<RoutingRuleT["when"]>) => onChange({ ...rule, when: { ...when, ...patch } });
  const empty = !when.leadSources.length && !when.lists.length && !when.tags.length && !when.countries.length;
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
        <span className="flex size-6 items-center justify-center rounded-full bg-s-3 text-xs font-semibold text-text-2 tabular-nums">{index + 1}</span>
        <Input value={rule.name} maxLength={120} onChange={(e) => onChange({ ...rule, name: e.target.value })} className="h-8 w-auto min-w-48 flex-1 font-medium" aria-label="Rule name" />
        <Switch size="sm" checked={rule.enabled} onCheckedChange={(on) => onChange({ ...rule, enabled: on })} label={<span className="text-xs text-text-2">On</span>} />
        <IconButton size="sm" label="Move up" icon={<ArrowUp />} disabled={index === 0} onClick={() => onMove(index - 1)} />
        <IconButton size="sm" label="Move down" icon={<ArrowDown />} disabled={index === count - 1} onClick={() => onMove(index + 1)} />
        <IconButton size="sm" variant="danger" label="Delete rule" icon={<Trash2 />} onClick={onRemove} />
      </div>
      <CardBody className="grid gap-5 lg:grid-cols-2">
        <div className="grid gap-3">
          <div className="text-xs font-semibold tracking-wide text-text-3 uppercase">When a new lead…</div>
          <Field label="Lead source contains" hint="Any of these, e.g. Clientdesk, Website, Webinar.">
            <WordsInput value={when.leadSources} onChange={(v) => setWhen({ leadSources: v })} placeholder="Clientdesk, Website" />
          </Field>
          <Field label="Is on the list">
            <div className="flex max-h-36 flex-col gap-1 overflow-y-auto rounded-sm border border-line p-2">
              {(lists.data ?? []).length === 0 && <span className="text-xs text-text-3">No lead lists yet.</span>}
              {(lists.data ?? []).map((l) => (
                <Checkbox
                  key={l.id}
                  checked={when.lists.some((x) => x.toLowerCase() === l.name.toLowerCase())}
                  onCheckedChange={(on) => setWhen({ lists: on ? [...when.lists, l.name] : when.lists.filter((x) => x.toLowerCase() !== l.name.toLowerCase()) })}
                  label={l.name}
                />
              ))}
            </div>
          </Field>
          <Field label="Has a tag">
            <TagListInput value={when.tags} onChange={(v) => setWhen({ tags: v })} />
          </Field>
          <Field label="Country is" hint="Any of these, as written on the contact.">
            <WordsInput value={when.countries} onChange={(v) => setWhen({ countries: v })} placeholder="BD, Bangladesh, US" />
          </Field>
          {empty && <p className="text-xs text-warn-ink">No conditions: this rule takes every lead that reaches it.</p>}
        </div>
        <div className="grid content-start gap-3">
          <div className="text-xs font-semibold tracking-wide text-text-3 uppercase">…it goes to</div>
          <AssignEditor value={rule.assign} onChange={(a) => onChange({ ...rule, assign: a })} />
        </div>
      </CardBody>
    </Card>
  );
}

function TestCard() {
  const ws = useWorkspace();
  const [picked, setPicked] = useState<{ id: string; label: string } | null>(null);
  const test = useApiMutation<{ rule: { id: string; name: string } | null; fallback: boolean; ownerName: string | null }, { contactId: string }>({
    path: ws.path("/lead-routing/test"),
    errorToast: true,
  });
  const r = test.data;
  return (
    <Card>
      <CardHeader icon={<FlaskConical />} title="Try it on a contact" description="Uses the saved rules. Nothing is changed." />
      <CardBody className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
        <Field label="Contact">
          <ContactPicker
            value={picked?.id ?? null}
            valueLabel={picked?.label ?? null}
            placeholder="Search a contact"
            onChange={(id, c) => {
              setPicked(id && c ? { id, label: contactLabel(c) } : null);
              test.reset();
            }}
          />
        </Field>
        <Button icon={<Route />} disabled={!picked} loading={test.isPending} onClick={() => picked && test.mutate({ contactId: picked.id })}>
          Route
        </Button>
        {r && (
          <p className="text-sm text-text sm:col-span-2">
            {r.rule ? (
              <>
                Rule <Badge tone="info">{r.rule.name}</Badge>
              </>
            ) : r.fallback ? (
              <Badge>Fallback</Badge>
            ) : (
              "No rule takes it and there is no fallback"
            )}
            {r.ownerName ? (
              <>
                {" "}
                → <span className="font-medium">{r.ownerName}</span>
              </>
            ) : r.rule || r.fallback ? (
              " → nobody available in that pool"
            ) : null}
          </p>
        )}
      </CardBody>
    </Card>
  );
}

function Editor({ saved }: { saved: LeadRoutingT }) {
  const ws = useWorkspace();
  const canEdit = ws.can("settings.manage");
  const [base, setBase] = useState(saved);
  const [cfg, setCfg] = useState(saved);
  const dirty = JSON.stringify(base) !== JSON.stringify(cfg);
  useUnsavedChanges(dirty && canEdit, "Your lead routing changes will be lost.");
  const save = useApiMutation<LeadRoutingT, LeadRoutingT>({
    method: "PUT",
    path: ws.path("/lead-routing"),
    invalidate: [ws.key("lead-routing")],
    success: "Lead routing saved",
    errorToast: false,
    onSuccess: (r) => {
      setBase(r);
      setCfg(r);
    },
  });
  const setRule = (i: number, r: RoutingRuleT) => setCfg((c) => ({ ...c, rules: c.rules.map((x, j) => (j === i ? r : x)) }));
  const move = (from: number, to: number) =>
    setCfg((c) => {
      const rules = [...c.rules];
      const [r] = rules.splice(from, 1);
      if (r) rules.splice(to, 0, r);
      return { ...c, rules };
    });
  const empty = (a: RoutingAssignT) => !a.teamId && !a.userIds.length;
  const invalid = cfg.rules.some((r) => !r.name.trim() || empty(r.assign)) || (cfg.fallback !== null && empty(cfg.fallback));

  return (
    <fieldset disabled={!canEdit} className="flex min-w-0 flex-col gap-4">
      {save.error && <FormError error={save.error.message} />}
      <Card>
        <CardBody className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-medium text-text-hi">Route new leads automatically</div>
            <div className="text-xs text-text-3">Every new lead without an owner — from forms, the API, Clientdesk, imports, the inbox or an AI agent — gets one a few seconds after it lands. Owners are told.</div>
          </div>
          <Switch checked={cfg.enabled} onCheckedChange={(on) => setCfg((c) => ({ ...c, enabled: on }))} label={<span className="text-sm">{cfg.enabled ? "On" : "Off"}</span>} />
        </CardBody>
      </Card>

      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-text-hi">Rules · checked top to bottom, the first match wins</h2>
        {canEdit && (
          <Button size="sm" icon={<Plus />} onClick={() => setCfg((c) => ({ ...c, rules: [...c.rules, newRule()] }))} disabled={cfg.rules.length >= 50}>
            Add rule
          </Button>
        )}
      </div>
      {cfg.rules.length === 0 && <Callout tone="info">No rules yet. Add one per source or team — e.g. “Clientdesk website forms → sales team, fewest open leads”.</Callout>}
      {cfg.rules.map((r, i) => (
        <RuleCard
          key={r.id}
          rule={r}
          index={i}
          count={cfg.rules.length}
          onChange={(x) => setRule(i, x)}
          onMove={(to) => move(i, to)}
          onRemove={() => setCfg((c) => ({ ...c, rules: c.rules.filter((_, j) => j !== i) }))}
        />
      ))}

      <Card>
        <CardHeader icon={<Route />} title="Everything else" description="Leads no rule takes." />
        <CardBody className="grid gap-3">
          <Checkbox
            checked={cfg.fallback !== null}
            onCheckedChange={(on) => setCfg((c) => ({ ...c, fallback: on ? { mode: "round_robin", userIds: [] } : null }))}
            label="Assign them too"
            description="Off: they stay unowned, in the Leads list's Unassigned filter."
          />
          {cfg.fallback && <AssignEditor value={cfg.fallback} onChange={(a) => setCfg((c) => ({ ...c, fallback: a }))} />}
        </CardBody>
      </Card>

      {canEdit && (
        <div className="sticky bottom-0 flex items-center justify-end gap-2 border-t border-line bg-bg/90 py-3 backdrop-blur">
          {dirty && <span className="mr-auto text-xs text-text-3">Unsaved changes</span>}
          {invalid && <span className="text-xs text-warn-ink">Each rule needs a name and a team or at least one teammate.</span>}
          <Button disabled={!dirty || save.isPending} onClick={() => setCfg(base)}>
            Discard
          </Button>
          <Button variant="primary" icon={<Save />} loading={save.isPending} disabled={!dirty || invalid} onClick={() => save.mutate(cfg)}>
            Save
          </Button>
        </div>
      )}
      <TestCard />
    </fieldset>
  );
}

export function LeadRoutingSettings() {
  const ws = useWorkspace();
  const cfg = useApiQuery<LeadRoutingT>(ws.key("lead-routing"), ws.path("/lead-routing"));
  return (
    <RequirePermission permission="members.read">
      <PageHeader icon={<EntityTile of="leads" />} title="Lead routing" description="Who owns a new lead — so none sits unowned and nobody has to hand them out." />
      <QueryState
        query={cfg}
        loading={
          <Card className="p-4">
            <SkeletonText lines={5} />
          </Card>
        }
      >
        {(c) => <Editor saved={c} />}
      </QueryState>
    </RequirePermission>
  );
}
