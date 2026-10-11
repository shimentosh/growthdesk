"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { Building2, Copy, GitMerge, Mail, Phone, X } from "lucide-react";
import { labelOf } from "@growthdesk/shared";
import { contactLabel } from "@/components/pickers/Pickers";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardFooter } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { ENTITY, EntityTile } from "@/components/ui/icons";
import { QueryState } from "@/components/ui/ErrorState";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { RequirePermission } from "@/components/ui/RequirePermission";
import { SkeletonText } from "@/components/ui/Skeleton";
import { cn } from "@/lib/cn";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import type { Contact, ContactDetail, DuplicatePair } from "@/lib/types/crm";

export default function DuplicatesPage() {
  return (
    <RequirePermission permission="contacts.read">
      <Duplicates />
    </RequirePermission>
  );
}

function Duplicates() {
  const ws = useWorkspace();
  const pairs = useApiQuery<DuplicatePair[]>(ws.key("contacts", "duplicates"), ws.path("/contacts/duplicates"));
  return (
    <Page width="capped">
      <PageHeader
        back={{ href: ws.href("/contacts"), label: "Contacts" }}
        title="Possible duplicates"
        icon={<EntityTile of="duplicates" />}
        description="Pairs flagged when a new contact shared an email or phone with an existing one, or had the same name at the same company."
      />
      <QueryState
        query={pairs}
        loading={<SkeletonText lines={6} />}
        isEmpty={(d) => d.length === 0}
        empty={
          <EmptyState
            icon={<Copy />}
            tint={ENTITY.duplicates.tint}
            title="No duplicates to review"
            description="When a new contact looks like someone already in the CRM, the pair shows up here."
          />
        }
      >
        {(list) => (
          <div className="flex flex-col gap-4">
            {list.length >= 200 && <p className="text-xs text-text-3">Showing the 200 strongest matches. Resolve some to see more.</p>}
            {list.map((p) => (
              <PairCard key={p.id} pair={p} />
            ))}
          </div>
        )}
      </QueryState>
    </Page>
  );
}

/** A glyph for why the pair was flagged: the shared email, phone, or name at a company. */
function reasonIcon(reason: string) {
  const r = reason.toLowerCase();
  if (r.includes("email")) return <Mail />;
  if (r.includes("phone")) return <Phone />;
  if (r.includes("company")) return <Building2 />;
  return <Copy />;
}

type Row = {
  label: string;
  value: (c: Contact) => ReactNode;
  text: (c: Contact) => string;
};

function PairCard({ pair }: { pair: DuplicatePair }) {
  const ws = useWorkspace();
  const f = useFormat();
  const canResolve = ws.can("contacts.delete");
  // Default primary: the older record, which usually carries the history.
  const [primary, setPrimary] = useState<"a" | "b">(pair.a.createdAt <= pair.b.createdAt ? "a" : "b");
  const [confirm, setConfirm] = useState(false);

  const keep = primary === "a" ? pair.a : pair.b;
  const drop = primary === "a" ? pair.b : pair.a;

  const merge = useApiMutation<ContactDetail, { primaryId: string; duplicateIds: string[] }>({
    path: ws.path("/contacts/merge"),
    invalidate: [ws.key("contacts"), ws.key("companies")],
    success: (c) => `Merged into ${contactLabel(c)}`,
    errorToast: false,
  });
  const dismiss = useApiMutation<{ dismissed: boolean }, void>({
    path: ws.path(`/contacts/duplicates/${pair.id}/dismiss`),
    invalidate: [ws.key("contacts", "duplicates")],
    success: "Marked as not a duplicate",
  });

  const rows: Row[] = [
    {
      label: "Name",
      value: (c) => contactLabel(c),
      text: (c) => contactLabel(c),
    },
    { label: "Email", value: (c) => c.email, text: (c) => c.email ?? "" },
    { label: "Phone", value: (c) => c.phone, text: (c) => c.phone ?? "" },
    {
      label: "Company",
      value: (c) => c.company?.name,
      text: (c) => c.company?.id ?? "",
    },
    { label: "Job title", value: (c) => c.jobTitle, text: (c) => c.jobTitle },
    {
      label: "Owner",
      value: (c) => c.owner?.name,
      text: (c) => c.owner?.id ?? "",
    },
    { label: "Status", value: (c) => labelOf(c.status), text: (c) => c.status },
    {
      label: "Qualification",
      value: (c) => labelOf(c.qualification),
      text: (c) => c.qualification,
    },
    {
      label: "Tags",
      value: (c) => c.tags.map((t) => t.name).join(", "),
      text: (c) =>
        c.tags
          .map((t) => t.name)
          .sort()
          .join(","),
    },
    {
      label: "Last contacted",
      value: (c) => (c.lastContactedAt ? f.date(c.lastContactedAt) : "Never"),
      text: (c) => c.lastContactedAt ?? "",
    },
    {
      label: "Created",
      value: (c) => f.dateTime(c.createdAt),
      text: (c) => c.createdAt,
    },
  ];

  const side = (key: "a" | "b") => {
    const c = pair[key];
    const chosen = primary === key;
    return (
      <th scope="col" className={cn("w-[40%] px-3 py-2.5 text-left align-top font-normal", chosen && "bg-tint-pick")}>
        <div className="flex flex-col gap-1.5">
          <Link href={ws.href(`/contacts/${c.id}`)} className="group flex min-w-0 items-center gap-2">
            <Avatar size="sm" name={c.fullName} email={c.email} />
            <span className="truncate text-sm font-semibold text-text group-hover:text-accent-hi">{contactLabel(c)}</span>
          </Link>
          {canResolve && (
            <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-text-2">
              <input type="radio" name={`primary-${pair.id}`} checked={chosen} onChange={() => setPrimary(key)} className="accent-[var(--accent)]" />
              Keep as primary
            </label>
          )}
        </div>
      </th>
    );
  };

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
        <p className="flex min-w-0 items-center gap-2 text-sm font-medium text-text">
          <span aria-hidden className="flex text-text-3 [&_svg]:size-4">
            {reasonIcon(pair.reason)}
          </span>
          {pair.reason}
        </p>
        <Badge tone={pair.score >= 90 ? "warn" : "mute"} title="How strongly the two records match (0–100)">
          Match {pair.score}
        </Badge>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] border-collapse text-sm">
          <thead className="border-b border-line">
            <tr>
              <th scope="col" className="w-[20%] px-3 py-2.5 text-left text-xs font-medium text-text-3">
                <span className="sr-only">Field</span>
              </th>
              {side("a")}
              {side("b")}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((r) => {
              const differs = r.text(pair.a) !== r.text(pair.b);
              return (
                <tr key={r.label}>
                  <th scope="row" className="px-3 py-2 text-left text-xs font-normal text-text-3">
                    {r.label}
                    {differs && <span className="sr-only"> (differs)</span>}
                  </th>
                  {(["a", "b"] as const).map((k) => {
                    const v = r.value(pair[k]);
                    return (
                      <td key={k} className={cn("px-3 py-2 break-words", primary === k && "bg-tint-pick", differs ? "text-text" : "text-text-2")}>
                        {v === null || v === undefined || v === "" ? <span className="text-text-3">—</span> : v}
                        {differs && k === "a" && <span aria-hidden className="ml-1.5 inline-block size-1.5 rounded-full bg-warn align-middle" />}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {canResolve ? (
        <CardFooter className="justify-between">
          <span className="text-xs text-text-3">
            <span aria-hidden className="mr-1 inline-block size-1.5 rounded-full bg-warn align-middle" />
            marks fields that differ.
          </span>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" icon={<X />} loading={dismiss.isPending} onClick={() => dismiss.mutate()}>
              Not a duplicate
            </Button>
            <Button size="sm" variant="primary" icon={<GitMerge />} onClick={() => setConfirm(true)}>
              Merge into {contactLabel(keep)}
            </Button>
          </div>
        </CardFooter>
      ) : (
        <CardFooter className="justify-start">
          <span className="text-xs text-text-3">Your role cannot merge or dismiss duplicates.</span>
        </CardFooter>
      )}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        tone="default"
        title={`Merge ${contactLabel(drop)} into ${contactLabel(keep)}?`}
        confirmLabel="Merge contacts"
        description={`${contactLabel(keep)} stays. Notes, activity, deals, tasks, meetings, conversations, calls, tags, emails and phones move over from ${contactLabel(drop)}; fields that are blank on ${contactLabel(keep)} are filled in from it; then ${contactLabel(drop)} is deleted. This cannot be undone.`}
        onConfirm={() => merge.mutateAsync({ primaryId: keep.id, duplicateIds: [drop.id] })}
      />
    </Card>
  );
}
