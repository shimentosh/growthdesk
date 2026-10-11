"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Download, SlidersHorizontal, UserX, X } from "lucide-react";
import { PLATFORM_ROLES, SIGNUP_SOURCES, type PlatformRole } from "@growthdesk/shared";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Button, buttonClass } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { QueryState } from "@/components/ui/ErrorState";
import { Field } from "@/components/ui/Field";
import { Input, NativeSelect } from "@/components/ui/Input";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { Pagination } from "@/components/ui/Pagination";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/Popover";
import { SearchInput } from "@/components/ui/SearchInput";
import { SkeletonText } from "@/components/ui/Skeleton";
import { withQuery } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useApiQuery } from "@/lib/query";
import { useFormat } from "@/lib/session";
import type { Paged } from "@/lib/types";
import type { AdminPlan } from "@/features/common/types";
import { FilterBar, PLATFORM_ROLE_LABELS, PlatformRoleBadge, platformEmpty, PlatformTile, platformKey, table, TableFooter, usePlatform } from "@/features/common/platform";
import { ConsentMark, SIGNUP_SOURCE_LABELS, SignupSourceBadge, TagChips, type UserRow } from "./profile";

const SCOPES = [
  { value: "all", label: "Everyone" },
  { value: "staff", label: "Platform staff" },
  { value: "disabled", label: "Disabled accounts" },
];

/** URL parameter → what it filters. The URL is the only state, so a filtered list can be shared or bookmarked. */
const MORE_FILTERS = ["verified", "source", "consent", "plan", "tag", "from", "to"] as const;

/** A yyyy-mm-dd from a date input, as the start (or end) of that day in the browser's zone. */
function dayBound(day: string, end: boolean): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
  const d = new Date(`${day}T${end ? "23:59:59.999" : "00:00:00"}`);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function useUrlFilters() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const get = (k: string) => params.get(k) ?? "";
  /** Sets (or clears, with "") parameters; any filter change goes back to page 1. */
  const set = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    if (!("page" in patch)) next.delete("page");
    const s = next.toString();
    router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false });
  };
  return { get, set };
}

/** /users — every account on the installation. */
export function UsersList() {
  const f = useFormat();
  const { canChange } = usePlatform();
  const { get, set } = useUrlFilters();
  const page = Math.max(1, Number(get("page")) || 1);
  const pageSize = [25, 50, 100].includes(Number(get("size"))) ? Number(get("size")) : 50;

  // The API's filter parameters (shared by the list and the CSV export).
  const filters = {
    q: get("q") || undefined,
    scope: get("scope") || "all",
    role: get("role") || undefined,
    verified: get("verified") || undefined,
    signupSource: get("source") || undefined,
    consent: get("consent") || undefined,
    plan: get("plan") || undefined,
    tag: get("tag") || undefined,
    lastLoginFrom: dayBound(get("from"), false),
    lastLoginTo: dayBound(get("to"), true),
  };
  const list = useApiQuery<Paged<UserRow>>(platformKey("users"), "/admin/users", { query: { ...filters, page, pageSize }, keepPrevious: true });
  const plans = useApiQuery<AdminPlan[]>(platformKey("plans"), "/admin/plans", { staleTime: 5 * 60_000 });
  const moreActive = MORE_FILTERS.filter((k) => get(k)).length;
  const anyActive = moreActive > 0 || Boolean(get("q") || get("role") || (get("scope") && get("scope") !== "all"));
  const clearAll = () => set(Object.fromEntries(["q", "scope", "role", ...MORE_FILTERS].map((k) => [k, ""])));

  return (
    <Page>
      <PageHeader
        icon={<PlatformTile of="users" />}
        title="Users"
        description="Every account on this installation. Open one to manage it, read its sign-up details or leave a note."
        actions={
          canChange && (
            // A plain download link: the API streams the CSV with the same filters as the table.
            <a href={withQuery("/api/admin/users/export.csv", filters)} download className={buttonClass({ size: "sm" })}>
              <Download aria-hidden />
              Export CSV
            </a>
          )
        }
      />
      <FilterBar>
        <SearchInput value={get("q")} onChange={(v) => set({ q: v })} placeholder="Search name, email or id…" className="sm:w-72" />
        <NativeSelect aria-label="Show" value={get("scope") || "all"} onChange={(e) => set({ scope: e.target.value === "all" ? "" : e.target.value })} options={SCOPES} className="w-44" />
        <NativeSelect
          aria-label="Platform role"
          value={get("role")}
          onChange={(e) => set({ role: e.target.value })}
          placeholder="Any platform role"
          options={PLATFORM_ROLES.map((r) => ({ value: r, label: PLATFORM_ROLE_LABELS[r] }))}
          className="w-44"
        />
        <Popover>
          <PopoverTrigger asChild>
            <Button icon={<SlidersHorizontal />} className={cn(moreActive > 0 && "border-accent text-accent-ink")}>
              Filters{moreActive > 0 && <span className="rounded-xs bg-mute-chip px-1.5 text-2xs tabular-nums">{moreActive}</span>}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-[min(92vw,360px)]">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Email confirmed">
                <NativeSelect
                  value={get("verified")}
                  onChange={(e) => set({ verified: e.target.value })}
                  placeholder="Any"
                  options={[
                    { value: "true", label: "Confirmed" },
                    { value: "false", label: "Not confirmed" },
                  ]}
                />
              </Field>
              <Field label="Product emails">
                <NativeSelect
                  value={get("consent")}
                  onChange={(e) => set({ consent: e.target.value })}
                  placeholder="Any"
                  options={[
                    { value: "true", label: "Opted in" },
                    { value: "false", label: "Not opted in" },
                  ]}
                />
              </Field>
              <Field label="Signed up with" className="col-span-2">
                <NativeSelect
                  value={get("source")}
                  onChange={(e) => set({ source: e.target.value })}
                  placeholder="Any"
                  options={SIGNUP_SOURCES.map((s) => ({ value: s, label: SIGNUP_SOURCE_LABELS[s] }))}
                />
              </Field>
              <Field label="Plan" className="col-span-2" hint="People in any workspace on this plan.">
                <NativeSelect value={get("plan")} onChange={(e) => set({ plan: e.target.value })} placeholder="Any plan" options={(plans.data ?? []).map((p) => ({ value: p.key, label: p.name }))} />
              </Field>
              <Field label="Tag" className="col-span-2">
                <Input
                  defaultValue={get("tag")}
                  key={get("tag")}
                  placeholder="e.g. vip"
                  onBlur={(e) => set({ tag: e.target.value.trim() })}
                  onKeyDown={(e) => e.key === "Enter" && set({ tag: e.currentTarget.value.trim() })}
                />
              </Field>
              <Field label="Last sign-in from">
                <Input type="date" value={get("from")} max={get("to") || undefined} onChange={(e) => set({ from: e.target.value })} />
              </Field>
              <Field label="to">
                <Input type="date" value={get("to")} min={get("from") || undefined} onChange={(e) => set({ to: e.target.value })} />
              </Field>
            </div>
            {moreActive > 0 && (
              <div className="mt-3 flex justify-end border-t border-line pt-3">
                <Button size="sm" variant="ghost" onClick={() => set(Object.fromEntries(MORE_FILTERS.map((k) => [k, ""])))}>
                  Clear these filters
                </Button>
              </div>
            )}
          </PopoverContent>
        </Popover>
        {anyActive && (
          <Button variant="ghost" icon={<X />} onClick={clearAll}>
            Clear
          </Button>
        )}
      </FilterBar>
      <QueryState
        query={list}
        loading={<SkeletonText lines={8} />}
        isEmpty={(d) => d.total === 0}
        empty={
          <Card>
            <EmptyState {...platformEmpty("users")} title="No accounts match" description="Try another search or filter." />
          </Card>
        }
      >
        {(data) => (
          <Card className={cn("overflow-hidden", list.isPlaceholderData && "opacity-60")}>
            <div className={table.wrap}>
              <table className={table.table}>
                <thead>
                  <tr>
                    <th className={table.th}>Person</th>
                    <th className={table.th}>Platform role</th>
                    <th className={table.th}>Status</th>
                    <th className={table.th}>Signed up with</th>
                    <th className={table.th}>Tags</th>
                    <th className={table.th}>Product emails</th>
                    <th className={table.th}>Workspaces</th>
                    <th className={table.th}>Last sign-in</th>
                    <th className={table.th}>Joined</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((u) => {
                    const deleted = Boolean(u.anonymisedAt);
                    return (
                      <tr key={u.id} className={cn("hover:bg-hover", deleted && "text-text-3")}>
                        <td className={cn(table.td, "max-w-72")}>
                          <Link href={`/users/${u.id}`} className="group flex min-w-0 items-center gap-2.5">
                            {deleted ? (
                              <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-mute-chip text-text-3">
                                <UserX aria-hidden className="size-3.5" />
                              </span>
                            ) : (
                              <Avatar name={u.name} email={u.email} size="sm" />
                            )}
                            <span className="min-w-0">
                              <span className={cn("block truncate font-medium group-hover:underline", deleted && "italic")}>{deleted ? "Deleted account" : u.name || u.email}</span>
                              {!deleted && u.name && <span className="block truncate text-xs text-text-3">{u.email}</span>}
                            </span>
                          </Link>
                        </td>
                        <td className={table.td}>
                          <PlatformRoleBadge role={u.platformRole as PlatformRole} />
                        </td>
                        <td className={table.td}>
                          {deleted ? (
                            <Badge tone="mute">Deleted</Badge>
                          ) : u.disabledAt ? (
                            <Badge tone="bad" dot>
                              Disabled
                            </Badge>
                          ) : u.emailVerified ? (
                            <Badge tone="ok" dot>
                              Active
                            </Badge>
                          ) : (
                            <Badge tone="warn" dot>
                              Email not confirmed
                            </Badge>
                          )}
                        </td>
                        <td className={table.td}>
                          <SignupSourceBadge source={u.signupSource} />
                          {u.utmSource && (
                            <div className="mt-0.5 truncate text-xs text-text-3" title="utm_source">
                              via {u.utmSource}
                            </div>
                          )}
                        </td>
                        <td className={cn(table.td, "max-w-48")}>
                          <TagChips tags={u.tags} max={3} />
                        </td>
                        <td className={table.td}>
                          <ConsentMark consent={u.marketingConsent} />
                        </td>
                        <td className={cn(table.td, "tabular-nums")}>{u.workspaceCount}</td>
                        <td className={cn(table.td, "whitespace-nowrap text-text-2")}>{u.lastLoginAt ? f.relative(u.lastLoginAt) : "Never"}</td>
                        <td className={cn(table.td, "whitespace-nowrap text-text-2")}>{f.date(u.createdAt)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <TableFooter>
              <Pagination
                page={data.page}
                pageSize={data.pageSize}
                total={data.total}
                onPageChange={(p) => set({ page: p > 1 ? String(p) : "" })}
                onPageSizeChange={(s) => set({ size: s === 50 ? "" : String(s) })}
              />
            </TableFooter>
          </Card>
        )}
      </QueryState>
    </Page>
  );
}
