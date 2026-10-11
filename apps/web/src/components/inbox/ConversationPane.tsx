"use client";

import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  AlarmClock,
  AlarmClockOff,
  CheckCheck,
  CheckSquare,
  ChevronLeft,
  Ellipsis,
  Handshake,
  Link2,
  Lock,
  Mail,
  MessagesSquare,
  PanelRight,
  Reply,
  RotateCcw,
  Send,
  StickyNote,
  Trash2,
  User,
  UserMinus,
  UserPlus,
} from "lucide-react";
import { labelOf } from "@growthdesk/shared";
import { AiReplyDraftButton } from "@/components/ai/AiReplyDraft";
import { MemberPicker } from "@/components/pickers/Pickers";
import { useContactDealActions } from "@/components/pipeline/ContactDealActions";
import { formLevelError } from "@/components/pipeline/utils";
import { Badge, StatusBadge } from "@/components/ui/Badge";
import { Button, IconButton } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { ConfirmDialog, Modal } from "@/components/ui/Dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/DropdownMenu";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { ChannelTile } from "@/components/ui/icons";
import { Field, FormError } from "@/components/ui/Field";
import { Input, NativeSelect, Textarea } from "@/components/ui/Input";
import { LoadingBlock } from "@/components/ui/Skeleton";
import { cn } from "@/lib/cn";
import { utcToZonedInput, zonedInputToUtc } from "@/lib/format";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useFormat, useMe, useWorkspace } from "@/lib/session";
import type { Mailbox } from "@/lib/types/integrations";
import type { ConversationDetail, ConversationNote, ConversationRow, InboxMessage } from "@/lib/types/inbox";
import { TaskFromConversationModal } from "./TaskFromConversationModal";
import { conversationTitle, isSnoozed, snoozePresets, threadItems } from "./utils";

type PatchVars = {
  status?: "open" | "closed";
  assigneeId?: string | null;
  snoozedUntil?: string | null;
  unread?: boolean;
};

/** The middle pane: header with triage actions, the thread (messages and internal notes), the composer. Polled every 15 seconds. */
export function ConversationPane({ id, onBack, onShowDetails }: { id: string; onBack: () => void; onShowDetails: () => void }) {
  const ws = useWorkspace();
  const detail = useApiQuery<ConversationDetail>(ws.key("inbox", "detail", id), ws.path(`/inbox/conversations/${id}`), { refetchInterval: 15_000 });
  const canWork = ws.can(["inbox.reply", "inbox.assign"]);

  // Opening an unread conversation marks it read (for a role that may change it).
  const markRead = useApiMutation<unknown, void>({
    path: ws.path(`/inbox/conversations/${id}/read`),
    invalidate: [ws.key("inbox"), ws.key("tasks", "summary")],
    errorToast: false,
  });
  const marked = useRef<string | null>(null);
  const unread = detail.data?.unread;
  useEffect(() => {
    if (unread && canWork && marked.current !== id) {
      marked.current = id;
      markRead.mutate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per opened conversation
  }, [id, unread, canWork]);

  if (detail.isPending) return <LoadingBlock className="h-full" />;
  if (detail.isError && !detail.data) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-2 border-b border-line px-3 py-2 nav:hidden">
          <IconButton label="Back to conversations" icon={<ChevronLeft />} onClick={onBack} />
        </div>
        <ErrorState
          error={detail.error}
          title={detail.error.isNotFound ? "Conversation not found" : undefined}
          onRetry={detail.error.isNotFound ? undefined : () => void detail.refetch()}
        />
      </div>
    );
  }
  return <Loaded d={detail.data} onBack={onBack} onShowDetails={onShowDetails} />;
}

function Loaded({ d, onBack, onShowDetails }: { d: ConversationDetail; onBack: () => void; onShowDetails: () => void }) {
  const ws = useWorkspace();
  const me = useMe();
  const f = useFormat();
  const self = me.data?.user.id ?? null;
  const canWork = ws.can(["inbox.reply", "inbox.assign"]);
  const canAssign = ws.can("inbox.assign");
  const [taskOpen, setTaskOpen] = useState(false);
  const [customSnooze, setCustomSnooze] = useState(false);
  const deals = useContactDealActions(
    d.contact ? { id: d.contact.id, label: d.contact.fullName || d.contact.email || d.contact.phone || "this contact", company: d.contact.company } : null,
  );

  const patch = useApiMutation<ConversationRow, PatchVars & { toast?: string }>({
    method: "PATCH",
    path: ws.path(`/inbox/conversations/${d.id}`),
    body: ({ toast: _toast, ...vars }) => vars,
    invalidate: [ws.key("inbox"), ws.key("tasks", "summary")],
    success: (_row, vars) => vars.toast ?? "Conversation updated",
  });

  const snoozed = isSnoozed(d);
  const title = conversationTitle(d);
  const sub = [labelOf(d.channel), d.handle && d.handle !== title ? d.handle : null, d.mailbox?.email ?? d.integration?.name ?? null].filter(Boolean).join(" · ");
  const presets = snoozePresets(ws.timezone);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-2.5">
        <IconButton label="Back to conversations" icon={<ChevronLeft />} onClick={onBack} className="nav:hidden" />
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <ChannelTile channel={d.channel} size="md" />
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold text-text-hi">{title}</h2>
            <p className="truncate text-xs text-text-3">{sub}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {d.status === "closed" ? <Badge tone="mute">Closed</Badge> : snoozed && d.snoozedUntil ? <Badge tone="warn">Snoozed until {f.smart(d.snoozedUntil)}</Badge> : null}
          {canAssign ? (
            <MemberPicker
              size="sm"
              className="w-40"
              aria-label="Assignee"
              value={d.assignee?.id ?? null}
              valueLabel={d.assignee?.name || d.assignee?.email}
              placeholder="Unassigned"
              disabled={patch.isPending}
              onChange={(assigneeId) =>
                patch.mutate({
                  assigneeId,
                  toast: assigneeId ? "Conversation assigned" : "Conversation unassigned",
                })
              }
            />
          ) : canWork && !d.assignee ? (
            <Button size="sm" icon={<UserPlus />} loading={patch.isPending} onClick={() => patch.mutate({ assigneeId: self, toast: "Assigned to you" })}>
              Assign to me
            </Button>
          ) : canWork && d.assignee?.id === self ? (
            <Button
              size="sm"
              variant="ghost"
              icon={<UserMinus />}
              loading={patch.isPending}
              onClick={() =>
                patch.mutate({
                  assigneeId: null,
                  toast: "Conversation unassigned",
                })
              }
            >
              Unassign me
            </Button>
          ) : (
            <span className="inline-flex items-center gap-1 text-xs text-text-3">
              <User aria-hidden className="size-3.5" />
              {d.assignee ? d.assignee.name || d.assignee.email : "Unassigned"}
            </span>
          )}
          {canWork &&
            (d.status === "open" ? (
              <Button
                size="sm"
                icon={<CheckCheck />}
                disabled={patch.isPending}
                onClick={() =>
                  patch.mutate({
                    status: "closed",
                    toast: "Conversation closed",
                  })
                }
              >
                Close
              </Button>
            ) : (
              <Button
                size="sm"
                icon={<RotateCcw />}
                disabled={patch.isPending}
                onClick={() =>
                  patch.mutate({
                    status: "open",
                    toast: "Conversation reopened",
                  })
                }
              >
                Reopen
              </Button>
            ))}
          {canWork && d.status === "open" && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton size="sm" variant="secondary" label="Snooze" icon={<AlarmClock />} disabled={patch.isPending} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>Snooze until</DropdownMenuLabel>
                {presets.map((p) => (
                  <DropdownMenuItem
                    key={p.label}
                    onSelect={() =>
                      patch.mutate({
                        snoozedUntil: p.until,
                        toast: `Snoozed until ${f.dateTime(p.until)}`,
                      })
                    }
                  >
                    {p.label}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuItem onSelect={() => setCustomSnooze(true)}>Pick a date and time…</DropdownMenuItem>
                {snoozed && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      icon={<AlarmClockOff />}
                      onSelect={() =>
                        patch.mutate({
                          snoozedUntil: null,
                          toast: "Snooze removed",
                        })
                      }
                    >
                      Unsnooze
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {(canWork || ws.can("tasks.write") || deals.canWrite) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton size="sm" label="More actions" icon={<Ellipsis />} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {canWork && !d.unread && (
                  <DropdownMenuItem icon={<Mail />} onSelect={() => patch.mutate({ unread: true, toast: "Marked unread" })}>
                    Mark unread
                  </DropdownMenuItem>
                )}
                {ws.can("tasks.write") && (
                  <DropdownMenuItem icon={<CheckSquare />} onSelect={() => setTaskOpen(true)}>
                    Create follow-up task
                  </DropdownMenuItem>
                )}
                {deals.canWrite && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem icon={<Handshake />} disabled={deals.pipelinesLoading || deals.noPipeline} onSelect={deals.openNew}>
                      {deals.noPipeline ? "New deal (set up a pipeline first)" : "New deal"}
                    </DropdownMenuItem>
                    <DropdownMenuItem icon={<Link2 />} onSelect={deals.openLink}>
                      Link to existing deal
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <IconButton size="sm" label="Contact and details" icon={<PanelRight />} onClick={onShowDetails} className="xl:hidden" />
        </div>
      </header>

      <Thread d={d} />
      <Composer d={d} />

      <TaskFromConversationModal open={taskOpen} onOpenChange={setTaskOpen} conversation={d} />
      {deals.dialogs}
      <CustomSnoozeModal
        open={customSnooze}
        onOpenChange={setCustomSnooze}
        onSnooze={(until) =>
          patch.mutateAsync({
            snoozedUntil: until,
            toast: `Snoozed until ${f.dateTime(until)}`,
          })
        }
      />
    </div>
  );
}

function CustomSnoozeModal({ open, onOpenChange, onSnooze }: { open: boolean; onOpenChange: (o: boolean) => void; onSnooze: (until: string) => Promise<unknown> }) {
  const ws = useWorkspace();
  const [value, setValue] = useState(() => utcToZonedInput(new Date(Date.now() + 86_400_000), ws.timezone));
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const until = value ? zonedInputToUtc(value, ws.timezone) : null;
    if (!until || new Date(until).getTime() <= Date.now()) {
      setError("Choose a time in the future.");
      return;
    }
    try {
      await onSnooze(until);
      onOpenChange(false);
    } catch {
      // The mutation already toasted the API's message.
    }
  };
  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        setError(null);
        onOpenChange(o);
      }}
      size="sm"
      title="Snooze until"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="snooze-form">
            Snooze
          </Button>
        </>
      }
    >
      <form id="snooze-form" onSubmit={submit}>
        <Field label="Date and time" hint={`Workspace time (${ws.timezone}). It comes back sooner if they write again.`} error={error}>
          <Input type="datetime-local" value={value} onChange={(e) => setValue(e.target.value)} />
        </Field>
      </form>
    </Modal>
  );
}

// ─── Thread ──────────────────────────────────────────────────────────────────

function Thread({ d }: { d: ConversationDetail }) {
  const items = threadItems(d);
  const box = useRef<HTMLDivElement>(null);
  const last = items.at(-1);
  const lastKey = last ? (last.kind === "message" ? last.message.id : last.note.id) : "";
  // Land on the newest message when a conversation opens or something new arrives.
  useLayoutEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [d.id, lastKey]);

  return (
    <div ref={box} className="min-h-0 flex-1 overflow-y-auto bg-well px-3 py-4 nav:px-5">
      {d.messages.length === 500 && <p className="mb-3 text-center text-xs text-text-3">Showing the newest 500 messages.</p>}
      {!items.length && <EmptyState compact icon={<MessagesSquare />} title="No messages yet" description="Messages and internal notes on this conversation show up here." />}
      <ol className="flex flex-col gap-3">
        {items.map((item, i) => {
          const prev = items[i - 1];
          if (item.kind === "note") return <NoteItem key={`n${item.note.id}`} note={item.note} conversationId={d.id} />;
          const prevSubject = prev?.kind === "message" ? prev.message.subject : i === 0 ? null : undefined;
          return <MessageItem key={item.message.id} m={item.message} showSubject={d.channel === "email" && item.message.subject !== prevSubject} />;
        })}
      </ol>
    </div>
  );
}

function MessageItem({ m, showSubject }: { m: InboxMessage; showSubject: boolean }) {
  const f = useFormat();
  const out = m.direction === "outbound";
  const at = m.receivedAt ?? m.sentAt ?? m.createdAt;
  const who = out ? m.author?.name || (m.campaignId ? "Campaign step" : m.fromAddress || "Sent") : m.fromAddress || "Them";
  const problem = (m.status === "failed" || m.status === "bounced" || m.status === "uncertain") && m.error;
  return (
    <li className={cn("flex", out ? "justify-end" : "justify-start")}>
      <article className={cn("max-w-[min(680px,92%)] min-w-0 rounded-lg border px-3.5 py-2.5 shadow-sm", out ? "border-info-edge bg-info-wash" : "border-line bg-panel")}>
        <header className="mb-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-2xs text-text-3">
          <span className="font-medium text-text-2">{who}</span>
          {m.channel === "email" && m.toAddress && <span className="truncate">to {m.toAddress}</span>}
          <time dateTime={at} title={f.dateTime(at)}>
            {f.smart(at)}
          </time>
        </header>
        {showSubject && m.subject && <div className="mb-1 text-sm font-semibold text-text-hi">{m.subject}</div>}
        {m.bodyHtml ? (
          // bodyHtml is sanitised by the API (InboxService messageDto: sanitize-html allow-list, no scripts,
          // styles or event handlers; links get target=_blank rel=noopener). Plain text is used otherwise.
          <div
            className="text-sm leading-relaxed break-words text-text [&_a]:text-accent-hi [&_a]:underline [&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-line-strong [&_blockquote]:pl-3 [&_blockquote]:text-text-3 [&_li]:ml-5 [&_ol]:list-decimal [&_p]:my-1.5 [&_pre]:whitespace-pre-wrap [&_table]:max-w-full [&_ul]:list-disc"
            dangerouslySetInnerHTML={{ __html: m.bodyHtml }}
          />
        ) : (
          <p className="text-sm leading-relaxed break-words whitespace-pre-wrap text-text">{m.bodyText || <span className="text-text-3">(no text)</span>}</p>
        )}
        <footer className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {out && <StatusBadge value={m.status} />}
          {!out && m.isAutoReply && <Badge tone="mute">Auto-reply</Badge>}
          {out && m.openedAt && (
            <Badge tone="info" title={`First opened ${f.dateTime(m.openedAt)}`}>
              Opened{m.openCount > 1 ? ` ×${m.openCount}` : ""}
            </Badge>
          )}
          {out && m.clickedAt && (
            <Badge tone="info" title={`First click ${f.dateTime(m.clickedAt)}`}>
              Clicked{m.clickCount > 1 ? ` ×${m.clickCount}` : ""}
            </Badge>
          )}
          {problem && <span className="text-2xs text-bad-ink">{m.error}</span>}
        </footer>
      </article>
    </li>
  );
}

function NoteItem({ note, conversationId }: { note: ConversationNote; conversationId: string }) {
  const ws = useWorkspace();
  const me = useMe();
  const f = useFormat();
  const [confirm, setConfirm] = useState(false);
  const remove = useApiMutation<unknown, void>({
    method: "DELETE",
    path: ws.path(`/inbox/conversations/${conversationId}/notes/${note.id}`),
    invalidate: [ws.key("inbox", "detail", conversationId)],
    success: "Note deleted",
    errorToast: false,
  });
  const canDelete = ws.can("inbox.assign") || (ws.can("inbox.reply") && note.author?.id === me.data?.user.id);
  return (
    <li className="flex justify-center">
      <article className="w-full max-w-[680px] rounded-lg border border-warn-edge bg-warn-wash px-3.5 py-2.5">
        <header className="mb-1 flex items-center gap-2 text-2xs text-warn-ink">
          <StickyNote aria-hidden className="size-3.5" />
          <span className="font-medium">
            Internal note
            {note.author ? ` · ${note.author.name || "Teammate"}` : ""}
          </span>
          <time dateTime={note.createdAt} title={f.dateTime(note.createdAt)} className="text-text-3">
            {f.smart(note.createdAt)}
          </time>
          {canDelete && <IconButton size="sm" label="Delete note" icon={<Trash2 />} className="ml-auto -my-1" onClick={() => setConfirm(true)} />}
        </header>
        <p className="text-sm break-words whitespace-pre-wrap text-text">{note.body}</p>
      </article>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Delete this note?"
        description="Only your team sees notes; the contact never did. This cannot be undone."
        onConfirm={() => remove.mutateAsync()}
      />
    </li>
  );
}

// ─── Composer ────────────────────────────────────────────────────────────────

const baseSubject = (s: string) => s.replace(/^(\s*(re|fwd?|aw|sv)\s*(\[\d+\])?\s*:\s*)+/i, "").trim();

function Composer({ d }: { d: ConversationDetail }) {
  const ws = useWorkspace();
  const canReply = ws.can("inbox.reply") && d.channel !== "call";
  const canNote = ws.can(["inbox.reply", "inbox.assign"]);
  const [mode, setMode] = useState<"reply" | "note">(canReply ? "reply" : "note");
  if (!canReply && !canNote) {
    return (
      <div className="flex shrink-0 items-center gap-2 border-t border-line px-4 py-3 text-xs text-text-3">
        <Lock aria-hidden className="size-3.5" />
        Your role can read this conversation but not reply to it.
      </div>
    );
  }
  return (
    <div className="shrink-0 border-t border-line bg-panel">
      <div role="tablist" aria-label="Composer" className="flex items-center gap-4 border-b border-line px-4">
        {canReply && (
          <TabButton active={mode === "reply"} icon={<Reply />} onClick={() => setMode("reply")}>
            Reply
          </TabButton>
        )}
        {canNote && (
          <TabButton active={mode === "note"} icon={<StickyNote />} onClick={() => setMode("note")}>
            Internal note
          </TabButton>
        )}
        {d.channel === "call" && <span className="ml-auto text-2xs text-text-3">Call conversations cannot be replied to.</span>}
      </div>
      {mode === "reply" && canReply ? <ReplyForm key={d.id} d={d} /> : <NoteForm key={d.id} conversationId={d.id} />}
    </div>
  );
}

function TabButton({ active, icon, onClick, children }: { active: boolean; icon?: ReactNode; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "relative -mb-px inline-flex h-9 items-center gap-1.5 border-b-2 px-0.5 text-xs font-medium transition-colors [&_svg]:size-3.5",
        active ? "border-solid-line text-text-hi" : "border-transparent text-text-3 hover:text-text",
      )}
    >
      {icon && (
        <span aria-hidden className="contents">
          {icon}
        </span>
      )}
      {children}
    </button>
  );
}

function ReplyForm({ d }: { d: ConversationDetail }) {
  const ws = useWorkspace();
  const f = useFormat();
  const isEmail = d.channel === "email";
  const mailboxes = useApiQuery<Mailbox[]>(ws.key("mailboxes", "list"), isEmail && ws.can("integrations.read") ? ws.path("/mailboxes") : null);
  const [mailboxId, setMailboxId] = useState<string>(d.mailboxId ?? "");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");

  const send = useApiMutation<InboxMessage, { body: string; subject?: string; mailboxId?: string }>({
    path: ws.path(`/inbox/conversations/${d.id}/reply`),
    invalidate: [ws.key("inbox"), ws.key("tasks", "summary"), ws.key("contacts")],
    success: "Sent",
    errorToast: false,
    onSuccess: () => {
      setBody("");
      setSubject("");
    },
  });
  const fields = send.error?.fields ?? {};
  const formError = formLevelError(send.error, ["body", "subject", "mailboxId"]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!body.trim() || send.isPending) return;
    send.mutate({
      body: body.trim(),
      ...(isEmail && subject.trim() ? { subject: subject.trim() } : {}),
      ...(isEmail && mailboxId ? { mailboxId } : {}),
    });
  };

  const boxes = mailboxes.data ?? [];
  const optedOut = d.contact && (d.contact.doNotContact || d.contact.unsubscribedAt);
  const reach = d.reachability;
  const windowClosed = d.channel === "whatsapp" && reach?.reachable && reach.freeFormAllowed === false;

  return (
    <form onSubmit={submit} className="flex flex-col gap-2.5 px-4 py-3">
      {optedOut && (
        <Callout tone="warn">
          {d.contact?.doNotContact
            ? "This contact is marked do not contact."
            : `This contact unsubscribed${d.contact?.unsubscribedAt ? ` ${f.date(d.contact.unsubscribedAt)}` : ""}.`}{" "}
          Sends to them are refused.
        </Callout>
      )}
      {reach && !reach.reachable && <Callout tone="warn">{reach.reason}</Callout>}
      {windowClosed && <Callout tone="warn">{reach?.reason}</Callout>}
      {d.channel === "whatsapp" && reach?.freeFormAllowed && reach.freeFormUntil && (
        <p className="text-2xs text-text-3">Free-form replies are allowed until {f.dateTime(reach.freeFormUntil)} (WhatsApp&apos;s 24-hour window).</p>
      )}
      <FormError error={formError} />
      {isEmail && (
        <div className="grid gap-2 sm:grid-cols-2">
          {ws.can("integrations.read") ? (
            <Field label="From" error={fields.mailboxId}>
              <NativeSelect
                size="sm"
                value={mailboxId}
                onChange={(e) => setMailboxId(e.target.value)}
                placeholder={d.mailboxId ? undefined : "Choose a mailbox"}
                options={boxes.map((b) => ({
                  value: b.id,
                  label: `${b.displayName ? `${b.displayName} <${b.email}>` : b.email}${b.status !== "connected" ? ` (${labelOf(b.status)})` : ""}`,
                }))}
              />
            </Field>
          ) : (
            <Field label="From">
              <Input size="sm" readOnly value={d.mailbox?.email ?? "The conversation's mailbox"} />
            </Field>
          )}
          <Field label="Subject" error={fields.subject}>
            <Input size="sm" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={300} placeholder={`Re: ${baseSubject(d.subject) || "(no subject)"}`} />
          </Field>
        </div>
      )}
      <AiReplyDraftButton conversationId={d.id} hasText={Boolean(body.trim())} onUse={setBody} />
      <Field error={fields.body}>
        <Textarea
          rows={3}
          aria-label="Reply"
          placeholder={isEmail ? "Write your reply…" : `Message on ${labelOf(d.channel)}…`}
          value={body}
          maxLength={50000}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(e);
          }}
        />
      </Field>
      <div className="flex items-center justify-between gap-2">
        <span className="text-2xs text-text-3">
          {isEmail ? "Sent from the mailbox above, threaded on their last message." : "Sent through the connected channel."} ⌘/Ctrl + Enter sends.
        </span>
        <Button type="submit" size="sm" variant="primary" icon={<Send />} loading={send.isPending} disabled={!body.trim()}>
          Send
        </Button>
      </div>
    </form>
  );
}

function NoteForm({ conversationId }: { conversationId: string }) {
  const ws = useWorkspace();
  const [body, setBody] = useState("");
  const add = useApiMutation<ConversationNote, { body: string }>({
    path: ws.path(`/inbox/conversations/${conversationId}/notes`),
    invalidate: [ws.key("inbox", "detail", conversationId)],
    success: "Note added",
    errorToast: false,
    onSuccess: () => setBody(""),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (body.trim() && !add.isPending) add.mutate({ body: body.trim() });
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-2.5 px-4 py-3">
      <Field error={add.error ? (add.error.fields.body ?? add.error.message) : undefined}>
        <Textarea
          rows={3}
          aria-label="Internal note"
          placeholder="Only your team sees notes…"
          value={body}
          maxLength={10000}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(e);
          }}
        />
      </Field>
      <div className="flex justify-end">
        <Button type="submit" size="sm" variant="primary" icon={<StickyNote />} loading={add.isPending} disabled={!body.trim()}>
          Add note
        </Button>
      </div>
    </form>
  );
}
