"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, type ReactNode } from "react";
import { Plus, SearchX, X } from "lucide-react";
import { CHANNELS, labelOf, type Channel } from "@growthdesk/shared";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { ENTITY, EntityTile } from "@/components/ui/icons";
import { NativeSelect } from "@/components/ui/Input";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { Pagination } from "@/components/ui/Pagination";
import { RequirePermission } from "@/components/ui/RequirePermission";
import { SearchInput } from "@/components/ui/SearchInput";
import { LoadingBlock, Skeleton } from "@/components/ui/Skeleton";
import { ChannelTile } from "@/components/templates/channel";
import { cn } from "@/lib/cn";
import { useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import type { Paged } from "@/lib/types";
import type { Template } from "@/lib/types/templates";

export default function TemplatesPage() {
  return (
    <Page>
      <RequirePermission permission="templates.read">
        <Suspense fallback={<LoadingBlock />}>
          <Templates />
        </Suspense>
      </RequirePermission>
    </Page>
  );
}

const PAGE_SIZES = [25, 50, 100, 200];
const TemplateGlyph = ENTITY.templates.icon;
const ARCHIVED = ["false", "true", "all"] as const;
type Archived = (typeof ARCHIVED)[number];

const TH = "h-9 px-3 text-left text-xs font-medium whitespace-nowrap text-text-3";
const TD = "px-3 py-2 align-middle";

/** Search, channel, archived and page live in the URL (?q=&channel=&archived=&page=&pageSize=). */
function useListParams() {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const page = Number(sp.get("page"));
  const pageSize = Number(sp.get("pageSize"));
  const channel = sp.get("channel") ?? "";
  const archived = sp.get("archived") ?? "";
  const state = {
    q: sp.get("q") ?? "",
    channel: ((CHANNELS as readonly string[]).includes(channel) ? channel : "") as Channel | "",
    archived: ((ARCHIVED as readonly string[]).includes(archived) ? archived : "false") as Archived,
    page: Number.isInteger(page) && page > 0 ? page : 1,
    pageSize: PAGE_SIZES.includes(pageSize) ? pageSize : 50,
  };
  const update = (patch: Partial<typeof state>) => {
    const next = { ...state, ...patch };
    if (!("page" in patch)) next.page = 1;
    const p = new URLSearchParams();
    if (next.q.trim()) p.set("q", next.q.trim());
    if (next.channel) p.set("channel", next.channel);
    if (next.archived !== "false") p.set("archived", next.archived);
    if (next.page > 1) p.set("page", String(next.page));
    if (next.pageSize !== 50) p.set("pageSize", String(next.pageSize));
    const qs = p.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };
  return { state, update };
}

/** A line of the message, for the list. */
const excerpt = (t: Template) => (t.channel === "email" && t.subject.trim() ? t.subject : t.body.replace(/\s+/g, " ").trim()).slice(0, 140);

function Templates() {
  const ws = useWorkspace();
  const f = useFormat();
  const { state, update } = useListParams();
  const canWrite = ws.can("templates.write");
  const list = useApiQuery<Paged<Template>>(ws.key("templates", "list"), ws.path("/templates"), {
    query: { q: state.q || undefined, channel: state.channel || undefined, archived: state.archived, page: state.page, pageSize: state.pageSize },
    keepPrevious: true,
  });
  const rows = list.data?.items ?? [];
  const filtered = Boolean(state.q || state.channel || state.archived !== "false");
  const create = canWrite ? (
    <Button variant="primary" icon={<Plus />} href={ws.href("/templates/new")}>
      New template
    </Button>
  ) : undefined;

  let body: ReactNode;
  if (list.isPending) {
    body = (
      <div className="flex flex-col gap-2 p-4" aria-busy>
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-8" />
        ))}
      </div>
    );
  } else if (list.isError && !list.data) {
    body = <ErrorState error={list.error} onRetry={() => void list.refetch()} />;
  } else if (!rows.length) {
    body = filtered ? (
      <EmptyState
        icon={<SearchX />}
        title="No templates match"
        description="Search looks at the name, category and subject."
        action={
          <Button size="sm" icon={<X />} onClick={() => update({ q: "", channel: "", archived: "false" })}>
            Clear filters
          </Button>
        }
      />
    ) : (
      <EmptyState
        icon={<TemplateGlyph />}
        tint={ENTITY.templates.tint}
        title="No templates yet"
        description={
          canWrite
            ? "Write a message once, personalise it with variables like {{first_name}}, and reuse it in sequence steps."
            : "Nobody has written a template yet."
        }
        action={create}
      />
    );
  } else {
    body = (
      <div className={cn("overflow-x-auto transition-opacity", list.isFetching && list.isPlaceholderData && "opacity-60")}>
        <table className="w-full min-w-[720px] border-collapse text-sm">
          <thead className="border-b border-line bg-s-2">
            <tr>
              <th scope="col" className={TH}>
                Name
              </th>
              <th scope="col" className={TH}>
                Channel
              </th>
              <th scope="col" className={TH}>
                Subject / message
              </th>
              <th scope="col" className={cn(TH, "text-right")}>
                Version
              </th>
              <th scope="col" className={TH}>
                Updated
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((t) => (
              <tr key={t.id} className="hover:bg-hover">
                <td className={cn(TD, "max-w-72")}>
                  <Link href={ws.href(`/templates/${t.id}`)} className="group flex min-w-0 items-center gap-2.5">
                    <ChannelTile channel={t.channel} size="md" className={cn(t.archivedAt && "opacity-50")} />
                    <span className="min-w-0">
                      <span className="flex items-center gap-2">
                        <span className="truncate font-medium text-text group-hover:text-accent-hi">{t.name}</span>
                        {t.archivedAt && <Badge>Archived</Badge>}
                      </span>
                      {t.category && <span className="block truncate text-xs text-text-3">{t.category}</span>}
                    </span>
                  </Link>
                </td>
                <td className={cn(TD, "whitespace-nowrap")}>
                  <Badge quiet>{labelOf(t.channel)}</Badge>
                </td>
                <td className={cn(TD, "max-w-[28rem] truncate text-text-2")}>{excerpt(t) || <span className="text-text-3">—</span>}</td>
                <td className={cn(TD, "text-right text-text-3 tabular-nums")}>v{t.version}</td>
                <td className={cn(TD, "whitespace-nowrap text-text-3")} title={f.dateTime(t.updatedAt)}>
                  {f.smart(t.updatedAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <>
      <PageHeader
        icon={<EntityTile of="templates" />}
        title="Templates"
        description="Reusable messages for email, WhatsApp and Telegram steps. Every change to a subject or body is kept as a version."
        actions={create}
      />
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        <SearchInput value={state.q} onChange={(q) => update({ q })} placeholder="Search templates" className="sm:max-w-xs" />
        <div className="grid grid-cols-2 gap-2 sm:flex">
          <NativeSelect
            aria-label="Channel"
            className="sm:w-40"
            value={state.channel}
            onChange={(e) => update({ channel: e.target.value as Channel | "" })}
            options={[{ value: "", label: "All channels" }, ...CHANNELS.map((c) => ({ value: c, label: labelOf(c) }))]}
          />
          <NativeSelect
            aria-label="Archived"
            className="sm:w-36"
            value={state.archived}
            onChange={(e) => update({ archived: e.target.value as Archived })}
            options={[
              { value: "false", label: "Active" },
              { value: "true", label: "Archived" },
              { value: "all", label: "Active & archived" },
            ]}
          />
        </div>
      </div>
      <Card>
        {body}
        {list.data && list.data.total > 0 && (
          <div className="border-t border-line px-3 py-2">
            <Pagination
              page={state.page}
              pageSize={state.pageSize}
              total={list.data.total}
              pageSizes={PAGE_SIZES}
              onPageChange={(page) => update({ page })}
              onPageSizeChange={(pageSize) => update({ pageSize })}
            />
          </div>
        )}
      </Card>
    </>
  );
}
