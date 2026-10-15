"use client";

import { Suspense, useState } from "react";
import { ComposeModal } from "@/components/inbox/ComposeModal";
import { ContactContext } from "@/components/inbox/ContactContext";
import { ConversationList, type InboxFilters } from "@/components/inbox/ConversationList";
import { ConversationPane } from "@/components/inbox/ConversationPane";
import { InboxRail } from "@/components/inbox/InboxRail";
import { useInboxStream } from "@/components/inbox/useInboxStream";
import { useSearchState } from "@/components/pipeline/controls";
import { Drawer } from "@/components/ui/Drawer";
import { EmptyState } from "@/components/ui/EmptyState";
import { ENTITY } from "@/components/ui/icons";
import { RequirePermission } from "@/components/ui/RequirePermission";
import { LoadingBlock } from "@/components/ui/Skeleton";
import { cn } from "@/lib/cn";
import { useWorkspace } from "@/lib/session";

/**
 * The unified inbox: filter rail | conversations | thread | contact context.
 * The rail shows from `lg` (a drawer below that). Below the
 * `nav` breakpoint it is one pane at a time (list, or the open conversation
 * with a back button); the context pane shows from `xl`, and in a drawer
 * below that. The open conversation is ?c=<id> (notification links also use
 * ?conversation=<id>, and /inbox/<id> forwards here); filters live in the
 * URL too, so a link or a reload lands on the same view.
 */
export default function InboxPage() {
  return (
    <RequirePermission permission="inbox.read">
      <Suspense fallback={<LoadingBlock className="h-full" />}>
        <Inbox />
      </Suspense>
    </RequirePermission>
  );
}

const STATUSES = ["open", "snoozed", "closed"] as const;
const ASSIGNEES = ["all", "me", "none"] as const;
const CHANNELS = ["email", "whatsapp", "telegram", "web"] as const;
const UUID = /^[0-9a-f-]{36}$/i;

const { icon: InboxGlyph, tint: inboxTint } = ENTITY.inbox;

function Inbox() {
  const ws = useWorkspace();
  const search = useSearchState();
  const [details, setDetails] = useState(false);
  const [composing, setComposing] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  useInboxStream();

  const pick = <T extends string>(value: string, allowed: readonly T[], fallback: T): T => ((allowed as readonly string[]).includes(value) ? (value as T) : fallback);
  const filters: InboxFilters = {
    status: pick(search.get("status"), STATUSES, "open"),
    assignee: pick(search.get("assignee"), ASSIGNEES, "all"),
    channel: (CHANNELS as readonly string[]).includes(search.get("channel")) ? (search.get("channel") as InboxFilters["channel"]) : "",
    unread: search.get("unread") === "1",
    campaign: search.get("campaign") === "any" || UUID.test(search.get("campaign")) ? search.get("campaign") : "",
    tag: search.get("tag") === "none" || UUID.test(search.get("tag")) ? search.get("tag") : "",
    widget: UUID.test(search.get("widget")) ? search.get("widget") : "",
    q: search.get("q"),
    page: Math.max(1, Number(search.get("page")) || 1),
  };
  const selected = search.get("c") || search.get("conversation") || null;

  const setFilters = (patch: Partial<InboxFilters>) => {
    const next = { ...filters, ...patch };
    search.set({
      status: next.status === "open" ? null : next.status,
      assignee: next.assignee === "all" ? null : next.assignee,
      channel: next.channel || null,
      unread: next.unread ? "1" : null,
      campaign: next.campaign || null,
      tag: next.tag || null,
      widget: next.widget || null,
      q: next.q || null,
      page: next.page > 1 ? String(next.page) : null,
    });
  };
  const select = (id: string | null) => search.set({ c: id, conversation: null });
  const activeFilters = [filters.assignee !== "all", filters.channel !== "", filters.unread, filters.campaign !== "", filters.tag !== "", filters.widget !== ""].filter(Boolean).length;

  return (
    <div className="flex h-full min-h-0">
      <aside className="hidden w-[220px] shrink-0 border-r border-line bg-panel lg:block">
        <InboxRail filters={filters} onFilters={setFilters} />
      </aside>

      <div className={cn("w-full shrink-0 flex-col border-r border-line bg-panel nav:flex nav:w-[320px] lg:w-[360px]", selected ? "hidden" : "flex")}>
        <ConversationList
          filters={filters}
          onFilters={setFilters}
          selectedId={selected}
          onSelect={select}
          onCompose={ws.can("inbox.reply") ? () => setComposing(true) : undefined}
          onOpenFilters={() => setRailOpen(true)}
          activeFilters={activeFilters}
        />
      </div>

      <div className={cn("min-w-0 flex-1 flex-col bg-bg", selected ? "flex" : "hidden nav:flex")}>
        {selected ? (
          <ConversationPane key={selected} id={selected} onBack={() => select(null)} onShowDetails={() => setDetails(true)} />
        ) : (
          <EmptyState
            className="h-full"
            icon={<InboxGlyph />}
            tint={inboxTint}
            title="Choose a conversation"
            description="Email and campaign replies, WhatsApp and Telegram messages, and website live chats, in one place. Pick one from the list to read and reply."
          />
        )}
      </div>

      {selected && (
        <aside aria-label="Contact and details" className="hidden w-[300px] shrink-0 overflow-y-auto border-l border-line bg-panel xl:block">
          <ContactContext id={selected} />
        </aside>
      )}

      {selected && (
        <Drawer open={details} onOpenChange={setDetails} title="Contact & details" width="sm" className="xl:hidden">
          <div className="-mx-5 -my-4">
            <ContactContext id={selected} />
          </div>
        </Drawer>
      )}

      <Drawer open={railOpen} onOpenChange={setRailOpen} title="Filters" width="sm" side="left" className="lg:hidden">
        <div className="-mx-5 -my-4">
          <InboxRail
            filters={filters}
            onFilters={(patch) => {
              setFilters(patch);
              setRailOpen(false);
            }}
          />
        </div>
      </Drawer>

      {ws.can("inbox.reply") && <ComposeModal open={composing} onOpenChange={setComposing} onSent={(id) => select(id)} />}
    </div>
  );
}
