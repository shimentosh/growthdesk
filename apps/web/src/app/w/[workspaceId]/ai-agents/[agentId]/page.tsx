"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { useParams, useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  CircleAlert,
  CodeXml,
  Copy,
  Ellipsis,
  ListOrdered,
  MessageSquareQuote,
  PhoneForwarded,
  PhoneOutgoing,
  RefreshCw,
  ScrollText,
  UserRound,
} from "lucide-react";
import { AI_AGENT_GOAL_LABELS, AI_AGENT_GOALS, AI_AGENT_LANGUAGES, composeInitialMessage, mentionsAi, type AiAgentGoal, type AiAgentInputT, type AiAgentLanguage } from "@growthdesk/shared";
import { useAiCallingSetup } from "@/components/ai-calling/hooks";
import { ObjectionsEditor, QuestionsEditor, ScriptText, type Objection } from "@/components/ai-calling/ListEditors";
import { SyncBadge } from "@/components/ai-calling/SyncBadge";
import { TestCallModal } from "@/components/ai-calling/TestCallModal";
import { VoicePicker } from "@/components/ai-calling/VoicePicker";
import { Badge, StatusBadge } from "@/components/ui/Badge";
import { Button, IconButton } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/DropdownMenu";
import { QueryState } from "@/components/ui/ErrorState";
import { Field, FormError } from "@/components/ui/Field";
import { EntityTile } from "@/components/ui/icons";
import { Input } from "@/components/ui/Input";
import { KeyValueList } from "@/components/ui/KeyValue";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { RequirePermission } from "@/components/ui/RequirePermission";
import { Select } from "@/components/ui/Select";
import { SkeletonText } from "@/components/ui/Skeleton";
import { toast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";
import { formatNumber } from "@/lib/format";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import { useUnsavedChanges } from "@/lib/unsaved";
import type { AiAgentDetail } from "@/lib/types/ai-calling";

type Draft = {
  name: string;
  goal: AiAgentGoal;
  language: AiAgentLanguage;
  voiceId: string;
  voiceName: string;
  personaName: string;
  businessName: string;
  greeting: string;
  disclosure: string;
  about: string;
  goalDetails: string;
  questions: string[];
  objections: Objection[];
  voicemailMessage: string;
  extraInstructions: string;
  transferNumber: string;
  /** Text while editing; a number when sent. */
  maxCallMinutes: string;
};

const draftOf = (a: AiAgentDetail): Draft => ({
  name: a.name,
  goal: a.goal,
  language: a.language,
  voiceId: a.voiceId,
  voiceName: a.voiceName,
  personaName: a.personaName,
  businessName: a.businessName,
  greeting: a.greeting,
  disclosure: a.disclosure,
  about: a.about,
  goalDetails: a.goalDetails,
  questions: [...a.questions],
  objections: a.objections.map((o) => ({ ...o })),
  voicemailMessage: a.voicemailMessage,
  extraInstructions: a.extraInstructions,
  transferNumber: a.transferNumber,
  maxCallMinutes: String(a.maxCallMinutes),
});

/** Only the fields that differ from the saved agent: PATCH merges them with the rest and checks the whole. */
function changes(base: Draft, draft: Draft): Partial<AiAgentInputT> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(draft) as (keyof Draft)[]) {
    if (JSON.stringify(base[k]) === JSON.stringify(draft[k])) continue;
    out[k] = k === "maxCallMinutes" ? Number(draft.maxCallMinutes) : draft[k];
  }
  return out as Partial<AiAgentInputT>;
}

function Editor({ agent }: { agent: AiAgentDetail }) {
  const ws = useWorkspace();
  const f = useFormat();
  const router = useRouter();
  const qc = useQueryClient();
  const setup = useAiCallingSetup();
  const canEdit = ws.can("calls.agents");
  const archived = Boolean(agent.archivedAt);
  const readOnly = !canEdit || archived;
  const [baseline, setBaseline] = useState<Draft>(() => draftOf(agent));
  const [draft, setDraft] = useState<Draft>(baseline);
  const [testing, setTesting] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);
  const dirty = JSON.stringify(baseline) !== JSON.stringify(draft);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  useUnsavedChanges(dirty && !readOnly, "Your changes to this agent will be lost.");

  const save = useApiMutation<AiAgentDetail, Partial<AiAgentInputT>>({
    method: "PATCH",
    path: ws.path(`/call-agents/${agent.id}`),
    invalidate: [ws.key("call-agents")],
    success: (saved) => (saved.sync.saved ? "Agent saved" : "Agent saved here, but not on Cartesia"),
    errorToast: false,
    onSuccess: (saved) => {
      const next = draftOf(saved);
      setBaseline(next);
      setDraft(next);
      qc.setQueryData(ws.key("call-agents", saved.id), saved);
    },
  });
  const sync = useApiMutation<AiAgentDetail, void>({
    path: ws.path(`/call-agents/${agent.id}/sync`),
    invalidate: [ws.key("call-agents")],
    onSuccess: (a) => {
      if (a.sync.saved) toast.success("Saved to Cartesia");
      else toast.error(a.sync.error || "Cartesia did not accept the agent");
    },
  });
  const duplicate = useApiMutation<AiAgentDetail, void>({
    path: ws.path(`/call-agents/${agent.id}/duplicate`),
    invalidate: [ws.key("call-agents")],
    success: (a) => `${a.name} created`,
    onSuccess: (a) => router.push(ws.href(`/ai-agents/${a.id}`)),
  });
  const archive = useApiMutation<AiAgentDetail, void>({
    method: "DELETE",
    path: ws.path(`/call-agents/${agent.id}`),
    invalidate: [ws.key("call-agents")],
    success: "Agent archived",
    errorToast: false,
    onSuccess: () => {
      setDraft(baseline);
      save.reset();
    },
  });
  const restore = useApiMutation<AiAgentDetail, void>({
    path: ws.path(`/call-agents/${agent.id}/restore`),
    invalidate: [ws.key("call-agents")],
    success: "Agent restored",
  });

  const fields = save.error?.fields ?? {};
  const disclosureTrouble = draft.disclosure.trim() && !mentionsAi(draft.disclosure) ? "Say that the caller is an AI, for example “I'm an AI assistant”." : undefined;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const patch = changes(baseline, draft);
    if (Object.keys(patch).length) save.mutate(patch);
  };

  const usedBy = agent.usage.campaigns.length + agent.usage.sequences.length;
  const notReady = setup.data && !setup.data.ready ? setup.data.reason : null;
  const canTest = ws.can("calls.make") && !archived;

  return (
    <>
      <PageHeader
        back={{ href: ws.href("/ai-agents"), label: "AI agents" }}
        icon={<EntityTile of="aiAgents" />}
        title={draft.name.trim() || agent.name}
        meta={archived ? <Badge tone="warn">Archived</Badge> : <SyncBadge sync={agent.sync} />}
        description={`${AI_AGENT_GOAL_LABELS[agent.goal]} · speaks as ${agent.personaName} · used by ${usedBy} campaign${usedBy === 1 ? "" : "s"} or sequence${usedBy === 1 ? "" : "s"} · updated ${f.relative(agent.updatedAt)}`}
        actions={
          <>
            {dirty && !readOnly && <span className="text-xs text-text-3">Unsaved changes</span>}
            {canTest && (
              <Button
                icon={<PhoneOutgoing />}
                onClick={() => setTesting(true)}
                disabled={Boolean(notReady)}
                title={notReady ?? (dirty ? "Calls use the saved version: save first to test your changes." : undefined)}
              >
                Test call
              </Button>
            )}
            {canEdit && archived && (
              <Button icon={<ArchiveRestore />} loading={restore.isPending} onClick={() => restore.mutate()}>
                Restore
              </Button>
            )}
            {canEdit && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <IconButton variant="secondary" label="More actions" icon={<Ellipsis />} />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem icon={<Copy />} disabled={duplicate.isPending} onSelect={() => duplicate.mutate()}>
                    Duplicate
                  </DropdownMenuItem>
                  {!archived && (
                    <DropdownMenuItem danger icon={<Archive />} onSelect={() => setConfirmArchive(true)}>
                      Archive
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {!readOnly && dirty && (
              <Button
                onClick={() => {
                  setDraft(baseline);
                  save.reset();
                }}
                disabled={save.isPending}
              >
                Discard
              </Button>
            )}
            {!readOnly && (
              <Button variant="primary" type="submit" form="ai-agent-form" loading={save.isPending} disabled={!dirty}>
                Save
              </Button>
            )}
          </>
        }
      />

      {!canEdit && (
        <Callout tone="info" className="mb-4">
          You can view this agent; your role cannot change it.
        </Callout>
      )}
      {canEdit && archived && (
        <Callout tone="warn" className="mb-4">
          This agent is archived: it places no calls and cannot be edited. Restore it to use it again; its call history is kept either way.
        </Callout>
      )}

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,360px)]">
        <form id="ai-agent-form" onSubmit={submit} noValidate className="min-w-0">
          <fieldset disabled={readOnly} className="flex min-w-0 flex-col gap-4">
            {save.error && !save.error.isPlanLimit && !Object.keys(fields).length && <FormError error={save.error.message} />}

            <Card>
              <CardHeader icon={<UserRound />} title="Identity" description="Who the agent says it is. It always says it is an AI as well." />
              <CardBody className="grid gap-4 sm:grid-cols-2">
                <Field label="Agent name" required hint="For you: shown in campaigns and the call history." error={fields.name} className="sm:col-span-2">
                  <Input value={draft.name} maxLength={80} onChange={(e) => set("name", e.target.value)} />
                </Field>
                <Field label="Name it says" required error={fields.personaName}>
                  <Input value={draft.personaName} maxLength={40} onChange={(e) => set("personaName", e.target.value)} placeholder="Ava" />
                </Field>
                <Field label="Business name" required error={fields.businessName}>
                  <Input value={draft.businessName} maxLength={120} onChange={(e) => set("businessName", e.target.value)} />
                </Field>
                <Field label="Language" error={fields.language}>
                  <Select<AiAgentLanguage>
                    value={draft.language}
                    disabled={readOnly}
                    onValueChange={(v) => set("language", v)}
                    options={AI_AGENT_LANGUAGES.map((l) => ({ value: l.code, label: l.label }))}
                  />
                </Field>
                <Field label="Voice" required hint="Pick a voice that speaks the language." error={fields.voiceId}>
                  <VoicePicker
                    value={draft.voiceId}
                    valueName={draft.voiceName}
                    language={draft.language}
                    disabled={readOnly}
                    onChange={(id, name) => setDraft((d) => ({ ...d, voiceId: id, voiceName: name }))}
                  />
                </Field>
              </CardBody>
            </Card>

            <Card>
              <CardHeader icon={<MessageSquareQuote />} title="Opening" description="What the agent says as soon as the person picks up: the greeting, then the AI disclosure." />
              <CardBody className="flex flex-col gap-4">
                <ScriptText label="Greeting" required rows={2} maxLength={500} readOnly={readOnly} value={draft.greeting} onChange={(v) => set("greeting", v)} error={fields.greeting} />
                <ScriptText
                  label="AI disclosure"
                  required
                  rows={2}
                  maxLength={300}
                  readOnly={readOnly}
                  value={draft.disclosure}
                  onChange={(v) => set("disclosure", v)}
                  error={fields.disclosure ?? disclosureTrouble}
                  hint="Must tell the person they are talking to an AI, e.g. “I'm an AI assistant, and this call may be recorded.”"
                />
                <div className="rounded-md border border-line bg-s-2 px-3 py-2">
                  <div className="text-2xs font-medium tracking-wide text-text-3 uppercase">First thing it says</div>
                  <p className="mt-1 text-sm text-text-2">{composeInitialMessage(draft) || "—"}</p>
                </div>
              </CardBody>
            </Card>

            <Card>
              <CardHeader icon={<ScrollText />} title="Script" description="The agent only states facts written here, and works toward the goal in its own words." />
              <CardBody className="flex flex-col gap-4">
                <ScriptText
                  label="About your business"
                  required
                  rows={6}
                  maxLength={4000}
                  readOnly={readOnly}
                  value={draft.about}
                  onChange={(v) => set("about", v)}
                  error={fields.about}
                  hint="What you offer, who it is for, and a proof point. Prices, dates and promises not written here are never invented."
                />
                <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
                  <Field label="Goal" error={fields.goal}>
                    <Select<AiAgentGoal>
                      value={draft.goal}
                      disabled={readOnly}
                      onValueChange={(v) => set("goal", v)}
                      options={AI_AGENT_GOALS.map((g) => ({ value: g, label: AI_AGENT_GOAL_LABELS[g] }))}
                    />
                  </Field>
                  <ScriptText
                    label="What a good call ends with"
                    rows={3}
                    maxLength={2000}
                    readOnly={readOnly}
                    value={draft.goalDetails}
                    onChange={(v) => set("goalDetails", v)}
                    error={fields.goalDetails}
                    placeholder="Agree a specific day and time for a 20-minute call with a specialist."
                  />
                </div>
                <QuestionsEditor value={draft.questions} onChange={(v) => set("questions", v)} errors={fields} readOnly={readOnly} />
                <ObjectionsEditor value={draft.objections} onChange={(v) => set("objections", v)} errors={fields} readOnly={readOnly} />
                <ScriptText
                  label="Voicemail message"
                  rows={2}
                  maxLength={500}
                  readOnly={readOnly}
                  value={draft.voicemailMessage}
                  onChange={(v) => set("voicemailMessage", v)}
                  error={fields.voicemailMessage}
                  hint="Left on an answering machine. Empty: it hangs up without a message."
                />
                <ScriptText
                  label="Extra instructions"
                  rows={3}
                  maxLength={4000}
                  readOnly={readOnly}
                  value={draft.extraInstructions}
                  onChange={(v) => set("extraInstructions", v)}
                  error={fields.extraInstructions}
                  hint="Optional. Anything else it should know or avoid."
                />
              </CardBody>
            </Card>

            <Card>
              <CardHeader icon={<PhoneForwarded />} title="Call handling" />
              <CardBody className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="Transfer to"
                  hint="A colleague's number in international format (+14155550100), offered when the person asks for a human. Empty: no transfers."
                  error={fields.transferNumber}
                >
                  <Input value={draft.transferNumber} maxLength={20} inputMode="tel" onChange={(e) => set("transferNumber", e.target.value)} placeholder="+14155550100" />
                </Field>
                <Field label="Longest call (minutes)" hint="It wraps up politely before this. 1 to 20." error={fields.maxCallMinutes}>
                  <Input type="number" min={1} max={20} value={draft.maxCallMinutes} onChange={(e) => set("maxCallMinutes", e.target.value)} />
                </Field>
              </CardBody>
            </Card>
          </fieldset>
        </form>

        <div className="flex min-w-0 flex-col gap-4">
          <Card>
            <CardHeader icon={<RefreshCw />} title="On Cartesia" description="Calls run the version saved on your Cartesia account." />
            <CardBody className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2">
                {archived ? <Badge>Removed while archived</Badge> : <SyncBadge sync={agent.sync} />}
                {agent.sync.syncedAt && <span className="text-xs text-text-3">Saved {f.relative(agent.sync.syncedAt)}</span>}
              </div>
              {!archived && agent.sync.error && (
                <p className="flex items-start gap-1.5 text-xs text-bad-ink">
                  <CircleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
                  <span className="min-w-0 break-words">{agent.sync.error}</span>
                </p>
              )}
              {notReady && <p className="text-xs text-warn-ink">{notReady}</p>}
              {dirty && !readOnly && <p className="text-xs text-text-3">Unsaved changes reach Cartesia when you save.</p>}
              {canEdit && !archived && (
                <Button size="sm" icon={<RefreshCw />} className="w-fit" loading={sync.isPending} onClick={() => sync.mutate()}>
                  Save to Cartesia again
                </Button>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader icon={<PhoneOutgoing />} title="Calls" />
            <CardBody>
              <KeyValueList
                items={[
                  { label: "Calls placed", value: formatNumber(agent.stats.calls) },
                  { label: "Conversations", value: formatNumber(agent.stats.connected) },
                  { label: "Meetings booked", value: formatNumber(agent.stats.meetings) },
                  { label: "Last call", value: agent.stats.lastCallAt ? <span title={f.dateTime(agent.stats.lastCallAt)}>{f.relative(agent.stats.lastCallAt)}</span> : null },
                ]}
              />
            </CardBody>
          </Card>

          <Card>
            <CardHeader icon={<ListOrdered />} title="Used by" />
            <CardBody>
              {usedBy === 0 ? (
                <p className="text-xs text-text-3">Not used yet. Add an AI call step to a campaign or sequence and choose this agent.</p>
              ) : (
                <ul className="flex flex-col gap-2 text-sm">
                  {agent.usage.campaigns.map((c) => (
                    <li key={c.id} className="flex items-center justify-between gap-2">
                      <Link href={ws.href(`/campaigns/${c.id}`)} className="min-w-0 truncate text-text hover:text-accent-hi">
                        {c.name}
                      </Link>
                      <StatusBadge value={c.status} />
                    </li>
                  ))}
                  {agent.usage.sequences.map((s) => (
                    <li key={s.id} className="flex items-center justify-between gap-2">
                      <Link href={ws.href(`/sequences/${s.id}`)} className="min-w-0 truncate text-text hover:text-accent-hi">
                        {s.name}
                      </Link>
                      <Badge quiet>Sequence</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>

          <Card>
            <button
              type="button"
              aria-expanded={showPrompt}
              onClick={() => setShowPrompt((s) => !s)}
              className={cn("flex w-full items-start gap-2.5 px-4 py-3 text-left", showPrompt && "border-b border-line")}
            >
              <CodeXml aria-hidden className="mt-0.5 size-4 shrink-0 text-text-2" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-text-hi">Prompt preview</span>
                <span className="mt-0.5 block text-xs text-text-3">Exactly what the voice model runs on, as last saved.</span>
              </span>
              <ChevronDown aria-hidden className={cn("mt-0.5 size-4 shrink-0 text-text-3 transition-transform", showPrompt && "rotate-180")} />
            </button>
            {showPrompt && (
              <CardBody className="flex flex-col gap-3">
                <div>
                  <div className="text-2xs font-medium tracking-wide text-text-3 uppercase">Opening line</div>
                  <pre className="mt-1 font-mono text-xs break-words whitespace-pre-wrap text-text-2">{agent.preview.initialMessage}</pre>
                </div>
                <div>
                  <div className="text-2xs font-medium tracking-wide text-text-3 uppercase">Instructions</div>
                  <pre className="mt-1 max-h-[480px] overflow-y-auto rounded-sm border border-line bg-well p-2.5 font-mono text-xs break-words whitespace-pre-wrap text-text-2">
                    {agent.preview.instructions}
                  </pre>
                </div>
                <p className="text-xs text-text-3">The {"{{variables}}"} left in are filled for each call, with a fallback when the contact has no value.</p>
              </CardBody>
            )}
          </Card>
        </div>
      </div>

      {canTest && <TestCallModal agent={agent} open={testing} onOpenChange={setTesting} />}
      <ConfirmDialog
        open={confirmArchive}
        onOpenChange={setConfirmArchive}
        title={`Archive “${agent.name}”?`}
        confirmLabel="Archive"
        description={`It stops placing calls and is removed from Cartesia; its call history stays, and you can restore it later.${dirty ? " Your unsaved changes are discarded." : ""}`}
        onConfirm={() => archive.mutateAsync()}
      />
    </>
  );
}

export default function AiAgentPage() {
  const ws = useWorkspace();
  const { agentId } = useParams<{ agentId: string }>();
  const agent = useApiQuery<AiAgentDetail>(ws.key("call-agents", agentId), ws.path(`/call-agents/${agentId}`));

  return (
    <Page width="capped">
      <RequirePermission permission="calls.read">
        <QueryState
          query={agent}
          loading={
            <Card className="p-4">
              <SkeletonText lines={8} />
            </Card>
          }
        >
          {(a) => <Editor key={a.id} agent={a} />}
        </QueryState>
      </RequirePermission>
    </Page>
  );
}
