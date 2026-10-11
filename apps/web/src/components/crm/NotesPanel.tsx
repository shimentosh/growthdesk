"use client";

import { useState, type FormEvent } from "react";
import type { QueryKey } from "@tanstack/react-query";
import { Ellipsis, Pencil, Pin, PinOff, Plus, StickyNote, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button, IconButton } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { Checkbox } from "@/components/ui/Checkbox";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/DropdownMenu";
import { Textarea } from "@/components/ui/Input";
import { SkeletonText } from "@/components/ui/Skeleton";
import { useApiMutation } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import type { Note } from "@/lib/types/crm";

/**
 * Notes on a contact or company: an add box, then the list (pinned first, as
 * the API orders it). Pin, edit and delete go through /notes/:id.
 */
export function NotesPanel({
  notes,
  loading,
  addPath,
  invalidate,
}: {
  notes: Note[] | undefined;
  loading?: boolean;
  /** POST target, e.g. ws.path(`/contacts/${id}/notes`). */
  addPath: string;
  /** Keys to refetch after any change (the notes list and/or the record). */
  invalidate: QueryKey[];
}) {
  const ws = useWorkspace();
  const canWrite = ws.can("contacts.write");
  const [body, setBody] = useState("");
  const [pinned, setPinned] = useState(false);

  const add = useApiMutation<Note, { body: string; pinned: boolean }>({
    path: addPath,
    invalidate,
    success: "Note added",
    onSuccess: () => {
      setBody("");
      setPinned(false);
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (body.trim()) add.mutate({ body: body.trim(), pinned });
  };

  return (
    <Card>
      <CardHeader icon={<StickyNote />} title="Notes" description={notes ? `${notes.length} note${notes.length === 1 ? "" : "s"}` : undefined} />
      {canWrite && (
        <form onSubmit={submit} className="flex flex-col gap-2 border-b border-line p-4">
          <Textarea
            rows={3}
            aria-label="New note"
            placeholder="Write a note…"
            value={body}
            maxLength={10000}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(e);
            }}
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Checkbox checked={pinned} onCheckedChange={setPinned} label="Pin to top" />
            <Button type="submit" size="sm" variant="primary" icon={<Plus />} loading={add.isPending} disabled={!body.trim()}>
              Add note
            </Button>
          </div>
        </form>
      )}
      {loading && !notes ? (
        <div className="p-4">
          <SkeletonText lines={3} />
        </div>
      ) : !notes?.length ? (
        <EmptyState
          compact
          icon={<StickyNote />}
          title="No notes yet"
          description="Keep context the team should know: what was promised, what matters to them."
        />
      ) : (
        <ul className="divide-y divide-line">
          {notes.map((n) => (
            <NoteItem key={n.id} note={n} canWrite={canWrite} invalidate={invalidate} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function NoteItem({ note, canWrite, invalidate }: { note: Note; canWrite: boolean; invalidate: QueryKey[] }) {
  const ws = useWorkspace();
  const f = useFormat();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(note.body);
  const [confirm, setConfirm] = useState(false);

  const update = useApiMutation<unknown, { body?: string; pinned?: boolean }>({
    method: "PATCH",
    path: ws.path(`/notes/${note.id}`),
    invalidate,
    success: (_, v) => (v.pinned === undefined ? "Note saved" : v.pinned ? "Note pinned" : "Note unpinned"),
    onSuccess: () => setEditing(false),
  });
  const remove = useApiMutation<unknown, void>({
    method: "DELETE",
    path: ws.path(`/notes/${note.id}`),
    invalidate,
    success: "Note deleted",
    errorToast: false,
  });

  const edited = note.updatedAt !== note.createdAt;

  return (
    <li className="px-4 py-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-3">
          {note.author && <span className="font-medium text-text-2">{note.author.name}</span>}
          <time dateTime={note.createdAt} title={f.dateTime(note.createdAt)}>
            {f.relative(note.createdAt)}
          </time>
          {edited && <span title={`Edited ${f.dateTime(note.updatedAt)}`}>· edited</span>}
          {note.pinned && (
            <Badge tone="warn">
              <span className="inline-flex items-center gap-1">
                <Pin aria-hidden className="size-3" /> Pinned
              </span>
            </Badge>
          )}
        </div>
        {canWrite && !editing && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton size="sm" label="Note actions" icon={<Ellipsis />} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem icon={note.pinned ? <PinOff /> : <Pin />} onSelect={() => update.mutate({ pinned: !note.pinned })}>
                {note.pinned ? "Unpin" : "Pin to top"}
              </DropdownMenuItem>
              <DropdownMenuItem
                icon={<Pencil />}
                onSelect={() => {
                  setText(note.body);
                  setEditing(true);
                }}
              >
                Edit
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem danger icon={<Trash2 />} onSelect={() => setConfirm(true)}>
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {editing ? (
        <form
          className="mt-2 flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) update.mutate({ body: text.trim() });
          }}
        >
          <Textarea rows={4} aria-label="Note" autoFocus value={text} maxLength={10000} onChange={(e) => setText(e.target.value)} />
          <div className="flex justify-end gap-2">
            <Button size="sm" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" type="submit" loading={update.isPending} disabled={!text.trim()}>
              Save
            </Button>
          </div>
        </form>
      ) : (
        <p className="mt-1 text-sm break-words whitespace-pre-wrap text-text">{note.body}</p>
      )}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Delete this note?"
        description="The note is removed for everyone. This cannot be undone."
        onConfirm={() => remove.mutateAsync()}
      />
    </li>
  );
}
