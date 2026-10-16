"use client";

import { useRef, useState, type DragEvent } from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import {
  Download,
  Ellipsis,
  File as FileIcon,
  FileArchive,
  FileAudio,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileType2,
  FileVideo,
  Paperclip,
  Pencil,
  Presentation,
  Trash2,
  Upload,
  X,
  type LucideIcon,
} from "lucide-react";
import { ATTACHMENT_MAX_BYTES, attachmentKind, isBlockedFileName, type AttachmentKind } from "@growthdesk/shared";
import { Button, IconButton } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { ConfirmDialog, Modal } from "@/components/ui/Dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/DropdownMenu";
import { ErrorState } from "@/components/ui/ErrorState";
import { Field, FormError } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { SkeletonText } from "@/components/ui/Skeleton";
import { toast } from "@/components/ui/Toast";
import { ApiError, messageOf } from "@/lib/api";
import { cn } from "@/lib/cn";
import { formatBytes } from "@/lib/format";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";

/*
 * Files on a contact, company, deal or quote (/attachments; rules in
 * packages/shared/src/attachments.ts). Drop files on the card or use Upload;
 * each is read as base64 and sent with a progress bar (XMLHttpRequest — fetch
 * cannot report upload progress). Downloads go through the /api proxy and are
 * saved from a blob, so they carry the session like every other call.
 */

type EntityType = "contact" | "company" | "deal" | "quote";
type Attachment = { id: string; fileName: string; contentType: string; size: number; uploadedBy: { id: string; name: string } | null; createdAt: string };
type AttachmentList = { items: Attachment[]; limits: { fileBytes: number; workspaceBytes: number; usedBytes: number } };
type Pending = { key: string; name: string; progress: number; error: string | null };

const PERMS: Record<EntityType, { read: string; write: string; record: string }> = {
  contact: { read: "contacts.read", write: "contacts.write", record: "contacts" },
  company: { read: "contacts.read", write: "contacts.write", record: "companies" },
  deal: { read: "deals.read", write: "deals.write", record: "deals" },
  quote: { read: "quotes.read", write: "quotes.write", record: "quotes" },
};

const ICONS: Record<AttachmentKind, LucideIcon> = {
  image: FileImage,
  pdf: FileType2,
  document: FileText,
  spreadsheet: FileSpreadsheet,
  presentation: Presentation,
  archive: FileArchive,
  audio: FileAudio,
  video: FileVideo,
  text: FileText,
  other: FileIcon,
};

const readBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => reject(r.error ?? new Error("The file could not be read"));
    r.readAsDataURL(file);
  });

/** POST JSON with upload progress; resolves the envelope's data or rejects with an ApiError, like lib/api. */
function postWithProgress<T>(path: string, body: unknown, onProgress: (ratio: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api${path}`);
    xhr.setRequestHeader("content-type", "application/json");
    xhr.setRequestHeader("accept", "application/json");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let payload: { data?: T; error?: { code?: string; message?: string; fields?: Record<string, string> } } | null = null;
      try {
        payload = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        payload = null;
      }
      if (xhr.status >= 200 && xhr.status < 300 && !payload?.error) resolve(payload?.data as T);
      else reject(new ApiError(xhr.status, payload?.error?.code ?? "server_error", payload?.error?.message ?? (xhr.status === 413 ? "The file is too large" : `The server answered ${xhr.status}`), payload?.error?.fields ?? {}));
    };
    xhr.onerror = () => reject(new ApiError(0, "offline", "Could not reach the server. Check your connection and try again."));
    xhr.send(JSON.stringify(body));
  });
}

export function AttachmentsPanel({ entityType, entityId }: { entityType: EntityType; entityId: string }) {
  const ws = useWorkspace();
  const f = useFormat();
  const qc = useQueryClient();
  const perms = PERMS[entityType];
  const canRead = ws.can(perms.read);
  const canWrite = ws.can(perms.write);
  const key = ws.key("attachments", entityType, entityId);
  const files = useApiQuery<AttachmentList>(key, canRead ? ws.path("/attachments") : null, { query: { entityType, entityId } });
  const invalidate = [key, ws.key(perms.record)];
  const input = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  const [dragging, setDragging] = useState(false);
  const [renaming, setRenaming] = useState<Attachment | null>(null);
  const [deleting, setDeleting] = useState<Attachment | null>(null);

  const remove = useApiMutation<{ deleted: true }, string>({ method: "DELETE", path: (id) => ws.path(`/attachments/${id}`), invalidate, success: "File deleted", errorToast: false });
  const update = (key: string, patch: Partial<Pending>) => setPending((p) => p.map((x) => (x.key === key ? { ...x, ...patch } : x)));

  const upload = async (list: FileList | File[]) => {
    const chosen = [...list];
    if (!chosen.length) return;
    const items = chosen.map((file, i) => ({ file, key: `${Date.now()}-${i}-${file.name}` }));
    setPending((p) => [...p, ...items.map(({ file, key }) => ({ key, name: file.name, progress: 0, error: null }))]);
    let added = 0;
    // One at a time: the API takes a workspace lock per upload anyway, and the bars read in order.
    for (const { file, key: k } of items) {
      if (isBlockedFileName(file.name)) {
        update(k, { error: "Programs and scripts can't be attached" });
        continue;
      }
      if (file.size > ATTACHMENT_MAX_BYTES) {
        update(k, { error: `Larger than ${formatBytes(ATTACHMENT_MAX_BYTES)}` });
        continue;
      }
      if (!file.size) {
        update(k, { error: "The file is empty" });
        continue;
      }
      try {
        const data = await readBase64(file);
        await postWithProgress(ws.path("/attachments"), { entityType, entityId, fileName: file.name, contentType: file.type || undefined, data }, (r) => update(k, { progress: r }));
        added++;
        setPending((p) => p.filter((x) => x.key !== k));
      } catch (e) {
        update(k, { error: messageOf(e) });
      }
    }
    if (added) {
      // The list, and the record (its timeline shows "File added").
      await Promise.all(invalidate.map((queryKey) => qc.invalidateQueries({ queryKey })));
      toast.success(added === 1 ? "File added" : `${added} files added`);
    }
  };

  const download = async (a: Attachment) => {
    try {
      const res = await fetch(`/api${ws.path(`/attachments/${a.id}/download`)}`, { credentials: "same-origin", cache: "no-store" });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? `The server answered ${res.status}`);
      }
      const url = URL.createObjectURL(await res.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = a.fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      toast.error(`Could not download ${a.fileName}: ${messageOf(e)}`);
    }
  };

  if (!canRead) return null;
  const onDrag = (e: DragEvent, over: boolean) => {
    if (!canWrite || !e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    setDragging(over);
  };
  const items = files.data?.items ?? [];

  return (
    <Card
      onDragOver={(e) => onDrag(e, true)}
      onDragEnter={(e) => onDrag(e, true)}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(e) => {
        if (!canWrite) return;
        e.preventDefault();
        setDragging(false);
        void upload(e.dataTransfer.files);
      }}
      className={cn("relative", dragging && "ring-2 ring-accent")}
    >
      <CardHeader
        icon={<Paperclip />}
        title="Files"
        description={canWrite ? `Drop files here or upload — up to ${formatBytes(files.data?.limits.fileBytes ?? ATTACHMENT_MAX_BYTES)} each.` : undefined}
        actions={
          canWrite ? (
            <>
              <Button size="sm" icon={<Upload />} onClick={() => input.current?.click()}>
                Upload
              </Button>
              <input
                ref={input}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  if (e.target.files) void upload(e.target.files);
                  e.target.value = "";
                }}
              />
            </>
          ) : undefined
        }
      />
      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-panel/90 text-sm font-medium text-accent-hi">
          <Upload className="mr-2 size-4" aria-hidden /> Drop to attach
        </div>
      )}

      {pending.length > 0 && (
        <ul className="flex flex-col gap-2 border-b border-line px-4 py-3">
          {pending.map((p) => (
            <li key={p.key} className="flex flex-col gap-1">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="min-w-0 truncate text-text">{p.name}</span>
                {p.error ? (
                  <span className="flex shrink-0 items-center gap-1 text-bad-ink">
                    {p.error}
                    <IconButton size="sm" label="Dismiss" icon={<X />} onClick={() => setPending((x) => x.filter((y) => y.key !== p.key))} />
                  </span>
                ) : (
                  <span className="shrink-0 text-text-3 tabular-nums">{p.progress ? `${Math.round(p.progress * 100)}%` : "Reading…"}</span>
                )}
              </div>
              {!p.error && (
                <div role="progressbar" aria-label={`Uploading ${p.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(p.progress * 100)} className="h-1 w-full overflow-hidden rounded-full bg-s-4">
                  <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${Math.max(3, p.progress * 100)}%` }} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {files.isPending ? (
        <div className="p-4">
          <SkeletonText lines={2} />
        </div>
      ) : files.isError ? (
        <ErrorState compact error={files.error} onRetry={() => void files.refetch()} />
      ) : items.length === 0 ? (
        <p className="px-4 py-6 text-center text-xs text-text-3">{canWrite ? "No files yet. Drop proposals, contracts or notes here." : "No files."}</p>
      ) : (
        <ul className="divide-y divide-line">
          {items.map((a) => {
            const Icon = ICONS[attachmentKind(a.contentType, a.fileName)];
            return (
              <li key={a.id} className="flex items-center gap-3 px-4 py-2.5 hover:bg-hover">
                <Icon className="size-5 shrink-0 text-text-3" aria-hidden />
                <div className="min-w-0 flex-1">
                  <button type="button" onClick={() => void download(a)} className="block max-w-full truncate text-left text-sm text-text-hi hover:text-accent-hi hover:underline" title={`Download ${a.fileName}`}>
                    {a.fileName}
                  </button>
                  <div className="truncate text-xs text-text-3">{[formatBytes(a.size), a.uploadedBy?.name, f.smart(a.createdAt)].filter(Boolean).join(" · ")}</div>
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <IconButton size="sm" label={`Actions for ${a.fileName}`} icon={<Ellipsis />} />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem icon={<Download />} onSelect={() => void download(a)}>
                      Download
                    </DropdownMenuItem>
                    {canWrite && (
                      <>
                        <DropdownMenuItem icon={<Pencil />} onSelect={() => setRenaming(a)}>
                          Rename
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem danger icon={<Trash2 />} onSelect={() => setDeleting(a)}>
                          Delete
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
            );
          })}
        </ul>
      )}

      {renaming && <RenameModal file={renaming} invalidate={invalidate} onClose={() => setRenaming(null)} />}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete ${deleting?.fileName ?? "this file"}?`}
        description="It disappears from this record for everyone. The removal is noted on the timeline."
        onConfirm={() => deleting && remove.mutateAsync(deleting.id)}
      />
    </Card>
  );
}

function RenameModal({ file, invalidate, onClose }: { file: Attachment; invalidate: QueryKey[]; onClose: () => void }) {
  const ws = useWorkspace();
  const [name, setName] = useState(file.fileName);
  const rename = useApiMutation<Attachment, string>({
    method: "PATCH",
    path: ws.path(`/attachments/${file.id}`),
    body: (fileName) => ({ fileName }),
    invalidate,
    success: "File renamed",
    errorToast: false,
    onSuccess: onClose,
  });
  const clean = name.trim();
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Rename file"
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={rename.isPending} disabled={!clean || clean === file.fileName} onClick={() => rename.mutate(clean)}>
            Rename
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (clean && clean !== file.fileName) rename.mutate(clean);
        }}
        className="grid gap-3"
      >
        {rename.error && <FormError error={rename.error.message} />}
        <Field label="Name">
          <Input value={name} maxLength={200} autoFocus onChange={(e) => setName(e.target.value)} />
        </Field>
      </form>
    </Modal>
  );
}
