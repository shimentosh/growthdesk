"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp, Flame, Gauge, Pencil, Plus, RefreshCw, Save, Sparkles, Trash2 } from "lucide-react";
import {
  SCORING_EVENTS,
  SCORING_FIT_FIELDS,
  SCORING_OP_LABELS,
  SCORING_OPS,
  scoringEventLabel,
  scoringRuleProblem,
  type LeadScoringSettingsT,
  type ScoringCategory,
  type ScoringOp,
  type ScoringRuleFieldsT,
  type ScoringRuleT,
} from "@growthdesk/shared";
import { useCustomFields } from "@/components/crm/CustomFieldsCard";
import { Table, Td, Th } from "@/components/imports/Table";
import { Badge } from "@/components/ui/Badge";
import { Button, IconButton } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/Card";
import { ConfirmDialog, Modal } from "@/components/ui/Dialog";
import { QueryState } from "@/components/ui/ErrorState";
import { Field, FormError } from "@/components/ui/Field";
import { IconTile } from "@/components/ui/IconTile";
import { Input, NativeSelect } from "@/components/ui/Input";
import { PageHeader } from "@/components/ui/PageHeader";
import { RequirePermission } from "@/components/ui/RequirePermission";
import { SkeletonText } from "@/components/ui/Skeleton";
import { StatCard } from "@/components/ui/StatCard";
import { Switch } from "@/components/ui/Switch";
import { formatNumber } from "@/lib/format";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import { useUnsavedChanges } from "@/lib/unsaved";

/*
 * Settings → Lead scoring (GET /scoring; rules and math in packages/shared/src/scoring.ts):
 * on/off and the hot/warm thresholds, fit and engagement rules, the recommended set, and
 * "Recalculate all". While on, the computed score owns Contact.score.
 */

type Overview = { settings: LeadScoringSettingsT; rules: ScoringRuleT[]; stats: { hot: number; warm: number; scored: number } };
type RuleDraft = Omit<ScoringRuleFieldsT, "op"> & { op: ScoringOp | "" };

const blankRule = (category: ScoringCategory): RuleDraft =>
  category === "fit"
    ? { name: "", category, field: "jobTitle", op: "contains", value: "", event: "", points: 10, maxPoints: null, decayDays: null, active: true }
    : { name: "", category, field: "", op: "", value: "", event: "email.opened", points: 5, maxPoints: null, decayDays: 30, active: true };

const fieldLabel = (field: string) => SCORING_FIT_FIELDS.find((f) => f.key === field)?.label ?? (field.startsWith("custom.") ? field.slice(7) : field);
const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : "0");

/** "Job title contains founder, ceo" / "Phone is filled in". */
export function ruleCondition(r: Pick<ScoringRuleT, "category" | "field" | "op" | "value" | "event">) {
  if (r.category === "engagement") return scoringEventLabel(r.event);
  const op = r.op ? SCORING_OP_LABELS[r.op] : "";
  return [fieldLabel(r.field), op, r.op === "exists" ? "" : r.value].filter(Boolean).join(" ");
}

/** Optional whole number: "" ⇄ null. */
function NumberInput({ value, onChange, min, max, placeholder, ...rest }: { value: number | null; onChange: (v: number | null) => void; min: number; max: number; placeholder?: string; "aria-label"?: string }) {
  return (
    <Input
      {...rest}
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      placeholder={placeholder}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value === "" ? null : Math.round(Number(e.target.value)))}
      className="w-28"
    />
  );
}

function RuleModal({ initial, onClose }: { initial: (RuleDraft & { id?: string }) | null; onClose: () => void }) {
  const ws = useWorkspace();
  const customFields = useCustomFields("contact");
  const [draft, setDraft] = useState<RuleDraft & { id?: string }>(initial ?? blankRule("fit"));
  const set = (patch: Partial<RuleDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const editing = Boolean(draft.id);
  const save = useApiMutation<ScoringRuleT, RuleDraft & { id?: string }>({
    method: editing ? "PATCH" : "POST",
    path: (d) => ws.path(d.id ? `/scoring/rules/${d.id}` : "/scoring/rules"),
    body: ({ id: _id, ...d }) => d,
    invalidate: [ws.key("scoring")],
    success: editing ? "Rule saved" : "Rule added",
    errorToast: false,
    onSuccess: onClose,
  });
  const problem = !draft.name.trim() ? "Give the rule a name" : scoringRuleProblem({ ...draft, op: draft.op || "is" } as ScoringRuleFieldsT)?.[1];
  const fit = draft.category === "fit";
  const custom = draft.field.startsWith("custom.");
  const flag = SCORING_EVENTS.find((e) => e.key === draft.event)?.flag ?? false;

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      dismissOnOutside={false}
      title={editing ? "Edit scoring rule" : fit ? "New fit rule" : "New engagement rule"}
      description={fit ? "Points for who the contact is, from their own fields." : "Points for what the contact did, counted from activity in a time window."}
      footer={
        <>
          {problem && <span className="mr-auto text-xs text-text-3">{problem}</span>}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} disabled={Boolean(problem)} onClick={() => save.mutate(draft)}>
            {editing ? "Save" : "Add rule"}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {save.error && <FormError error={save.error.message} />}
        <Field label="Name" error={save.error?.fields.name}>
          <Input value={draft.name} maxLength={120} autoFocus placeholder={fit ? "Decision-maker title" : "Opened a sales email"} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        {fit ? (
          <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
            <Field label="Contact field" error={save.error?.fields.field}>
              <NativeSelect value={custom ? "custom" : draft.field} onChange={(e) => set({ field: e.target.value === "custom" ? `custom.${customFields.data?.[0]?.key ?? ""}` : e.target.value })}>
                {SCORING_FIT_FIELDS.map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.label}
                  </option>
                ))}
                <option value="custom">Custom field…</option>
              </NativeSelect>
            </Field>
            <Field label="Is" error={save.error?.fields.op}>
              <NativeSelect value={draft.op} className="w-auto min-w-36" onChange={(e) => set({ op: e.target.value as ScoringOp })} options={SCORING_OPS.map((o) => ({ value: o, label: SCORING_OP_LABELS[o] }))} />
            </Field>
            {custom && (
              <Field label="Custom field" className="sm:col-span-2">
                {(customFields.data ?? []).length ? (
                  <NativeSelect value={draft.field.slice(7)} onChange={(e) => set({ field: `custom.${e.target.value}` })} options={(customFields.data ?? []).map((f) => ({ value: f.key, label: f.label }))} />
                ) : (
                  <Input value={draft.field.slice(7)} placeholder="field_key" onChange={(e) => set({ field: `custom.${e.target.value.replace(/[^A-Za-z0-9_-]/g, "")}` })} />
                )}
              </Field>
            )}
            {draft.op !== "exists" && (
              <Field label="Value" hint={draft.op === "gt" || draft.op === "lt" ? "A number." : "Several values: separate them with commas — any of them matches. Case doesn't matter."} className="sm:col-span-2" error={save.error?.fields.value}>
                <Input value={draft.value} maxLength={500} placeholder={draft.op === "gt" || draft.op === "lt" ? "100" : "founder, ceo, owner"} onChange={(e) => set({ value: e.target.value })} />
              </Field>
            )}
          </div>
        ) : (
          <>
            <Field label="When the contact…" error={save.error?.fields.event}>
              <NativeSelect value={draft.event} onChange={(e) => set({ event: e.target.value })} options={SCORING_EVENTS.map((e) => ({ value: e.key, label: e.label }))} />
            </Field>
            {!flag && (
              <div className="flex flex-wrap gap-4">
                <Field label="At most" hint="Total points from repeats. Empty: no cap.">
                  <NumberInput value={draft.maxPoints} min={1} max={100} placeholder="No cap" onChange={(v) => set({ maxPoints: v })} aria-label="Maximum points" />
                </Field>
                <Field label="Counting the last (days)" hint="Older events stop counting. Empty: all time.">
                  <NumberInput value={draft.decayDays} min={1} max={3650} placeholder="All time" onChange={(v) => set({ decayDays: v })} aria-label="Days" />
                </Field>
              </div>
            )}
          </>
        )}
        <Field label="Points" hint={fit ? "Negative points lower the score (e.g. a competitor's domain)." : flag ? "Counted once while it's true. Use negative points to lower the score." : "Each time it happens. Negative points lower the score."}>
          <NumberInput value={draft.points} min={-100} max={100} onChange={(v) => set({ points: v ?? 0 })} aria-label="Points" />
        </Field>
        <Switch checked={draft.active} onCheckedChange={(on) => set({ active: on })} label="Active" />
      </div>
    </Modal>
  );
}

function RulesCard({
  category,
  rules,
  all,
  canEdit,
  onEdit,
  onAdd,
}: {
  category: ScoringCategory;
  rules: ScoringRuleT[];
  all: ScoringRuleT[];
  canEdit: boolean;
  onEdit: (r: ScoringRuleT) => void;
  onAdd: () => void;
}) {
  const ws = useWorkspace();
  const [deleting, setDeleting] = useState<ScoringRuleT | null>(null);
  const invalidate = [ws.key("scoring")];
  const toggle = useApiMutation<ScoringRuleT, { id: string; active: boolean }>({ method: "PATCH", path: (v) => ws.path(`/scoring/rules/${v.id}`), body: (v) => ({ active: v.active }), invalidate });
  const reorder = useApiMutation<ScoringRuleT[], string[]>({ path: ws.path("/scoring/rules/reorder"), body: (ids) => ({ ids }), invalidate });
  const remove = useApiMutation<{ deleted: true }, string>({ method: "DELETE", path: (id) => ws.path(`/scoring/rules/${id}`), invalidate, success: "Rule deleted", errorToast: false });

  /** Swaps a rule with its neighbour in this card, keeping the other card's rules where they are. */
  const move = (i: number, to: number) => {
    const a = rules[i];
    const b = rules[to];
    if (!a || !b) return;
    reorder.mutate(all.map((r) => (r.id === a.id ? b.id : r.id === b.id ? a.id : r.id)));
  };
  const fit = category === "fit";

  return (
    <Card>
      <CardHeader
        icon={fit ? <Gauge /> : <Flame />}
        title={fit ? "Fit · who they are" : "Engagement · what they did"}
        description={fit ? "From the contact's own fields. Checked whenever the contact changes." : "Counted from emails, replies, meetings, calls, quotes and marketing email. Each rule counts only its window, so points fade."}
        actions={
          canEdit ? (
            <Button size="sm" icon={<Plus />} onClick={onAdd}>
              Add rule
            </Button>
          ) : undefined
        }
      />
      {rules.length === 0 ? (
        <p className="px-4 py-6 text-center text-xs text-text-3">No {fit ? "fit" : "engagement"} rules yet.</p>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Rule</Th>
              <Th>{fit ? "When" : "Event"}</Th>
              <Th align="right">Points</Th>
              {!fit && <Th>Limits</Th>}
              <Th>Active</Th>
              {canEdit && (
                <Th className="w-36">
                  <span className="sr-only">Actions</span>
                </Th>
              )}
            </tr>
          </thead>
          <tbody>
            {rules.map((r, i) => (
              <tr key={r.id} className="hover:bg-hover">
                <Td className="font-medium text-text-hi">{r.name}</Td>
                <Td className="text-text-2">{ruleCondition(r)}</Td>
                <Td align="right">
                  <Badge tone={r.points < 0 ? "bad" : "ok"}>{signed(r.points)}</Badge>
                </Td>
                {!fit && (
                  <Td className="text-xs whitespace-nowrap text-text-3">
                    {[r.maxPoints ? `max ${r.maxPoints}` : null, r.decayDays ? `last ${r.decayDays} days` : null].filter(Boolean).join(" · ") || "—"}
                  </Td>
                )}
                <Td className="py-1">
                  <Switch size="sm" checked={r.active} disabled={!canEdit || toggle.isPending} onCheckedChange={(on) => toggle.mutate({ id: r.id, active: on })} aria-label={`${r.name} active`} />
                </Td>
                {canEdit && (
                  <Td className="py-1">
                    <div className="flex justify-end gap-0.5">
                      <IconButton size="sm" label="Move up" icon={<ArrowUp />} disabled={i === 0 || reorder.isPending} onClick={() => move(i, i - 1)} />
                      <IconButton size="sm" label="Move down" icon={<ArrowDown />} disabled={i === rules.length - 1 || reorder.isPending} onClick={() => move(i, i + 1)} />
                      <IconButton size="sm" label={`Edit ${r.name}`} icon={<Pencil />} onClick={() => onEdit(r)} />
                      <IconButton size="sm" variant="danger" label={`Delete ${r.name}`} icon={<Trash2 />} onClick={() => setDeleting(r)} />
                    </div>
                  </Td>
                )}
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete “${deleting?.name}”?`}
        description="Scores are recalculated without it in the next few seconds."
        onConfirm={() => deleting && remove.mutateAsync(deleting.id)}
      />
    </Card>
  );
}

function SettingsCard({ saved, stats, canEdit }: { saved: LeadScoringSettingsT; stats: Overview["stats"]; canEdit: boolean }) {
  const ws = useWorkspace();
  const [base, setBase] = useState(saved);
  const [cfg, setCfg] = useState(saved);
  const dirty = JSON.stringify(base) !== JSON.stringify(cfg);
  useUnsavedChanges(dirty && canEdit, "Your lead scoring settings will be lost.");
  const save = useApiMutation<LeadScoringSettingsT, LeadScoringSettingsT>({
    method: "PUT",
    path: ws.path("/scoring/settings"),
    invalidate: [ws.key("scoring"), ws.key("contacts")],
    success: (r) => (r.enabled && !base.enabled ? "Lead scoring is on — scoring every contact now" : "Lead scoring saved"),
    errorToast: false,
    onSuccess: (r) => {
      setBase(r);
      setCfg(r);
    },
  });
  const invalid = cfg.warm >= cfg.hot ? "Warm must be lower than hot." : null;

  return (
    <Card>
      <CardBody className="grid gap-4">
        {save.error && <FormError error={save.error.message} />}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-medium text-text-hi">Score leads automatically</div>
            <div className="text-xs text-text-3">Every contact gets a 0–100 score from the rules below, kept up to date as they open, reply, book and buy. While on, it replaces scores set by hand or by the lead API.</div>
          </div>
          <Switch checked={cfg.enabled} disabled={!canEdit} onCheckedChange={(on) => setCfg((c) => ({ ...c, enabled: on }))} label={<span className="text-sm">{cfg.enabled ? "On" : "Off"}</span>} />
        </div>
        <div className="flex flex-wrap gap-4">
          <Field label="Hot at" hint="The owner is told the first time a lead gets here.">
            <NumberInput value={cfg.hot} min={1} max={100} onChange={(v) => setCfg((c) => ({ ...c, hot: v ?? 0 }))} aria-label="Hot threshold" />
          </Field>
          <Field label="Warm at" hint="Below this, a lead is cold." error={invalid ?? undefined}>
            <NumberInput value={cfg.warm} min={0} max={99} onChange={(v) => setCfg((c) => ({ ...c, warm: v ?? 0 }))} aria-label="Warm threshold" />
          </Field>
        </div>
        {saved.enabled && (
          <div className="grid gap-3 sm:grid-cols-3">
            <StatCard label="Hot leads" value={formatNumber(stats.hot)} icon={<Flame />} tint="red" href={ws.href("/leads")} />
            <StatCard label="Warm leads" value={formatNumber(stats.warm)} icon={<Gauge />} tint="orange" />
            <StatCard label="Contacts scored" value={formatNumber(stats.scored)} icon={<Sparkles />} tint="indigo" />
          </div>
        )}
      </CardBody>
      {canEdit && (
        <CardFooter>
          {dirty && <span className="mr-auto text-xs text-text-3">Unsaved changes</span>}
          <Button disabled={!dirty || save.isPending} onClick={() => setCfg(base)}>
            Discard
          </Button>
          <Button variant="primary" icon={<Save />} loading={save.isPending} disabled={!dirty || Boolean(invalid) || !cfg.hot} onClick={() => save.mutate(cfg)}>
            Save
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}

function Editor({ data }: { data: Overview }) {
  const ws = useWorkspace();
  const canEdit = ws.can("settings.manage");
  const [editing, setEditing] = useState<(RuleDraft & { id?: string }) | null | undefined>(undefined);
  const [recommending, setRecommending] = useState(false);
  const invalidate = [ws.key("scoring")];
  const recommended = useApiMutation<ScoringRuleT[], { replace: boolean }>({
    path: ws.path("/scoring/recommended"),
    invalidate,
    success: (_r, v) => (v.replace ? "Rules replaced with the recommended set" : "Recommended rules added"),
    onSuccess: () => setRecommending(false),
  });
  const recalc = useApiMutation<{ queued: boolean; contacts: number }, void>({
    path: ws.path("/scoring/recalculate"),
    invalidate: [...invalidate, ws.key("contacts")],
    success: (r) => `Recalculating ${formatNumber(r.contacts)} ${r.contacts === 1 ? "contact" : "contacts"} — this takes a moment`,
  });
  const fit = data.rules.filter((r) => r.category === "fit");
  const engagement = data.rules.filter((r) => r.category === "engagement");

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <SettingsCard key={JSON.stringify(data.settings)} saved={data.settings} stats={data.stats} canEdit={canEdit} />

      {canEdit && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button icon={<Sparkles />} onClick={() => (data.rules.length ? setRecommending(true) : recommended.mutate({ replace: false }))} loading={recommended.isPending && !recommending}>
            Use recommended rules
          </Button>
          <Button icon={<RefreshCw />} disabled={!data.settings.enabled} loading={recalc.isPending} onClick={() => recalc.mutate()} title={data.settings.enabled ? "Rescore every contact now" : "Turn lead scoring on first"}>
            Recalculate all
          </Button>
        </div>
      )}
      {data.rules.length === 0 && (
        <Callout tone="info" title="No rules yet">
          Start with the recommended rules — decision-maker titles, opens, clicks, replies, meetings, call outcomes and quotes, minus unsubscribes and bounces — then adjust the points to fit your sales.
          {data.settings.enabled ? " With no rules, every contact scores 0." : ""}
        </Callout>
      )}

      <RulesCard category="fit" rules={fit} all={data.rules} canEdit={canEdit} onEdit={(r) => setEditing(r)} onAdd={() => setEditing(blankRule("fit"))} />
      <RulesCard category="engagement" rules={engagement} all={data.rules} canEdit={canEdit} onEdit={(r) => setEditing(r)} onAdd={() => setEditing(blankRule("engagement"))} />

      {editing !== undefined && <RuleModal key={editing?.id ?? editing?.category ?? "new"} initial={editing} onClose={() => setEditing(undefined)} />}
      <Modal
        open={recommending}
        onOpenChange={setRecommending}
        title="Use the recommended rules?"
        description="Add the ones you don't have yet (matched by name), or start over with exactly the recommended set."
        footer={
          <>
            <Button onClick={() => setRecommending(false)}>Cancel</Button>
            <Button variant="danger" loading={recommended.isPending && recommended.variables?.replace} onClick={() => recommended.mutate({ replace: true })}>
              Replace all rules
            </Button>
            <Button variant="primary" loading={recommended.isPending && !recommended.variables?.replace} onClick={() => recommended.mutate({ replace: false })}>
              Add missing
            </Button>
          </>
        }
      />
    </div>
  );
}

export function LeadScoringSettings() {
  const ws = useWorkspace();
  const overview = useApiQuery<Overview>(ws.key("scoring"), ws.path("/scoring"));
  return (
    <RequirePermission permission="contacts.read">
      <PageHeader icon={<IconTile icon={<Gauge />} tint="orange" size="lg" />} title="Lead scoring" description="A 0–100 score on every contact — who they are plus what they did — so the hottest leads rise to the top." />
      <QueryState
        query={overview}
        loading={
          <Card className="p-4">
            <SkeletonText lines={6} />
          </Card>
        }
      >
        {(d) => <Editor data={d} />}
      </QueryState>
    </RequirePermission>
  );
}
