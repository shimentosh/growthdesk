"use client";

import { useState } from "react";
import type { z } from "zod";
import { BadgeCheck, ChevronDown, CircleDot, ListChecks, SquareCheckBig, Tag, Tags, Trash2, UserCheck, UserRound, UserX, Users, X } from "lucide-react";
import { CONTACT_STATUSES, QUALIFICATIONS, labelOf, type BulkContactAction } from "@growthdesk/shared";
import { AddToListModal } from "@/components/marketing/AddToListModal";
import { MemberPicker } from "@/components/pickers/Pickers";
import { Button, IconButton } from "@/components/ui/Button";
import { ConfirmDialog, Modal } from "@/components/ui/Dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/DropdownMenu";
import { Field } from "@/components/ui/Field";
import { formatNumber } from "@/lib/format";
import { useApiMutation } from "@/lib/query";
import { useMe, useWorkspace } from "@/lib/session";
import type { BulkResult } from "@/lib/types/crm";
import { TagEditor } from "./Tags";

type BulkAction = Exclude<z.infer<typeof BulkContactAction>, { action: "enroll" }>;

const plural = (n: number) => `${formatNumber(n)} contact${n === 1 ? "" : "s"}`;

/**
 * What can be done to the selected rows (POST /contacts/bulk). Enrolling in a
 * campaign is not here: the API sends that through the campaign instead.
 */
export function BulkActionsBar({ ids, onDone, onClear }: { ids: string[]; onDone: () => void; onClear: () => void }) {
  const ws = useWorkspace();
  const me = useMe();
  const [tagMode, setTagMode] = useState<"tag" | "untag" | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [assigning, setAssigning] = useState(false);
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [listing, setListing] = useState(false);
  const [listed, setListed] = useState(false);

  const bulk = useApiMutation<BulkResult, BulkAction>({
    path: ws.path("/contacts/bulk"),
    invalidate: [ws.key("contacts"), ws.key("tags"), ws.key("companies")],
    success: (r, v) => (v.action === "delete" ? `${plural(r.affected)} deleted` : `${plural(r.affected)} updated`),
    onSuccess: () => {
      setTagMode(null);
      setTags([]);
      setAssigning(false);
      setOwnerId(null);
      onDone();
    },
  });

  const myId = me.data?.user.id;
  const n = ids.length;

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-accent/30 bg-tint-pick px-3 py-2" role="region" aria-label="Bulk actions">
      <span className="mr-1 inline-flex items-center gap-1.5 text-sm font-medium text-text tabular-nums">
        <SquareCheckBig aria-hidden className="size-4 text-accent-ink" />
        {plural(n)} selected
      </span>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" icon={<CircleDot />} iconRight={<ChevronDown />} disabled={bulk.isPending}>
            Status
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {CONTACT_STATUSES.map((s) => (
            <DropdownMenuItem key={s} onSelect={() => bulk.mutate({ action: "status", ids, status: s })}>
              {labelOf(s)}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" icon={<BadgeCheck />} iconRight={<ChevronDown />} disabled={bulk.isPending}>
            Qualification
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {QUALIFICATIONS.map((q) => (
            <DropdownMenuItem key={q} onSelect={() => bulk.mutate({ action: "qualification", ids, qualification: q })}>
              {labelOf(q)}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" icon={<UserCheck />} iconRight={<ChevronDown />} disabled={bulk.isPending}>
            Owner
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {myId && (
            <DropdownMenuItem icon={<UserRound />} onSelect={() => bulk.mutate({ action: "assign", ids, ownerId: myId })}>
              Assign to me
            </DropdownMenuItem>
          )}
          {ws.can("members.read") && (
            <DropdownMenuItem icon={<Users />} onSelect={() => setAssigning(true)}>
              Assign to a teammate…
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem icon={<UserX />} onSelect={() => bulk.mutate({ action: "assign", ids, ownerId: null })}>
            Remove owner
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" icon={<Tags />} iconRight={<ChevronDown />} disabled={bulk.isPending}>
            Tags
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem icon={<Tag />} onSelect={() => setTagMode("tag")}>
            Add tags…
          </DropdownMenuItem>
          <DropdownMenuItem icon={<X />} onSelect={() => setTagMode("untag")}>
            Remove tags…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {ws.can("marketing.write") && (
        <Button size="sm" icon={<ListChecks />} onClick={() => setListing(true)} disabled={bulk.isPending}>
          Add to list
        </Button>
      )}

      {ws.can("contacts.delete") && (
        <Button size="sm" variant="danger" icon={<Trash2 />} onClick={() => setDeleting(true)} disabled={bulk.isPending}>
          Delete
        </Button>
      )}

      <IconButton size="sm" label="Clear selection" icon={<X />} onClick={onClear} className="ml-auto" />

      <Modal
        open={tagMode !== null}
        onOpenChange={(o) => {
          if (!o) {
            setTagMode(null);
            setTags([]);
          }
        }}
        size="sm"
        title={tagMode === "untag" ? `Remove tags from ${plural(n)}` : `Add tags to ${plural(n)}`}
        description={tagMode === "untag" ? "Only these tags are removed; others stay." : "New tag names are created."}
        footer={
          <>
            <Button onClick={() => setTagMode(null)}>Cancel</Button>
            <Button
              variant="primary"
              icon={tagMode === "untag" ? <X /> : <Tag />}
              loading={bulk.isPending}
              disabled={!tags.length}
              onClick={() => tagMode && bulk.mutate({ action: tagMode, ids, tags })}
            >
              {tagMode === "untag" ? "Remove tags" : "Add tags"}
            </Button>
          </>
        }
      >
        <Field label="Tags">
          <TagEditor value={tags} onChange={setTags} />
        </Field>
      </Modal>

      <Modal
        open={assigning}
        onOpenChange={setAssigning}
        size="sm"
        title={`Assign ${plural(n)}`}
        footer={
          <>
            <Button onClick={() => setAssigning(false)}>Cancel</Button>
            <Button
              variant="primary"
              icon={<UserCheck />}
              loading={bulk.isPending}
              disabled={!ownerId}
              onClick={() => ownerId && bulk.mutate({ action: "assign", ids, ownerId })}
            >
              Assign
            </Button>
          </>
        }
      >
        <Field label="Owner">
          <MemberPicker value={ownerId} onChange={(id) => setOwnerId(id)} clearable={false} />
        </Field>
      </Modal>

      {ws.can("marketing.write") && (
        <AddToListModal
          open={listing}
          onOpenChange={(o) => {
            setListing(o);
            // Clearing the selection unmounts this bar, so it waits until the dialog closes.
            if (!o && listed) {
              setListed(false);
              onDone();
            }
          }}
          contactIds={ids}
          onAdded={(r) => setListed(r.added > 0)}
        />
      )}

      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${plural(n)}?`}
        description="They leave the CRM and any running sequences for them stop. Their email addresses and phone numbers are released, so they can be imported again."
        confirmLabel={`Delete ${plural(n)}`}
        onConfirm={() => bulk.mutateAsync({ action: "delete", ids })}
      />
    </div>
  );
}
