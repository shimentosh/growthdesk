"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { BadgeCheck, CircleCheck, CircleMinus, ListChecks, UserPlus, Users, X } from "lucide-react";
import { ContactPicker, contactLabel } from "@/components/pickers/Pickers";
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

type AddBody = { contactIds: string[]; consent?: { confirmed: true; source: string } };

const people = (n: number) => `${formatNumber(n)} ${n === 1 ? "person" : "people"}`;
const contacts = (n: number) => `${formatNumber(n)} contact${n === 1 ? "" : "s"}`;
const skippedTotal = (r: AddMembersResult) => SKIP_REASONS.reduce((sum, k) => sum + (r.skipped[k] ?? 0), 0);

/**
 * Subscribe contacts to a marketing list (POST marketing/lists/:id/members).
 * Give it a list, contacts, both or neither: whatever is missing is chosen in
 * the dialog. The answer says who was added and why anyone was left out.
 * People without recorded consent can be added on a second pass once the
 * person adding them confirms they agreed, and says where; that is recorded
 * as the contact's consent.
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
  const [picked, setPicked] = useState<{ id: string; label: string; sub: string | null }[]>([]);
  const [result, setResult] = useState<AddMembersResult | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [source, setSource] = useState("");
  const [sourceError, setSourceError] = useState<string | null>(null);

  const listId = fixedListId ?? pickedListId;
  const ids = fixedContactIds ?? picked.map((c) => c.id);
  const options = (lists.data ?? []).filter((l) => l.id === fixedListId || !excludeListIds.includes(l.id));
  const targetName = listName ?? lists.data?.find((l) => l.id === listId)?.name ?? "the list";

  const add = useApiMutation<AddMembersResult, AddBody>({
    path: () => mk.path(`/lists/${listId}/members`),
    // Lists, members and contact memberships live under the marketing key; consent shows on the contact.
    invalidate: (_r, v) => [mk.key("lists"), mk.key("contacts"), ...(v.consent ? [ws.key("contacts")] : [])],
    errorToast: false,
    onSuccess: (r, v) => {
      // The second pass resends everyone: those added on the first pass now come back as already members.
      const next = v.consent && result ? { added: result.added + r.added, alreadyMember: Math.max(0, r.alreadyMember - result.added), skipped: r.skipped } : r;
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
    if (!listId || !ids.length) return;
    add.mutate({ contactIds: ids });
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
            <Callout tone="info" title={lists.data?.length ? "Already on every list" : "No lists yet"}>
              {lists.data?.length ? "There is no other active list to add to." : "Create a list under Marketing → Lists first."}
            </Callout>
          ) : (
            <Field label="List" required error={lists.isError ? `Lists could not be loaded: ${lists.error.message}` : undefined}>
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
          <Field label="Contacts" required error={fieldErrors.contactIds} hint="Pick one at a time; each joins the list below.">
            <ContactPicker
              value={null}
              placeholder="Add a contact"
              onChange={(id, c) => {
                if (!id || !c || picked.some((p) => p.id === id)) return;
                setPicked((prev) => [...prev, { id, label: contactLabel(c), sub: c.email }]);
              }}
            />
            {picked.length > 0 && (
              <ul className="mt-1 flex max-h-56 flex-col divide-y divide-line overflow-y-auto rounded-md border border-line">
                {picked.map((c) => (
                  <li key={c.id} className="flex items-center justify-between gap-2 px-3 py-1.5">
                    <span className="min-w-0">
                      <span className="block truncate text-sm text-text">{c.label}</span>
                      <span className="block truncate text-xs text-text-3">{c.sub || "No email address"}</span>
                    </span>
                    <button
                      type="button"
                      aria-label={`Remove ${c.label}`}
                      onClick={() => setPicked((prev) => prev.filter((p) => p.id !== c.id))}
                      className="shrink-0 rounded-xs p-1 text-text-3 hover:bg-hover hover:text-text"
                    >
                      <X aria-hidden className="size-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Field>
        )}
        <p className="text-xs text-text-3">Only people with recorded marketing consent are added. Anyone else is listed afterwards, with the reason.</p>
      </form>
    );
    footer = (
      <>
        <Button onClick={() => change(false)} disabled={add.isPending}>
          Cancel
        </Button>
        <Button variant="primary" type="submit" form="add-to-list" icon={<UserPlus />} loading={add.isPending} disabled={!listId || !ids.length}>
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
          {result.alreadyMember > 0 && <ResultRow icon={<ListChecks />} label="Already subscribed" value={result.alreadyMember} />}
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
          skippedTotal(result) === 0 && result.added > 0 && <p className="text-xs text-text-3">Everyone you picked is now subscribed.</p>
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
      size="md"
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
            ? `Subscribe ${contactsLabel ?? contacts(fixedContactIds.length)} to a marketing list.`
            : "They receive the campaigns sent to this list."
      }
      footer={footer}
    >
      {body}
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
