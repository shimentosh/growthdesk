"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { CheckSquare, ExternalLink, Globe, Handshake, MessagesSquare, UserRound } from "lucide-react";
import { labelOf } from "@growthdesk/shared";
import { Avatar } from "@/components/ui/Avatar";
import { StatusBadge } from "@/components/ui/Badge";
import { Callout } from "@/components/ui/Callout";
import { CHANNEL } from "@/components/ui/icons";
import { KeyValueList } from "@/components/ui/KeyValue";
import { useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import type { ConversationDetail } from "@/lib/types/inbox";
import { ContactListsBlock, ContactRecordFacts } from "./ContactRecord";

function Block({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <section className="border-b border-line px-4 py-3.5 last:border-b-0">
      <h3 className="mb-2.5 flex items-center gap-1.5 text-2xs font-semibold tracking-wide text-text-3 uppercase">
        <span aria-hidden className="flex [&_svg]:size-3.5">
          {icon}
        </span>
        {title}
      </h3>
      {children}
    </section>
  );
}

/**
 * The right pane: who the conversation is with and what is going on with
 * them — the contact (with lifecycle stage, owner and tags from their record),
 * their open deals and tasks, marketing lists, the campaign that started it,
 * and the channel it runs on. Reads the same cached detail as the thread.
 */
export function ContactContext({ id }: { id: string }) {
  const ws = useWorkspace();
  const detail = useApiQuery<ConversationDetail>(ws.key("inbox", "detail", id), ws.path(`/inbox/conversations/${id}`), { refetchInterval: 60_000 });
  if (!detail.data) return null;
  return <Loaded d={detail.data} />;
}

function Loaded({ d }: { d: ConversationDetail }) {
  const ws = useWorkspace();
  const f = useFormat();
  const c = d.contact;
  const now = Date.now();
  const ChannelGlyph = CHANNEL[d.channel]?.icon ?? MessagesSquare;
  return (
    <div className="flex flex-col">
      <Block title="Contact" icon={<UserRound />}>
        {c ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-start gap-2.5">
              <Avatar name={c.fullName} email={c.email} />
              <div className="min-w-0 flex-1">
                {ws.can("contacts.read") ? (
                  <Link
                    href={ws.href(`/contacts/${c.id}`)}
                    className="inline-flex max-w-full items-center gap-1 text-sm font-semibold text-text-hi hover:text-accent-hi hover:underline"
                  >
                    <span className="truncate">{c.fullName || c.email || c.phone || "Unnamed contact"}</span>
                    <ExternalLink aria-hidden className="size-3 shrink-0" />
                  </Link>
                ) : (
                  <span className="block truncate text-sm font-semibold text-text-hi">{c.fullName || c.email || c.phone || "Unnamed contact"}</span>
                )}
                {(c.jobTitle || c.company) && (
                  <p className="truncate text-xs text-text-3">
                    {c.jobTitle}
                    {c.jobTitle && c.company ? " at " : ""}
                    {c.company?.name}
                  </p>
                )}
              </div>
              <StatusBadge value={c.status} />
            </div>
            {(c.doNotContact || c.unsubscribedAt) && <Callout tone="warn">{c.doNotContact ? "Marked do not contact." : `Unsubscribed ${f.date(c.unsubscribedAt)}.`}</Callout>}
            <KeyValueList
              items={[
                { label: "Email", value: c.email },
                { label: "Phone", value: c.phone },
                {
                  label: "Last contacted",
                  value: c.lastContactedAt ? f.relative(c.lastContactedAt) : null,
                },
                {
                  label: "Last replied",
                  value: c.lastRepliedAt ? f.relative(c.lastRepliedAt) : null,
                },
              ]}
            />
            <ContactRecordFacts contactId={c.id} />
          </div>
        ) : (
          <p className="text-xs text-text-3">Not linked to a contact. {d.handle ? `Messages come from ${d.handle}.` : ""}</p>
        )}
      </Block>

      {d.deals.length > 0 && (
        <Block title={`Open deals (${d.deals.length})`} icon={<Handshake />}>
          <ul className="flex flex-col gap-2">
            {d.deals.map((deal) => (
              <li key={deal.id} className="flex items-baseline justify-between gap-2 text-sm">
                {ws.can("deals.read") ? (
                  <Link href={ws.href(`/deals/${deal.id}`)} className="min-w-0 truncate text-text hover:text-accent-hi hover:underline">
                    {deal.name}
                  </Link>
                ) : (
                  <span className="min-w-0 truncate text-text">{deal.name}</span>
                )}
                <span className="shrink-0 text-xs text-text-3">
                  {deal.stage.name} · {f.money(deal.value, deal.currency)}
                </span>
              </li>
            ))}
          </ul>
        </Block>
      )}

      {d.tasks.length > 0 && (
        <Block title={`Open tasks (${d.tasks.length})`} icon={<CheckSquare />}>
          <ul className="flex flex-col gap-2">
            {d.tasks.map((t) => {
              const overdue = t.dueAt ? new Date(t.dueAt).getTime() < now : false;
              const label = (
                <>
                  <span className="min-w-0 truncate">{t.title}</span>
                  <span className={overdue ? "shrink-0 text-xs text-bad-ink" : "shrink-0 text-xs text-text-3"}>{t.dueAt ? f.smart(t.dueAt) : labelOf(t.type)}</span>
                </>
              );
              return (
                <li key={t.id}>
                  {ws.can("tasks.read") ? (
                    <Link href={ws.href(`/tasks?task=${t.id}`)} className="flex items-baseline justify-between gap-2 text-sm text-text hover:text-accent-hi">
                      {label}
                    </Link>
                  ) : (
                    <span className="flex items-baseline justify-between gap-2 text-sm text-text">{label}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </Block>
      )}

      {c && <ContactListsBlock contactId={c.id} />}

      {d.visitor && (
        <Block title="Website visitor" icon={<Globe />}>
          <KeyValueList
            items={[
              { label: "Name", value: d.visitor.name || "Not given" },
              { label: "Email", value: d.visitor.email || "Not given" },
              {
                label: "Page",
                value: d.visitor.pageUrl ? (
                  <a href={d.visitor.pageUrl} target="_blank" rel="noopener noreferrer nofollow" className="break-all text-accent-hi hover:underline">
                    {d.visitor.pageUrl.replace(/^https?:\/\//, "")}
                  </a>
                ) : (
                  "—"
                ),
              },
              { label: "Widget", value: d.visitor.widget.name },
              { label: "Last seen", value: f.relative(d.visitor.lastSeenAt) },
              { label: "First chat", value: f.date(d.visitor.createdAt) },
            ]}
          />
          {!d.visitor.email && <p className="mt-2 text-2xs text-text-3">Ask for their email in the chat to follow up later; it links them to a contact.</p>}
        </Block>
      )}
      <Block title="Conversation" icon={<ChannelGlyph />}>
        <KeyValueList
          items={[
            { label: "Channel", value: labelOf(d.channel) },
            ...(d.mailbox
              ? [
                  {
                    label: "Mailbox",
                    value: d.mailbox.email,
                    hint: d.mailbox.status !== "connected" ? `${labelOf(d.mailbox.status)}${d.mailbox.lastError ? `: ${d.mailbox.lastError}` : ""}` : undefined,
                  },
                ]
              : []),
            ...(d.integration
              ? [
                  {
                    label: "Account",
                    value: d.integration.name,
                    hint: d.integration.status !== "connected" ? `${labelOf(d.integration.status)}${d.integration.lastError ? `: ${d.integration.lastError}` : ""}` : undefined,
                  },
                ]
              : []),
            ...(d.campaign
              ? [
                  {
                    label: "Campaign",
                    value: (
                      <Link href={ws.href(`/campaigns/${d.campaign.id}`)} className="text-text hover:text-accent-hi hover:underline">
                        {d.campaign.name}
                      </Link>
                    ),
                  },
                ]
              : []),
            ...(d.aiCategory ? [{ label: "AI category", value: labelOf(d.aiCategory) }] : []),
            ...(d.aiSentiment ? [{ label: "AI sentiment", value: labelOf(d.aiSentiment) }] : []),
            { label: "Started", value: f.date(d.createdAt) },
            {
              label: "Last inbound",
              value: d.lastInboundAt ? f.relative(d.lastInboundAt) : null,
            },
            {
              label: "Last outbound",
              value: d.lastOutboundAt ? f.relative(d.lastOutboundAt) : null,
            },
          ]}
        />
      </Block>
    </div>
  );
}
