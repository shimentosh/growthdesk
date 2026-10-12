"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ArrowUpRight, Filter, ListChecks, ListX, Users } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Checkbox } from "@/components/ui/Checkbox";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { IconTile } from "@/components/ui/IconTile";
import { NativeSelect } from "@/components/ui/Input";
import { SkeletonText, Spinner } from "@/components/ui/Skeleton";
import { useMarketing, useMarketingLists } from "@/components/marketing/common";
import { post, type ApiError } from "@/lib/api";
import { formatNumber } from "@/lib/format";
import { useDebouncedValue } from "@/lib/hooks";
import { useApiQuery } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import type { SavedView } from "@/lib/types/crm";
import type { MarketingList } from "@/lib/types/marketing";
import type { SectionProps } from "./CampaignEditor";
import type { Draft } from "./editor";

/** How many people an audience reaches right now (POST audience/count), as it is edited. */
export function useAudienceCount(audience: Draft["audience"]) {
  const mk = useMarketing();
  const a = useDebouncedValue(audience, 350);
  const body = { listIds: a.listIds, excludeListIds: a.excludeListIds, viewId: a.viewId };
  return useQuery<{ count: number }, ApiError>({
    queryKey: mk.key("audience-count", body),
    queryFn: () => post<{ count: number }>(mk.path("/audience/count"), body),
    enabled: a.listIds.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 10_000,
  });
}

/** Lists to send to, lists to leave out, an optional segment, and the live recipient count. */
export function AudienceSection({ value, set, disabled, errors }: SectionProps) {
  const ws = useWorkspace();
  const mk = useMarketing();
  const lists = useMarketingLists(true);
  const views = useApiQuery<SavedView[]>(ws.key("views", "contact"), ws.path("/views"), { query: { entity: "contact" } });
  const a = value.audience;
  const setAudience = (next: Partial<Draft["audience"]>) => set("audience", { ...a, ...next });
  const toggle = (which: "listIds" | "excludeListIds", id: string, on: boolean) => {
    const other = which === "listIds" ? "excludeListIds" : "listIds";
    setAudience({
      [which]: on ? [...a[which], id] : a[which].filter((x) => x !== id),
      // A list is either sent to or left out, never both.
      ...(on ? { [other]: a[other].filter((x) => x !== id) } : {}),
    });
  };
  // Archived lists only show while they are still chosen.
  const shown = (lists.data ?? []).filter((l) => !l.archivedAt || a.listIds.includes(l.id) || a.excludeListIds.includes(l.id));
  const contactViews = (views.data ?? []).filter((v) => v.entity === "contact");
  const count = useAudienceCount(a);
  const noLists = lists.data && shown.length === 0;

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader
            icon={<ListChecks />}
            title="Send to"
            description="Members of any of these lead lists who have recorded marketing consent. Lead lists also hold people without consent; they are left out. Someone on two lists gets one email."
            actions={
              ws.can("marketing.write") ? (
                <Button size="sm" variant="ghost" iconRight={<ArrowUpRight />} href={mk.href("/lists")}>
                  Manage lead lists
                </Button>
              ) : undefined
            }
          />
          <CardBody>
            {lists.isPending ? (
              <SkeletonText lines={3} />
            ) : lists.isError ? (
              <p className="text-sm text-bad-ink">Lists could not be loaded: {lists.error.message}</p>
            ) : noLists ? (
              <EmptyState compact icon={<ListChecks />} title="No lists yet" description="Create a lead list, or import a CSV into one, then send to the members who agreed to hear from you." />
            ) : (
              <ListPicker lists={shown} chosen={a.listIds} disabled={disabled} onToggle={(id, on) => toggle("listIds", id, on)} />
            )}
            {errors.audience || errors["audience.listIds"] ? <p className="mt-2 text-xs text-bad-ink">{errors.audience ?? errors["audience.listIds"]}</p> : null}
          </CardBody>
        </Card>
        {!noLists && (
          <Card>
            <CardHeader icon={<ListX />} title="Leave out" description="Members of these lists do not get this email, even when they are on a list above." />
            <CardBody>
              {lists.data && (
                <ListPicker
                  lists={shown.filter((l) => !a.listIds.includes(l.id))}
                  chosen={a.excludeListIds}
                  disabled={disabled}
                  onToggle={(id, on) => toggle("excludeListIds", id, on)}
                  empty="Every list is already chosen above."
                />
              )}
            </CardBody>
          </Card>
        )}
        <Card>
          <CardHeader icon={<Filter />} title="Segment" description="Optional: only send to list members who also match a saved contact view." />
          <CardBody>
            <Field error={errors["audience.viewId"]} hint={contactViews.length ? undefined : "Save a filtered view on the Contacts page to use it here."}>
              <NativeSelect
                aria-label="Segment"
                value={a.viewId ?? ""}
                disabled={disabled || views.isPending}
                onChange={(e) => setAudience({ viewId: e.target.value || null })}
                options={[{ value: "", label: "Everyone on the chosen lists" }, ...contactViews.map((v) => ({ value: v.id, label: v.name }))]}
              />
            </Field>
          </CardBody>
        </Card>
      </div>
      <Card className="lg:sticky lg:top-4">
        <CardBody>
          <div className="flex items-center gap-3">
            <IconTile icon={<Users />} tint="indigo" size="md" />
            <div className="min-w-0">
              <p className="text-xs font-medium text-text-3">Recipients right now</p>
              <p className="flex items-center gap-2 text-2xl font-semibold tracking-[-0.025em] text-text-hi tabular-nums">
                {!a.listIds.length ? "0" : count.data ? formatNumber(count.data.count) : count.isError ? "—" : <Spinner size="sm" />}
                {count.isFetching && count.data && <Spinner size="sm" label="Updating" />}
              </p>
            </div>
          </div>
          <p className="mt-3 text-xs text-text-2">
            {!a.listIds.length
              ? "Choose at least one list."
              : count.isError
                ? `Could not count: ${count.error.message}`
                : "Subscribed members with recorded consent who are not suppressed or marked do not contact. The final list is fixed when you send."}
          </p>
        </CardBody>
      </Card>
    </div>
  );
}

function ListPicker({
  lists,
  chosen,
  disabled,
  onToggle,
  empty = "No lists.",
}: {
  lists: MarketingList[];
  chosen: string[];
  disabled: boolean;
  onToggle: (id: string, on: boolean) => void;
  empty?: string;
}) {
  if (!lists.length) return <p className="text-sm text-text-3">{empty}</p>;
  return (
    <ul className="-my-1 divide-y divide-line">
      {lists.map((l) => (
        <li key={l.id} className="flex items-center justify-between gap-3 py-2">
          <Checkbox
            checked={chosen.includes(l.id)}
            disabled={disabled}
            onCheckedChange={(on) => onToggle(l.id, on)}
            label={
              <span className="font-medium">
                {l.name}
                {l.archivedAt && <span className="ml-1.5 text-xs font-normal text-text-3">(archived)</span>}
              </span>
            }
            description={l.description || undefined}
          />
          <span className="shrink-0 text-xs text-text-3 tabular-nums">{formatNumber(l.counts.subscribed)} subscribed</span>
        </li>
      ))}
    </ul>
  );
}
