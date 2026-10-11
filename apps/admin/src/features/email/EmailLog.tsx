"use client";

import Link from "next/link";
import { useState } from "react";
import { Settings2 } from "lucide-react";
import { labelOf, PLATFORM_EMAIL_STATUSES } from "@growthdesk/shared";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { QueryState } from "@/components/ui/ErrorState";
import { NativeSelect } from "@/components/ui/Input";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { Pagination } from "@/components/ui/Pagination";
import { SearchInput } from "@/components/ui/SearchInput";
import { SkeletonText } from "@/components/ui/Skeleton";
import { cn } from "@/lib/cn";
import { useApiQuery } from "@/lib/query";
import { useFormat } from "@/lib/session";
import { FilterBar, platformEmpty, PlatformTile, platformKey, table, TableFooter } from "@/features/common/platform";
import { EmailStatusBadge, PROVIDER_LABEL, templateLabel } from "./common";
import { EmailLogDrawer } from "./EmailLogDrawer";
import type { EmailLogPage } from "./types";

/** /email — every platform email (system mail to our own users), newest first, with delivery status from Resend webhooks. */
export function EmailLog() {
  const f = useFormat();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [template, setTemplate] = useState("");
  const [stream, setStream] = useState("");
  const [provider, setProvider] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [openId, setOpenId] = useState<string | null>(null);
  const log = useApiQuery<EmailLogPage>(platformKey("email-log"), "/admin/email-log", {
    query: { q, status: status || undefined, template: template || undefined, stream: stream || undefined, provider: provider || undefined, page, pageSize },
    keepPrevious: true,
  });
  const filtered = Boolean(q || status || template || stream || provider);
  const set = (fn: (v: string) => void) => (v: string) => {
    fn(v);
    setPage(1);
  };

  return (
    <Page>
      <PageHeader
        icon={<PlatformTile of="email" />}
        title="Delivery log"
        description="Mail the platform itself sends to its users — verification, password resets, invitations, billing notices and notifications. Customers' outreach is not listed here."
        actions={
          <Button href="/email/settings" icon={<Settings2 />}>
            Email settings
          </Button>
        }
      />
      <FilterBar>
        <SearchInput value={q} onChange={set(setQ)} placeholder="Search recipient or subject…" className="sm:w-64" />
        <NativeSelect
          aria-label="Status"
          value={status}
          onChange={(e) => set(setStatus)(e.target.value)}
          placeholder="Any status"
          options={PLATFORM_EMAIL_STATUSES.map((s) => ({ value: s, label: labelOf(s) }))}
          className="w-36"
        />
        <NativeSelect
          aria-label="Template"
          value={template}
          onChange={(e) => set(setTemplate)(e.target.value)}
          placeholder="Any template"
          options={(log.data?.templates ?? []).map((t) => ({ value: t, label: templateLabel(t) }))}
          className="w-52"
        />
        <NativeSelect
          aria-label="Stream"
          value={stream}
          onChange={(e) => set(setStream)(e.target.value)}
          placeholder="Any stream"
          options={[
            { value: "transactional", label: "Transactional" },
            { value: "marketing", label: "Marketing" },
          ]}
          className="w-40"
        />
        <NativeSelect
          aria-label="Provider"
          value={provider}
          onChange={(e) => set(setProvider)(e.target.value)}
          placeholder="Any provider"
          options={[
            { value: "resend", label: "Resend" },
            { value: "smtp", label: "SMTP" },
          ]}
          className="w-36"
        />
        {filtered && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setQ("");
              setStatus("");
              setTemplate("");
              setStream("");
              setProvider("");
              setPage(1);
            }}
          >
            Clear filters
          </Button>
        )}
      </FilterBar>
      <QueryState
        query={log}
        loading={<SkeletonText lines={8} />}
        isEmpty={(d) => d.total === 0}
        empty={
          <Card>
            <EmptyState {...platformEmpty("email")} title={filtered ? "No email matches" : "No email sent yet"} description={filtered ? "Try fewer filters." : undefined} />
          </Card>
        }
      >
        {(data) => (
          <Card className={cn("overflow-hidden", log.isPlaceholderData && "opacity-60")}>
            <div className={table.wrap}>
              <table className={table.table}>
                <thead>
                  <tr>
                    <th className={table.th}>When</th>
                    <th className={table.th}>To</th>
                    <th className={table.th}>Email</th>
                    <th className={table.th}>Status</th>
                    <th className={cn(table.th, "hidden lg:table-cell")}>Provider</th>
                    <th className={cn(table.th, "hidden xl:table-cell")}>Error</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((m) => (
                    <tr
                      key={m.id}
                      tabIndex={0}
                      onClick={() => setOpenId(m.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setOpenId(m.id);
                        }
                      }}
                      className={cn("cursor-pointer hover:bg-hover focus-visible:bg-hover focus-visible:outline-none", openId === m.id && "bg-hover")}
                    >
                      <td className={cn(table.td, "whitespace-nowrap text-text-2")} title={f.dateTime(m.createdAt)}>
                        {f.smart(m.createdAt)}
                      </td>
                      <td className={cn(table.td, "max-w-60 truncate")}>{m.to}</td>
                      <td className={cn(table.td, "max-w-80")}>
                        <div className="truncate font-medium">{m.subject || templateLabel(m.template)}</div>
                        <div className="flex items-center gap-1.5 truncate text-xs text-text-3">
                          {templateLabel(m.template)}
                          {m.stream === "marketing" && (
                            <Badge tone="info" quiet>
                              Marketing
                            </Badge>
                          )}
                        </div>
                      </td>
                      <td className={table.td}>
                        <EmailStatusBadge status={m.status} />
                        {(m.openedAt || m.clickedAt) && (
                          <div className="mt-0.5 text-2xs text-text-3">{[m.openedAt && "Opened", m.clickedAt && "Clicked"].filter(Boolean).join(" · ")}</div>
                        )}
                      </td>
                      <td className={cn(table.td, "hidden whitespace-nowrap text-text-2 lg:table-cell")}>{PROVIDER_LABEL[m.provider] ?? labelOf(m.provider)}</td>
                      <td className={cn(table.td, "hidden max-w-80 truncate text-xs text-bad-ink xl:table-cell")} title={m.error}>
                        {m.error || <span className="text-text-3">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <TableFooter>
              <Pagination
                page={data.page}
                pageSize={data.pageSize}
                total={data.total}
                onPageChange={setPage}
                onPageSizeChange={(s) => {
                  setPageSize(s);
                  setPage(1);
                }}
              />
            </TableFooter>
          </Card>
        )}
      </QueryState>
      <EmailLogDrawer id={openId} onClose={() => setOpenId(null)} />
      <p className="mt-3 text-xs text-text-3">
        Delivered, opened, clicked, bounced and complaint statuses arrive from Resend webhooks — see{" "}
        <Link href="/email/settings" className="underline hover:text-text">
          Email settings
        </Link>
        . Mail sent through SMTP stays at “Sent”.
      </p>
    </Page>
  );
}
