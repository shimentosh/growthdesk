"use client";

import { useState } from "react";
import { ArrowRight, CalendarDays, CheckSquare, Handshake, Inbox, Mail, Send, UserMinus, Users, Workflow, Building2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Checkbox } from "@/components/ui/Checkbox";
import { Modal } from "@/components/ui/Dialog";
import { ErrorState } from "@/components/ui/ErrorState";
import { Field, FormError } from "@/components/ui/Field";
import { NativeSelect } from "@/components/ui/Input";
import { SkeletonText } from "@/components/ui/Skeleton";
import { formatNumber } from "@/lib/format";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import type { Member } from "@/lib/types";

/* GET /members/:id/handover — workspaces.service.ts handoverPreview() */
type Handover = {
  member: { membershipId: string; userId: string; name: string; email: string; role: string };
  contacts: { total: number; byStage: Record<string, number> };
  openDeals: number;
  openTasks: number;
  conversations: number;
  companies: number;
  upcomingMeetings: number;
  campaigns: { id: string; name: string; status: string }[];
  mailboxes: { id: string; email: string; status: string }[];
  workflows: { id: string; name: string }[];
};

const STAGE_WORD: Record<string, string> = { lead: "leads", sales: "in sales", contact: "contacts" };

/**
 * Removing a teammate without dropping their work: what they are
 * responsible for, who takes it over (everything moves in one go, logged on
 * each record and announced to the new owner), and whether the mailboxes
 * they connected stop sending.
 */
export function RemoveMemberModal({ member, members, onOpenChange }: { member: Member | null; members: Member[]; onOpenChange: (open: boolean) => void }) {
  const ws = useWorkspace();
  const [to, setTo] = useState("");
  const [unassigned, setUnassigned] = useState(false);
  const [pause, setPause] = useState(true);
  const preview = useApiQuery<Handover>(ws.key("members", member?.id, "handover"), member ? ws.path(`/members/${member.id}/handover`) : null);
  const remove = useApiMutation<unknown, void>({
    method: "DELETE",
    path: () => ws.path(`/members/${member!.id}?${new URLSearchParams({ ...(to && !unassigned ? { handoverTo: to } : {}), pauseMailboxes: String(pause) }).toString()}`),
    invalidate: [ws.key("members"), ws.key("contacts"), ws.key("deals"), ws.key("tasks"), ws.key("activity")],
    success: () => (to && !unassigned ? `${member?.name || member?.email} was removed; their work went to ${members.find((m) => m.userId === to)?.name}` : `${member?.name || member?.email} was removed`),
    errorToast: false,
    onSuccess: () => close(false),
  });

  const close = (open: boolean) => {
    if (!open) {
      setTo("");
      setUnassigned(false);
      setPause(true);
      remove.reset();
    }
    onOpenChange(open);
  };

  const p = preview.data;
  const candidates = members.filter((m) => m.userId !== member?.userId && m.role !== "viewer");
  const ready = unassigned || Boolean(to);
  const rows = p
    ? [
        { icon: <Users />, label: "Contacts they own", value: p.contacts.total, hint: Object.entries(p.contacts.byStage).map(([s, n]) => `${formatNumber(n)} ${STAGE_WORD[s] ?? s}`).join(" · ") },
        { icon: <Handshake />, label: "Open deals", value: p.openDeals },
        { icon: <CheckSquare />, label: "Open tasks", value: p.openTasks },
        { icon: <Inbox />, label: "Conversations assigned", value: p.conversations },
        { icon: <Building2 />, label: "Companies", value: p.companies },
        { icon: <CalendarDays />, label: "Upcoming meetings", value: p.upcomingMeetings },
        { icon: <Send />, label: "Running campaigns", value: p.campaigns.length, hint: p.campaigns.map((c) => c.name).join(", ") },
        { icon: <Workflow />, label: "Workflows that name them", value: p.workflows.length, hint: p.workflows.map((x) => x.name).join(", ") },
      ].filter((r) => r.value > 0)
    : [];

  return (
    <Modal
      open={Boolean(member)}
      onOpenChange={close}
      size="md"
      icon={<UserMinus className="size-5 text-bad-ink" />}
      title={`Remove ${member?.name || member?.email}?`}
      description="They lose access straight away. Their records stay — choose who takes over what they were responsible for."
      dismissOnOutside={false}
      footer={
        <>
          <Button onClick={() => close(false)} disabled={remove.isPending}>
            Cancel
          </Button>
          <Button variant="danger" icon={to && !unassigned ? <ArrowRight /> : <UserMinus />} loading={remove.isPending} disabled={!ready || preview.isPending} onClick={() => remove.mutate()}>
            {to && !unassigned ? "Hand over and remove" : "Remove"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {remove.error && <FormError error={remove.error.message} />}
        {preview.isPending ? (
          <SkeletonText lines={5} />
        ) : preview.isError ? (
          <ErrorState compact error={preview.error} onRetry={() => void preview.refetch()} />
        ) : rows.length === 0 && !p?.mailboxes.length ? (
          <Callout tone="info">They are not responsible for anything open — nothing to hand over.</Callout>
        ) : (
          <ul className="flex flex-col divide-y divide-line rounded-md border border-line">
            {rows.map((r) => (
              <li key={r.label} className="flex items-start gap-2.5 px-3 py-2">
                <span aria-hidden className="mt-0.5 text-text-3 [&_svg]:size-4">
                  {r.icon}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-text">{r.label}</span>
                  {r.hint && <span className="block truncate text-xs text-text-3">{r.hint}</span>}
                </span>
                <span className="text-sm font-semibold text-text-hi tabular-nums">{formatNumber(r.value)}</span>
              </li>
            ))}
          </ul>
        )}

        <Field label="Hand their work to" hint="Contacts, open deals and tasks, conversations, companies, upcoming meetings, campaigns and their place in workflows move to this teammate, who is told.">
          <NativeSelect
            value={to}
            disabled={unassigned}
            placeholder="Choose a teammate"
            onChange={(e) => setTo(e.target.value)}
            options={candidates.map((m) => ({ value: m.userId, label: `${m.name || m.email} · ${m.role}` }))}
          />
        </Field>
        <Checkbox
          checked={unassigned}
          onCheckedChange={setUnassigned}
          label="Leave it unassigned instead"
          description="Everything they owned becomes unowned; workflows that name them will fail until someone edits them."
        />
        {p && p.mailboxes.length > 0 && (
          <Checkbox
            checked={pause}
            onCheckedChange={setPause}
            label={`Pause the ${p.mailboxes.length === 1 ? "mailbox" : `${p.mailboxes.length} mailboxes`} they connected`}
            description={
              <span className="inline-flex items-center gap-1">
                <Mail aria-hidden className="size-3" />
                {p.mailboxes.map((m) => m.email).join(", ")} — stops sending until an admin checks it again.
              </span>
            }
          />
        )}
      </div>
    </Modal>
  );
}
