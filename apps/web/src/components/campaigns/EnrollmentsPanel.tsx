"use client";

import Link from "next/link";
import { useState } from "react";
import { UserPlus, Users, X } from "lucide-react";
import { ENROLLMENT_STATUSES, labelOf, type EnrollmentStatus } from "@growthdesk/shared";
import { StatusBadge } from "@/components/ui/Badge";
import { Button, IconButton } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog, Modal } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { Field, FormError } from "@/components/ui/Field";
import { NativeSelect } from "@/components/ui/Input";
import { Pagination } from "@/components/ui/Pagination";
import { SearchInput } from "@/components/ui/SearchInput";
import { Skeleton } from "@/components/ui/Skeleton";
import { ContactPicker, contactLabel } from "@/components/pickers/Pickers";
import { StepTile } from "@/components/sequences/StepsEditor";
import { cn } from "@/lib/cn";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import type { Paged } from "@/lib/types";
import type { CampaignDetail, Enrollment, EnrollResult } from "@/lib/types/campaigns";
import { SkippedList, plural, skippedTotal } from "./common";

const TH = "h-9 px-3 text-left text-xs font-medium whitespace-nowrap text-text-3";
const TD = "px-3 py-2 align-middle";
const PAGE_SIZES = [25, 50, 100];
const ENROLLABLE = ["scheduled", "running", "paused"];

/** The campaign's enrollments (GET /enrollments): filter, search, page, stop one, and enroll more contacts. */
export function EnrollmentsPanel({ campaign, initialStatus }: { campaign: CampaignDetail; initialStatus?: string }) {
  const ws = useWorkspace();
  const f = useFormat();
  const [status, setStatus] = useState<EnrollmentStatus | "">(
    (ENROLLMENT_STATUSES as readonly string[]).includes(initialStatus ?? "") ? (initialStatus as EnrollmentStatus) : "",
  );
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [stopping, setStopping] = useState<Enrollment | null>(null);
  const [adding, setAdding] = useState(false);
  const canLaunch = ws.can("campaigns.launch");
  const base = `/campaigns/${campaign.id}`;
  const list = useApiQuery<Paged<Enrollment>>(ws.key("campaigns", campaign.id, "enrollments"), ws.path(`${base}/enrollments`), {
    query: { status: status || undefined, q: q || undefined, page, pageSize },
    keepPrevious: true,
  });
  const stop = useApiMutation<Enrollment, string>({
    path: (id) => ws.path(`${base}/enrollments/${id}/stop`),
    body: () => undefined,
    invalidate: [ws.key("campaigns")],
    success: "Enrollment stopped",
    errorToast: false,
  });
  const rows = list.data?.items ?? [];
  const stepLabel = (e: Enrollment) => (e.step ? `${e.step.position + 1}. ${labelOf(e.step.type)}` : "Past the last step");

  let body;
  if (list.isPending) {
    body = (
      <div className="flex flex-col gap-2 p-4" aria-busy>
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-9" />
        ))}
      </div>
    );
  } else if (list.isError && !list.data) {
    body = <ErrorState error={list.error} onRetry={() => void list.refetch()} />;
  } else if (!rows.length) {
    body = (
      <EmptyState
        icon={<Users />}
        compact
        title={status || q ? "No enrollments match" : "Nobody is enrolled yet"}
        description={status || q ? undefined : campaign.status === "draft" ? "The audience is enrolled when you launch the campaign." : undefined}
      />
    );
  } else {
    body = (
      <div className={cn("overflow-x-auto transition-opacity", list.isFetching && list.isPlaceholderData && "opacity-60")}>
        <table className="w-full min-w-[900px] border-collapse text-sm">
          <thead className="border-b border-line bg-s-2">
            <tr>
              <th scope="col" className={TH}>
                Contact
              </th>
              <th scope="col" className={TH}>
                Status
              </th>
              <th scope="col" className={TH}>
                Step
              </th>
              <th scope="col" className={TH}>
                Next run
              </th>
              <th scope="col" className={TH}>
                Note
              </th>
              <th scope="col" className={TH}>
                Enrolled
              </th>
              <th scope="col" className={TH}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((e) => {
              const open = e.status === "active" || e.status === "paused";
              const note = e.lastError || e.stopReason || (e.repliedAt ? `Replied ${f.relative(e.repliedAt)}` : "");
              return (
                <tr key={e.id} className="hover:bg-hover">
                  <td className={cn(TD, "max-w-60")}>
                    {e.contact.deleted ? (
                      <span className="block truncate text-text-3">{e.contact.fullName || e.contact.email || "Deleted contact"} (deleted)</span>
                    ) : (
                      <Link href={ws.href(`/contacts/${e.contact.id}`)} className="group block min-w-0">
                        <span className="block truncate font-medium text-text group-hover:text-accent-hi">{e.contact.fullName || e.contact.email || "Unnamed contact"}</span>
                        <span className="block truncate text-xs text-text-3">{[e.contact.email, e.contact.company].filter(Boolean).join(" · ")}</span>
                      </Link>
                    )}
                  </td>
                  <td className={cn(TD, "whitespace-nowrap")}>
                    <StatusBadge value={e.status} />
                  </td>
                  <td className={cn(TD, "whitespace-nowrap text-text-2")}>
                    <span className="flex items-center gap-2">
                      {e.step && <StepTile type={e.step.type} />}
                      {stepLabel(e)}
                    </span>
                  </td>
                  <td className={cn(TD, "whitespace-nowrap text-text-2")} title={e.nextRunAt ? f.dateTime(e.nextRunAt) : undefined}>
                    {e.nextRunAt ? f.smart(e.nextRunAt) : <span className="text-text-3">—</span>}
                  </td>
                  <td className={cn(TD, "max-w-72 truncate", e.lastError ? "text-bad-ink" : "text-text-2")} title={note || undefined}>
                    {note || <span className="text-text-3">—</span>}
                  </td>
                  <td className={cn(TD, "whitespace-nowrap text-text-3")} title={f.dateTime(e.enrolledAt)}>
                    {f.smart(e.enrolledAt)}
                  </td>
                  <td className={cn(TD, "text-right")}>
                    {canLaunch && open && <IconButton size="sm" label={`Stop ${e.contact.fullName || "this enrollment"}`} icon={<X />} onClick={() => setStopping(e)} />}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <SearchInput
          value={q}
          onChange={(v) => {
            setQ(v);
            setPage(1);
          }}
          placeholder="Search name or email"
          className="sm:max-w-xs"
        />
        <NativeSelect
          aria-label="Status"
          className="sm:w-40"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as EnrollmentStatus | "");
            setPage(1);
          }}
          options={[{ value: "", label: "All statuses" }, ...ENROLLMENT_STATUSES.map((s) => ({ value: s, label: labelOf(s) }))]}
        />
        {canLaunch && ENROLLABLE.includes(campaign.status) && (
          <Button icon={<UserPlus />} className="sm:ml-auto" onClick={() => setAdding(true)}>
            Add contacts
          </Button>
        )}
      </div>
      <Card className="overflow-hidden">
        {body}
        {list.data && list.data.total > 0 && (
          <div className="border-t border-line px-3 py-2">
            <Pagination page={page} pageSize={pageSize} total={list.data.total} pageSizes={PAGE_SIZES} onPageChange={setPage} onPageSizeChange={(n) => (setPageSize(n), setPage(1))} />
          </div>
        )}
      </Card>

      <ConfirmDialog
        open={stopping !== null}
        onOpenChange={(o) => !o && setStopping(null)}
        title={`Stop ${stopping?.contact.fullName || "this enrollment"}?`}
        confirmLabel="Stop"
        description="Nothing more is sent to this contact from this campaign. They cannot be enrolled in it again."
        onConfirm={() => stopping && stop.mutateAsync(stopping.id)}
      />
      {adding && <AddContactsModal campaign={campaign} onClose={() => setAdding(false)} />}
    </div>
  );
}

/** Pick contacts and POST /enroll; shows how many were enrolled and why the rest were skipped. */
function AddContactsModal({ campaign, onClose }: { campaign: CampaignDetail; onClose: () => void }) {
  const ws = useWorkspace();
  const [picked, setPicked] = useState<{ id: string; label: string }[]>([]);
  const [result, setResult] = useState<EnrollResult | null>(null);
  const enroll = useApiMutation<EnrollResult, { contactIds: string[] }>({
    path: ws.path(`/campaigns/${campaign.id}/enroll`),
    invalidate: [ws.key("campaigns")],
    errorToast: false,
    onSuccess: (r) => setResult(r),
  });
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={result ? "Contacts added" : "Add contacts"}
      description={result ? undefined : "They start at the first step, paced by the campaign's daily new-contact limit and send window."}
      footer={
        result ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={onClose} disabled={enroll.isPending}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!picked.length} loading={enroll.isPending} onClick={() => enroll.mutate({ contactIds: picked.map((p) => p.id) })}>
              Enroll {picked.length ? plural(picked.length, "contact") : ""}
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="flex flex-col gap-3 text-sm">
          <p className="text-text">
            <strong className="font-medium">{plural(result.enrolled, "contact")}</strong> enrolled.
          </p>
          {result.skipped.length > 0 && (
            <div>
              <p className="mb-1 text-xs text-text-3">Not enrolled ({skippedTotal(result.skipped)})</p>
              <SkippedList items={result.skipped} />
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {enroll.error && !enroll.error.isPlanLimit && <FormError error={enroll.error.fields.contactIds ?? enroll.error.message} />}
          <Field label="Contact">
            <ContactPicker
              value={null}
              clearable={false}
              placeholder="Search contacts to add"
              onChange={(id, c) => {
                if (!id || picked.some((p) => p.id === id)) return;
                setPicked([...picked, { id, label: c ? contactLabel(c) : "Contact" }]);
              }}
            />
          </Field>
          {picked.length > 0 && (
            <ul className="max-h-64 divide-y divide-line overflow-y-auto rounded-md border border-line">
              {picked.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm">
                  <span className="truncate text-text">{p.label}</span>
                  <IconButton size="sm" label="Remove" icon={<X />} onClick={() => setPicked(picked.filter((x) => x.id !== p.id))} />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Modal>
  );
}
