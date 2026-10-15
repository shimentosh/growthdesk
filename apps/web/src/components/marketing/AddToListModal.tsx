"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { BadgeCheck, CircleCheck, CircleMinus, ListChecks, MailCheck, Plus, UserPlus, Users } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Checkbox } from "@/components/ui/Checkbox";
import { Modal } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { EntityTile } from "@/components/ui/icons";
import { Input, NativeSelect } from "@/components/ui/Input";
import { cn } from "@/lib/cn";
import { formatNumber } from "@/lib/format";
import { useApiMutation } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import { SKIP_REASONS, type AddMembersResult } from "@/lib/types/marketing";
import { SKIP_LABEL, useMarketing, useMarketingLists } from "./common";
import { ContactChooser, MAX_PICK, type PickedContact } from "./ContactChooser";
import { ListFormModal } from "./lists/ListFormModal";

type AddBody = { contactIds: string[]; consent?: { confirmed: true; source: string } };

const people = (n: number) => `${formatNumber(n)} ${n === 1 ? "person" : "people"}`;
const contacts = (n: number) => `${formatNumber(n)} contact${n === 1 ? "" : "s"}`;
const skippedTotal = (r: AddMembersResult) => SKIP_REASONS.reduce((sum, k) => sum + (r.skipped[k] ?? 0), 0);

/**
 * Add contacts to a lead list (POST marketing/lists/:id/members). Give it a
 * list, contacts, both or neither: whatever is missing is chosen in the
 * dialog. The answer says who was added and why anyone was left out.
 * Consent is not needed to join a lead list; when the person adding them
 * ticks "I have consent" and says where, it is recorded on each contact, and
 * only people with recorded consent receive marketing email.
 */
export function AddToListModal({
  open,
  onOpenChange,
  listId: fixedListId,
  listName,
  contactIds: fixedContactIds,
  contactsLabel,
  excludeListIds = [],
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Add to this list (otherwise one is picked from the active lists). */
  listId?: string;
  listName?: string;
  /** Add these contacts (otherwise they are picked here). */
  contactIds?: string[];
  /** Who `contactIds` are, in words: "Ada Lovelace", "12 contacts". */
  contactsLabel?: string;
  /** Lists not to offer (e.g. the ones a contact is already on). */
  excludeListIds?: string[];
  /** After each successful add, with the running totals. */
  onAdded?: (result: AddMembersResult) => void;
}) {
  const ws = useWorkspace();
  const mk = useMarketing();
  const lists = useMarketingLists();
  const [pickedListId, setPickedListId] = useState("");
  const [picked, setPicked] = useState<PickedContact[]>([]);
  const [result, setResult] = useState<AddMembersResult | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [source, setSource] = useState("");
  const [sourceError, setSourceError] = useState<string | null>(null);

  const listId = fixedListId ?? pickedListId;
  const ids = fixedContactIds ?? picked.map((c) => c.id);
  const options = (lists.data ?? []).filter((l) => l.id === fixedListId || !excludeListIds.includes(l.id));
  const targetName = listName ?? lists.data?.find((l) => l.id === listId)?.name ?? "the list";

  const [withConsent, setWithConsent] = useState(false);
  const [creatingList, setCreatingList] = useState(false);

  const add = useApiMutation<AddMembersResult, AddBody>({
    path: () => mk.path(`/lists/${listId}/members`),
    // Lists, members and contact memberships live under the marketing key; consent shows on the contact.
    invalidate: (_r, v) => [mk.key("lists"), mk.key("contacts"), ...(v.consent ? [ws.key("contacts")] : [])],
    errorToast: false,
    onSuccess: (r, v) => {
      // The second pass resends everyone: those added on the first pass now come back as already members.
      const next = v.consent && result ? { added: result.added + r.added, pending: r.pending, alreadyMember: Math.max(0, r.alreadyMember - result.added), skipped: r.skipped } : r;
      setResult(next);
      onAdded?.(next);
    },
  });

  const reset = () => {
    setPickedListId("");
    setPicked([]);
    setResult(null);
    setAgreed(false);
    setSource("");
    setSourceError(null);
    setWithConsent(false);
    add.reset();
  };
  const change = (next: boolean) => {
    if (!next) {
      if (add.isPending) return;
      reset();
    }
    onOpenChange(next);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!listId || !ids.length || ids.length > MAX_PICK) return;
    if (withConsent && !source.trim()) {
      setSourceError("Say where they agreed, e.g. the signup form or the event.");
      return;
    }
    add.mutate({ contactIds: ids, ...(withConsent ? { consent: { confirmed: true as const, source: source.trim() } } : {}) });
  };
  const confirmConsent = (e: FormEvent) => {
    e.preventDefault();
    if (!source.trim()) {
      setSourceError("Say where they agreed, e.g. the signup form or the event.");
      return;
    }
    add.mutate({ contactIds: ids, consent: { confirmed: true, source: source.trim() } });
  };

  const noConsent = result?.skipped.no_consent ?? 0;
  const apiError = add.error && !add.error.isPlanLimit ? add.error : null;
  const fieldErrors = apiError?.fields ?? {};

  let body: ReactNode;
  let footer: ReactNode;
  if (!result) {
    const noLists = !fixedListId && lists.isSuccess && !options.length;
    body = (
      <form id="add-to-list" onSubmit={submit} noValidate className="flex flex-col gap-4">
        {apiError && <FormError error={apiError.message} />}
        {!fixedListId &&
          (noLists ? (
            <Callout
              tone="info"
              title={lists.data?.length ? "Already on every list" : "No lists yet"}
              action={
                <Button size="sm" icon={<Plus />} onClick={() => setCreatingList(true)}>
                  New list
                </Button>
              }
            >
              {lists.data?.length ? "There is no other active list to add to. Create a new one." : "Create a list to group people, then add them to it."}
            </Callout>
          ) : (
            <Field
              label="List"
              required
              error={lists.isError ? `Lists could not be loaded: ${lists.error.message}` : undefined}
              labelAction={
                <button type="button" className="inline-flex items-center gap-1 text-xs text-accent-hi hover:underline" onClick={() => setCreatingList(true)}>
                  <Plus aria-hidden className="size-3" />
                  New list
                </button>
              }
            >
              <NativeSelect
                value={pickedListId}
                onChange={(e) => setPickedListId(e.target.value)}
                disabled={lists.isPending}
                placeholder={lists.isPending ? "Loading lists…" : "Choose a list"}
                options={options.map((l) => ({ value: l.id, label: `${l.name} · ${formatNumber(l.counts.subscribed)} subscribed` }))}
              />
            </Field>
          ))}
        {fixedContactIds ? (
          <div className="flex items-center gap-2.5 rounded-md border border-line bg-well px-3 py-2.5 text-sm text-text">
            <Users aria-hidden className="size-4 shrink-0 text-text-3" />
            <span className="min-w-0 truncate">{contactsLabel ?? contacts(fixedContactIds.length)}</span>
          </div>
        ) : (
          <ContactChooser picked={picked} onPickedChange={setPicked} error={fieldErrors.contactIds} />
        )}
        <div className="flex flex-col gap-2 rounded-md border border-line px-3 py-2.5">
          <Checkbox
            checked={withConsent}
            onCheckedChange={(c) => {
              setWithConsent(c);
              setSourceError(null);
            }}
            label="I have consent for marketing email"
            description="Optional. Anyone can join a lead list for outreach; only people with recorded consent receive marketing campaigns."
          />
          {withConsent && (
            <Field label="Where did they agree?" required error={sourceError ?? fieldErrors["consent.source"]}>
              <Input
                value={source}
                maxLength={200}
                placeholder="Signup form at the October webinar"
                onChange={(e) => {
                  setSource(e.target.value);
                  setSourceError(null);
                }}
              />
            </Field>
          )}
        </div>
      </form>
    );
    footer = (
      <>
        <Button onClick={() => change(false)} disabled={add.isPending}>
          Cancel
        </Button>
        <Button variant="primary" type="submit" form="add-to-list" icon={<UserPlus />} loading={add.isPending} disabled={!listId || !ids.length || ids.length > MAX_PICK}>
          {ids.length > 1 ? `Add ${contacts(ids.length)}` : "Add to list"}
        </Button>
      </>
    );
  } else {
    const skipped = SKIP_REASONS.filter((k) => (result.skipped[k] ?? 0) > 0);
    body = (
      <div className="flex flex-col gap-4">
        {apiError && <FormError error={apiError.message} />}
        <ul className="flex flex-col divide-y divide-line rounded-md border border-line">
          <ResultRow icon={<CircleCheck />} tone="ok" label={`Added to ${targetName}`} value={result.added} />
          {result.alreadyMember > 0 && <ResultRow icon={<ListChecks />} label="Already on the list" value={result.alreadyMember} />}
          {result.pending > 0 && <ResultRow icon={<MailCheck />} tone="warn" label="Waiting to confirm by email" value={result.pending} />}
          {skipped.map((k) => (
            <ResultRow key={k} icon={<CircleMinus />} tone={k === "no_consent" ? "warn" : undefined} label={`Skipped: ${SKIP_LABEL[k]}`} value={result.skipped[k]} />
          ))}
        </ul>
        {noConsent > 0 ? (
          <form id="confirm-consent" onSubmit={confirmConsent} noValidate className="flex flex-col gap-3 rounded-md border border-warn-edge bg-warn-wash px-3.5 py-3">
            <div>
              <p className="text-sm font-medium text-warn-ink">
                {people(noConsent)} {noConsent === 1 ? "has" : "have"} no recorded marketing consent
              </p>
              <p className="mt-0.5 text-xs text-text-2">
                If they agreed to hear from you, confirm it and say where. It is saved on each contact as proof of consent, and they are added to the list.
              </p>
            </div>
            <Checkbox checked={agreed} onCheckedChange={setAgreed} label="They agreed to receive marketing email" />
            <Field label="Where did they agree?" required error={sourceError ?? fieldErrors["consent.source"]}>
              <Input
                value={source}
                maxLength={200}
                disabled={!agreed}
                placeholder="Signup form at the October webinar"
                onChange={(e) => {
                  setSource(e.target.value);
                  setSourceError(null);
                }}
              />
            </Field>
          </form>
        ) : (
          (result.pending > 0 ? (
            <p className="text-xs text-text-3">
              {targetName} asks new subscribers to confirm: {people(result.pending)} without recorded consent {result.pending === 1 ? "is" : "are"} being emailed a link
              and will be subscribed once they confirm. Campaigns don&apos;t reach them until then.
            </p>
          ) : (
            skippedTotal(result) === 0 && result.added > 0 && <p className="text-xs text-text-3">Everyone you picked is now subscribed.</p>
          ))
        )}
      </div>
    );
    footer =
      noConsent > 0 ? (
        <>
          <Button onClick={() => change(false)} disabled={add.isPending}>
            Skip them
          </Button>
          <Button variant="primary" type="submit" form="confirm-consent" icon={<BadgeCheck />} loading={add.isPending} disabled={!agreed}>
            Confirm and add {formatNumber(noConsent)}
          </Button>
        </>
      ) : (
        <Button variant="primary" onClick={() => change(false)}>
          Done
        </Button>
      );
  }

  return (
    <Modal
      open={open}
      onOpenChange={change}
      size={fixedContactIds ? "md" : "lg"}
      dismissOnOutside={!result && !picked.length}
      icon={<EntityTile of="lists" size="md" />}
      title={
        result
          ? result.added > 0
            ? "Added to list"
            : noConsent > 0
              ? "Consent needed"
              : "Nobody was added"
          : fixedListId
            ? `Add contacts to ${targetName}`
            : "Add to list"
      }
      description={
        result
          ? `${people(ids.length)} checked against ${targetName}.`
          : fixedContactIds
            ? `Add ${contactsLabel ?? contacts(fixedContactIds.length)} to a lead list.`
            : "They can be enrolled in outreach campaigns sent to this list."
      }
      footer={footer}
    >
      {body}
      {/* Outside the add form: a submit inside the portal would otherwise bubble up to it through React. */}
      {!fixedListId && <ListFormModal key={String(creatingList)} open={creatingList} onOpenChange={setCreatingList} onSaved={(l) => setPickedListId(l.id)} />}
    </Modal>
  );
}

function ResultRow({ icon, label, value, tone }: { icon: ReactNode; label: string; value: number; tone?: "ok" | "warn" }) {
  return (
    <li className="flex items-center justify-between gap-3 px-3 py-2">
      <span className="flex min-w-0 items-center gap-2 text-sm text-text">
        <span aria-hidden className={cn("shrink-0 [&_svg]:size-4", tone === "ok" ? "text-ok-ink" : tone === "warn" ? "text-warn-ink" : "text-text-3")}>
          {icon}
        </span>
        <span className="truncate">{label}</span>
      </span>
      <span className={cn("shrink-0 text-sm font-medium tabular-nums", value ? "text-text" : "text-text-3")}>{formatNumber(value)}</span>
    </li>
  );
}
