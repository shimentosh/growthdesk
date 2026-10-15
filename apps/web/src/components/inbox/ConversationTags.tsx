"use client";

import { useState } from "react";
import { Check, Plus, Tag as TagIcon, X } from "lucide-react";
import { useTags } from "@/components/crm/Tags";
import { tagTone } from "@/components/imports/labels";
import { Badge } from "@/components/ui/Badge";
import { Input } from "@/components/ui/Input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/Popover";
import { cn } from "@/lib/cn";
import { useApiMutation } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import type { TagRow } from "@/lib/types/crm-settings";
import type { ConversationRow, TagRef } from "@/lib/types/inbox";

/**
 * The conversation's tags, under the header: chips (removable), and a picker
 * over the workspace's shared tag list (Settings → Tags). Typing a name that
 * does not exist offers to create it, for a role that may create tags.
 */
export function ConversationTags({ conversationId, tags, canEdit }: { conversationId: string; tags: TagRef[]; canEdit: boolean }) {
  const ws = useWorkspace();
  const all = useTags();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const canCreate = ws.can("contacts.write");

  const save = useApiMutation<ConversationRow, { tagIds: string[] }>({
    method: "PUT",
    path: ws.path(`/inbox/conversations/${conversationId}/tags`),
    invalidate: [ws.key("inbox")],
  });
  const create = useApiMutation<TagRow, { name: string; color: string }>({
    path: ws.path("/tags"),
    invalidate: [ws.key("tags")],
    onSuccess: (tag) => {
      setText("");
      save.mutate({ tagIds: [...tags.map((t) => t.id), tag.id] });
    },
  });

  const ids = new Set(tags.map((t) => t.id));
  const toggle = (id: string) => save.mutate({ tagIds: ids.has(id) ? [...ids].filter((x) => x !== id) : [...ids, id] });

  const term = text.trim().toLowerCase();
  const options = (all.data ?? []).filter((t) => !term || t.name.toLowerCase().includes(term));
  const exact = (all.data ?? []).some((t) => t.name.toLowerCase() === term);

  if (!tags.length && !canEdit) return null;

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-line px-3 py-1.5">
      <TagIcon aria-hidden className="size-3.5 text-text-3" />
      {tags.map((t) => (
        <Badge key={t.id} tone={tagTone(t.color)} className="gap-1 pr-1">
          {t.name}
          {canEdit && (
            <button
              type="button"
              aria-label={`Remove tag ${t.name}`}
              disabled={save.isPending}
              onClick={() => toggle(t.id)}
              className="rounded-xs p-0.5 opacity-70 hover:opacity-100"
            >
              <X aria-hidden className="size-3" />
            </button>
          )}
        </Badge>
      ))}
      {canEdit && (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="inline-flex h-5 items-center gap-1 rounded-xs border border-dashed border-line-strong px-1.5 text-2xs text-text-3 hover:bg-hover hover:text-text"
            >
              <Plus aria-hidden className="size-3" />
              {tags.length ? "Tag" : "Add tag"}
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-60 p-2">
            <Input
              size="sm"
              autoFocus
              value={text}
              placeholder="Find or create a tag…"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                const hit = options[0];
                if (hit && (exact || !canCreate)) toggle(hit.id);
                else if (term && canCreate && !exact) create.mutate({ name: text.trim().slice(0, 50), color: "gray" });
              }}
            />
            <ul className="mt-1.5 max-h-56 overflow-y-auto" aria-label="Tags">
              {options.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => toggle(t.id)}
                    disabled={save.isPending}
                    className="flex w-full items-center gap-2 rounded-xs px-1.5 py-1 text-left text-sm hover:bg-hover"
                  >
                    <span className={cn("flex size-4 items-center justify-center", !ids.has(t.id) && "invisible")}>
                      <Check aria-hidden className="size-3.5" />
                    </span>
                    <Badge tone={tagTone(t.color)}>{t.name}</Badge>
                  </button>
                </li>
              ))}
              {term && canCreate && !exact && (
                <li>
                  <button
                    type="button"
                    disabled={create.isPending}
                    onClick={() => create.mutate({ name: text.trim().slice(0, 50), color: "gray" })}
                    className="flex w-full items-center gap-2 rounded-xs px-1.5 py-1 text-left text-sm text-text-2 hover:bg-hover"
                  >
                    <Plus aria-hidden className="size-3.5" />
                    Create “{text.trim()}”
                  </button>
                </li>
              )}
              {!options.length && !(term && canCreate) && <li className="px-1.5 py-2 text-xs text-text-3">No tags yet. Add them under Settings → Tags.</li>}
            </ul>
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}
