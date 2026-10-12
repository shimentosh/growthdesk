"use client";

import { useState } from "react";
import type { z } from "zod";
import { Archive, ArchiveRestore, ArrowRightLeft, ChevronDown, Flag, Handshake, ListChecks, UserPlus, Users } from "lucide-react";
import { LIFECYCLE_STAGES, type BulkContactAction, type LifecycleStage } from "@growthdesk/shared";
import { AddToListModal } from "@/components/marketing/AddToListModal";
import { MemberPicker } from "@/components/pickers/Pickers";
import { Badge, type Tone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { ConfirmDialog, Modal } from "@/components/ui/Dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/DropdownMenu";
import { Field } from "@/components/ui/Field";
import { formatNumber } from "@/lib/format";
import { useApiMutation } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import type { BulkResult, Contact } from "@/lib/types/crm";

/*
 * The people lifecycle: lead → sales → contact. Imports land people as leads
 * on a lead list; qualified leads are handed to sales; a won deal or a held
 * meeting makes them contacts. Archiving takes someone out of every list,
 * picker and audience without deleting them.
 *
 * Every change here goes through POST /contacts/bulk, also for one person.
 */

/** Lead lists answer to marketing or contacts permissions (the API allows either). */
export const LIST_READ = ["marketing.read", "contacts.read"] as const;
export const LIST_WRITE = ["marketing.write", "contacts.write"] as const;

export const STAGE_LABEL: Record<LifecycleStage, string> = { lead: "Lead", sales: "In sales", contact: "Contact" };
/** The stage as a segment/tab name (plural). */
export const STAGE_PLURAL: Record<LifecycleStage, string> = { lead: "Leads", sales: "In sales", contact: "Contacts" };
const STAGE_TONE: Record<LifecycleStage, Tone> = { lead: "info", sales: "warn", contact: "ok" };

export function StageBadge({ stage, className }: { stage: LifecycleStage | null | undefined; className?: string }) {
  if (!stage) return null;
  return (
    <Badge tone={STAGE_TONE[stage]} quiet className={className}>
      {STAGE_LABEL[stage]}
    </Badge>
  );
}

type LifecycleAction = Extract<z.infer<typeof BulkContactAction>, { action: "archive" | "unarchive" | "stage" | "transfer_to_sales" }>;

const plural = (n: number) => `${formatNumber(n)} ${n === 1 ? "person" : "people"}`;

/** POST /contacts/bulk for the lifecycle actions, with a toast that says what happened. */
export function useLifecycleBulk(onDone?: () => void) {
  const ws = useWorkspace();
  return useApiMutation<BulkResult, LifecycleAction>({
    path: ws.path("/contacts/bulk"),
    // Transfers stop sequences, so campaign counts move too.
    invalidate: (_r, v) => [ws.key("contacts"), ws.key("companies"), ...(v.action === "transfer_to_sales" ? [ws.key("campaigns")] : [])],
    success: (r, v) => {
      const who = plural(r.affected);
      switch (v.action) {
        case "archive":
          return `${who} archived`;
        case "unarchive":
          return `${who} restored`;
        case "transfer_to_sales":
          return `${who} handed to sales`;
        case "stage":
          return `${who} moved to ${STAGE_PLURAL[v.stage]}`;
      }
    },
    onSuccess: () => onDone?.(),
  });
}

/** Hand people to sales: stage → In sales, optionally a new owner; their outreach sequences stop. */
export function TransferToSalesModal({
  open,
  onOpenChange,
  ids,
  label,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ids: string[];
  /** Who, in words ("Ada Lovelace"); default "N people". */
  label?: string;
  onDone?: () => void;
}) {
  const ws = useWorkspace();
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const bulk = useLifecycleBulk(() => {
    setOwnerId(null);
    onOpenChange(false);
    onDone?.();
  });
  const who = label ?? plural(ids.length);
  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (bulk.isPending) return;
        if (!o) setOwnerId(null);
        onOpenChange(o);
      }}
      size="sm"
      icon={<ArrowRightLeft aria-hidden className="mt-1 size-4 text-text-3" />}
      title={`Transfer ${who} to sales`}
      description="Mark them qualified and hand them over. They move to In sales, and any outreach sequences still running for them stop."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)} disabled={bulk.isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon={<Handshake />}
            loading={bulk.isPending}
            onClick={() => bulk.mutate({ action: "transfer_to_sales", ids, ...(ownerId ? { ownerId } : {}) })}
          >
            Transfer to sales
          </Button>
        </>
      }
    >
      {ws.can("members.read") ? (
        <Field label="New owner" hint="Optional. Leave empty to keep each person's current owner.">
          <MemberPicker value={ownerId} onChange={(id) => setOwnerId(id)} placeholder="Keep current owner" />
        </Field>
      ) : (
        <p className="text-sm text-text-2">Each person keeps their current owner.</p>
      )}
    </Modal>
  );
}

/**
 * The record's lifecycle controls: transfer to sales, change stage, add to a
 * lead list, archive / restore. Renders nothing for people who cannot edit.
 */
export function ContactLifecycleMenu({ contact, name }: { contact: Pick<Contact, "id" | "lifecycleStage" | "archivedAt">; name: string }) {
  const ws = useWorkspace();
  const [transferring, setTransferring] = useState(false);
  const [listing, setListing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const bulk = useLifecycleBulk();
  if (!ws.can("contacts.write")) return null;
  const ids = [contact.id];
  const archived = Boolean(contact.archivedAt);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button icon={<Flag />} iconRight={<ChevronDown />} disabled={bulk.isPending}>
            Lifecycle
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {contact.lifecycleStage !== "sales" && contact.lifecycleStage !== "contact" && (
            <DropdownMenuItem icon={<Handshake />} onSelect={() => setTransferring(true)}>
              Transfer to sales…
            </DropdownMenuItem>
          )}
          {LIFECYCLE_STAGES.filter((s) => s !== contact.lifecycleStage).map((s) => (
            <DropdownMenuItem key={s} icon={s === "lead" ? <UserPlus /> : s === "sales" ? <Handshake /> : <Users />} onSelect={() => bulk.mutate({ action: "stage", ids, stage: s })}>
              Move to {STAGE_PLURAL[s]}
            </DropdownMenuItem>
          ))}
          {ws.can(LIST_WRITE) && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem icon={<ListChecks />} onSelect={() => setListing(true)}>
                Add to lead list…
              </DropdownMenuItem>
            </>
          )}
          <DropdownMenuSeparator />
          {archived ? (
            <DropdownMenuItem icon={<ArchiveRestore />} onSelect={() => bulk.mutate({ action: "unarchive", ids })}>
              Restore
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem icon={<Archive />} onSelect={() => setArchiving(true)}>
              Archive…
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <TransferToSalesModal open={transferring} onOpenChange={setTransferring} ids={ids} label={name} />
      {ws.can(LIST_WRITE) && <AddToListModal open={listing} onOpenChange={setListing} contactIds={ids} contactsLabel={name} />}
      <ConfirmDialog
        open={archiving}
        onOpenChange={setArchiving}
        tone="default"
        title={`Archive ${name}?`}
        description={ARCHIVE_DESCRIPTION}
        confirmLabel="Archive"
        onConfirm={() => bulk.mutateAsync({ action: "archive", ids })}
      />
    </>
  );
}

export const ARCHIVE_DESCRIPTION =
  "Archived people leave the contact and lead lists, pickers and campaign audiences, but keep their history. Nothing is deleted, and you can restore them at any time.";

/** The banner on an archived record, with Restore. */
export function ArchivedBanner({ contact, className }: { contact: Pick<Contact, "id" | "archivedAt">; className?: string }) {
  const ws = useWorkspace();
  const f = useFormat();
  const bulk = useLifecycleBulk();
  if (!contact.archivedAt) return null;
  return (
    <Callout
      tone="warn"
      title={`Archived ${f.date(contact.archivedAt)}`}
      className={className}
      action={
        ws.can("contacts.write") ? (
          <Button size="sm" icon={<ArchiveRestore />} loading={bulk.isPending} onClick={() => bulk.mutate({ action: "unarchive", ids: [contact.id] })}>
            Restore
          </Button>
        ) : undefined
      }
    >
      They are left out of lists, pickers and campaign audiences. Their history is kept.
    </Callout>
  );
}
