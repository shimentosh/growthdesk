"use client";

import { useState } from "react";
import { Eye, EyeOff, Pencil, Plus, Trash2, Users } from "lucide-react";
import { TEAM_COLORS, type RecordVisibilityT, type TeamInputT } from "@growthdesk/shared";
import { MemberChecklist } from "@/components/automation/fields";
import { useMembers } from "@/components/pickers/Pickers";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Button, IconButton } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { ConfirmDialog, Modal } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { QueryState } from "@/components/ui/ErrorState";
import { Field, FormError } from "@/components/ui/Field";
import { EntityTile } from "@/components/ui/icons";
import { IconTile, type Tint } from "@/components/ui/IconTile";
import { Input, NativeSelect, Textarea } from "@/components/ui/Input";
import { PageHeader } from "@/components/ui/PageHeader";
import { RequirePermission } from "@/components/ui/RequirePermission";
import { SkeletonText } from "@/components/ui/Skeleton";
import { cn } from "@/lib/cn";
import { formatNumber } from "@/lib/format";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import { PEOPLE_TITLE, PeopleTabs } from "./PeopleTabs";

/* GET /teams — apps/api/src/teams/teams.service.ts */
type TeamMemberRow = { userId: string; name: string; email: string; title: string; away: boolean; openLeads: number; openDeals: number; openTasks: number };
type TeamRow = {
  id: string;
  name: string;
  description: string;
  color: string;
  lead: { id: string; name: string } | null;
  members: TeamMemberRow[];
  workload: { openLeads: number; openDeals: number; openTasks: number };
};
type TeamsResponse = { recordVisibility: RecordVisibilityT; teams: TeamRow[] };

const VISIBILITY: { value: RecordVisibilityT; icon: typeof Eye; title: string; text: string }[] = [
  { value: "everyone", icon: Eye, title: "Everyone sees every record", text: "Simple for small teams: members can open any contact, deal, task or conversation." },
  {
    value: "team",
    icon: EyeOff,
    title: "Members see their team's records",
    text: "Members and viewers see their own records, their teams' and unowned ones (for triage). Managers, admins and the owner still see everything.",
  },
];

function VisibilityCard({ value }: { value: RecordVisibilityT }) {
  const ws = useWorkspace();
  const canEdit = ws.can("settings.manage");
  const save = useApiMutation<{ recordVisibility: RecordVisibilityT }, RecordVisibilityT>({
    method: "PUT",
    path: ws.path("/record-visibility"),
    body: (recordVisibility) => ({ recordVisibility }),
    invalidate: [ws.key("teams"), ws.key("contacts"), ws.key("deals"), ws.key("tasks")],
    success: (r) => (r.recordVisibility === "team" ? "Members now see their team's records" : "Everyone sees every record"),
  });
  return (
    <Card className="mb-5">
      <CardHeader icon={<Eye />} title="Who sees what" description={canEdit ? "Applies straight away to every member." : "Set by the workspace owner or an admin."} />
      <CardBody className="grid gap-3 sm:grid-cols-2">
        {VISIBILITY.map((v) => {
          const on = value === v.value;
          return (
            <button
              key={v.value}
              type="button"
              disabled={!canEdit || save.isPending || on}
              onClick={() => save.mutate(v.value)}
              className={cn(
                "flex items-start gap-3 rounded-md border p-3 text-left transition-colors",
                on ? "border-accent bg-tint-pick" : "border-line hover:bg-hover",
                !canEdit && !on && "opacity-60",
              )}
            >
              <v.icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", on ? "text-accent-ink" : "text-text-3")} />
              <span className="min-w-0">
                <span className="flex items-center gap-2 text-sm font-medium text-text-hi">
                  {v.title}
                  {on && <Badge tone="live">Current</Badge>}
                </span>
                <span className="mt-0.5 block text-xs text-text-2">{v.text}</span>
              </span>
            </button>
          );
        })}
      </CardBody>
    </Card>
  );
}

function TeamModal({ team, open, onOpenChange }: { team: TeamRow | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  const ws = useWorkspace();
  const members = useMembers();
  const [draft, setDraft] = useState<TeamInputT>(() => ({
    name: team?.name ?? "",
    description: team?.description ?? "",
    color: (team?.color as TeamInputT["color"]) ?? "blue",
    leadUserId: team?.lead?.id ?? null,
    memberIds: team?.members.map((m) => m.userId) ?? [],
  }));
  const save = useApiMutation<{ id: string }, TeamInputT>({
    method: team ? "PATCH" : "POST",
    path: ws.path(team ? `/teams/${team.id}` : "/teams"),
    invalidate: [ws.key("teams")],
    success: team ? "Team saved" : "Team created",
    errorToast: false,
    onSuccess: () => onOpenChange(false),
  });
  const fields = save.error?.fields ?? {};
  const chosen = (members.data?.members ?? []).filter((m) => draft.memberIds.includes(m.userId));
  return (
    <Modal
      open={open}
      onOpenChange={(o) => !save.isPending && onOpenChange(o)}
      size="md"
      icon={<EntityTile of="members" size="md" />}
      title={team ? `Edit ${team.name}` : "New team"}
      description="Teams decide who sees whose records (in team visibility), can take leads in turn, and group activity and reports."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)} disabled={save.isPending}>
            Cancel
          </Button>
          <Button variant="primary" loading={save.isPending} disabled={!draft.name.trim()} onClick={() => save.mutate({ ...draft, name: draft.name.trim() })}>
            {team ? "Save" : "Create team"}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {save.error && !Object.keys(fields).length && <FormError error={save.error.message} />}
        <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
          <Field label="Name" required error={fields.name}>
            <Input value={draft.name} maxLength={60} autoFocus onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Sales" />
          </Field>
          <Field label="Colour">
            <div className="flex h-9 items-center gap-1.5">
              {TEAM_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={c}
                  onClick={() => setDraft({ ...draft, color: c })}
                  style={{ backgroundColor: `var(--tint-${c})` }}
                  className={cn("size-5 rounded-full ring-offset-2 ring-offset-bg", draft.color === c && "ring-2 ring-accent")}
                />
              ))}
            </div>
          </Field>
        </div>
        <Field label="What it does" error={fields.description}>
          <Textarea rows={2} maxLength={300} value={draft.description ?? ""} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="Closes inbound leads from the website and Clientdesk." />
        </Field>
        <Field label="Members" error={fields.memberIds}>
          <MemberChecklist
            value={draft.memberIds}
            onChange={(ids) => setDraft({ ...draft, memberIds: ids, leadUserId: draft.leadUserId && ids.includes(draft.leadUserId) ? draft.leadUserId : null })}
            emptyHint="Choose who is in the team."
          />
        </Field>
        <Field label="Team lead" hint="Their manager — sees the team's work. One of its members." error={fields.leadUserId}>
          <NativeSelect
            value={draft.leadUserId ?? ""}
            onChange={(e) => setDraft({ ...draft, leadUserId: e.target.value || null })}
            options={[{ value: "", label: "No lead" }, ...chosen.map((m) => ({ value: m.userId, label: m.name || m.email }))]}
          />
        </Field>
      </div>
    </Modal>
  );
}

function TeamCard({ team, onEdit, onDelete }: { team: TeamRow; onEdit: () => void; onDelete: () => void }) {
  const ws = useWorkspace();
  const canEdit = ws.can("members.manage");
  return (
    <Card>
      <div className="flex items-start gap-3 border-b border-line px-4 py-3">
        <IconTile icon={<Users />} tint={team.color as Tint} size="md" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-text-hi">{team.name}</span>
            <span className="text-xs text-text-3">{team.members.length} {team.members.length === 1 ? "person" : "people"}</span>
          </div>
          {team.description && <p className="mt-0.5 text-xs text-text-2">{team.description}</p>}
          {team.lead && <p className="mt-0.5 text-xs text-text-3">Lead: {team.lead.name}</p>}
        </div>
        {canEdit && (
          <div className="flex shrink-0 items-center">
            <IconButton size="sm" label="Edit team" icon={<Pencil />} onClick={onEdit} />
            <IconButton size="sm" variant="danger" label="Delete team" icon={<Trash2 />} onClick={onDelete} />
          </div>
        )}
      </div>
      <div className="grid grid-cols-3 divide-x divide-line border-b border-line text-center">
        {[
          ["Open leads", team.workload.openLeads],
          ["Open deals", team.workload.openDeals],
          ["Open tasks", team.workload.openTasks],
        ].map(([label, n]) => (
          <div key={label as string} className="px-2 py-2">
            <div className="text-base font-semibold text-text-hi tabular-nums">{formatNumber(n as number)}</div>
            <div className="text-2xs text-text-3">{label}</div>
          </div>
        ))}
      </div>
      {team.members.length === 0 ? (
        <p className="px-4 py-3 text-xs text-text-3">No members yet.</p>
      ) : (
        <ul className="divide-y divide-line">
          {team.members.map((m) => (
            <li key={m.userId} className="flex items-center gap-2.5 px-4 py-2 text-sm">
              <Avatar size="sm" name={m.name} email={m.email} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-text">{m.name || m.email}</span>
                  {team.lead?.id === m.userId && <Badge tone="info">Lead</Badge>}
                  {m.away && <Badge tone="warn">Away</Badge>}
                </span>
                {m.title && <span className="block truncate text-xs text-text-3">{m.title}</span>}
              </span>
              <span className="shrink-0 text-xs text-text-2 tabular-nums" title="Open leads · deals · tasks">
                {m.openLeads} · {m.openDeals} · {m.openTasks}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function TeamsSettings() {
  const ws = useWorkspace();
  const list = useApiQuery<TeamsResponse>(ws.key("teams"), ws.path("/teams"));
  const [editing, setEditing] = useState<TeamRow | null | "new">(null);
  const [deleting, setDeleting] = useState<TeamRow | null>(null);
  const remove = useApiMutation<unknown, string>({
    method: "DELETE",
    path: (id) => ws.path(`/teams/${id}`),
    invalidate: [ws.key("teams")],
    success: "Team deleted",
  });
  const canEdit = ws.can("members.manage");
  return (
    <RequirePermission permission="members.read">
      <PageHeader
        icon={<EntityTile of="members" />}
        title={PEOPLE_TITLE}
        description="Group people into teams — Sales, Marketing, SDR. Teams set who sees whose records, take leads in turn, and show where work piles up."
        actions={
          canEdit ? (
            <Button variant="primary" icon={<Plus />} onClick={() => setEditing("new")}>
              New team
            </Button>
          ) : undefined
        }
      />
      <PeopleTabs />
      <QueryState
        query={list}
        loading={
          <Card className="p-4">
            <SkeletonText lines={5} />
          </Card>
        }
      >
        {(d) => (
          <>
            <VisibilityCard value={d.recordVisibility} />
            {d.teams.length === 0 ? (
              <Card>
                <EmptyState
                  icon={<Users />}
                  tint="blue"
                  title="No teams yet"
                  description="Start with the way you already work: a Sales team, a Marketing team. People can be in more than one."
                  action={
                    canEdit ? (
                      <Button size="sm" variant="primary" icon={<Plus />} onClick={() => setEditing("new")}>
                        New team
                      </Button>
                    ) : undefined
                  }
                />
              </Card>
            ) : (
              <div className="grid gap-4 lg:grid-cols-2">
                {d.teams.map((t) => (
                  <TeamCard key={t.id} team={t} onEdit={() => setEditing(t)} onDelete={() => setDeleting(t)} />
                ))}
              </div>
            )}
          </>
        )}
      </QueryState>
      {editing && <TeamModal key={editing === "new" ? "new" : editing.id} team={editing === "new" ? null : editing} open onOpenChange={(o) => !o && setEditing(null)} />}
      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete ${deleting?.name}?`}
        description="Its people stay in the workspace with their records. Routing rules that send leads to this team stop finding anyone until you change them."
        confirmLabel="Delete team"
        onConfirm={() => deleting && remove.mutateAsync(deleting.id)}
      />
    </RequirePermission>
  );
}
