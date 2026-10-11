"use client";

import { useId, useState } from "react";
import { Tag, X } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Input } from "@/components/ui/Input";
import { useApiQuery } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import { cn } from "@/lib/cn";
import type { TagRef, TagRow } from "@/lib/types/crm";
import { tagTone } from "@/components/imports/labels";

/** The workspace's tags (GET /tags), for suggestions and the tag filter. */
export function useTags() {
  const ws = useWorkspace();
  return useApiQuery<TagRow[]>(ws.key("tags"), ws.path("/tags"), {
    staleTime: 60_000,
  });
}

/** Tags as quiet chips; past `max`, a "+N" count. */
export function TagList({ tags, max = 3, className }: { tags: TagRef[]; max?: number; className?: string }) {
  if (!tags.length) return <span className="text-text-3">—</span>;
  const shown = tags.slice(0, max);
  const rest = tags.length - shown.length;
  return (
    <span className={cn("inline-flex max-w-full flex-wrap items-center gap-1", className)}>
      {shown.map((t) => (
        <Badge key={t.id} tone={tagTone(t.color)}>
          {t.name}
        </Badge>
      ))}
      {rest > 0 && (
        <span
          className="text-2xs text-text-3"
          title={tags
            .slice(max)
            .map((t) => t.name)
            .join(", ")}
        >
          +{rest}
        </span>
      )}
    </span>
  );
}

/**
 * Edit a list of tag names: chips with a remove mark, and an input that adds
 * on Enter or comma, suggesting the workspace's existing tags. Unknown names
 * are created by the API when the record is saved.
 */
export function TagEditor({
  value,
  onChange,
  disabled,
  placeholder = "Add a tag…",
  className,
}: {
  value: string[];
  onChange: (tags: string[]) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}) {
  const tags = useTags();
  const listId = `tags${useId().replace(/:/g, "")}`;
  const [text, setText] = useState("");

  const add = (raw: string) => {
    const names = raw
      .split(",")
      .map((s) => s.trim().slice(0, 50))
      .filter(Boolean);
    const next = [...value];
    for (const n of names) if (!next.some((v) => v.toLowerCase() === n.toLowerCase())) next.push(n);
    if (next.length !== value.length) onChange(next);
    setText("");
  };

  const suggestions = (tags.data ?? []).filter((t) => !value.includes(t.name));

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {value.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Tags">
          {value.map((t) => (
            <li key={t} className="inline-flex h-6 items-center gap-1 rounded-xs border border-line-strong bg-s-2 pr-1 pl-1.5 text-xs text-text">
              <Tag aria-hidden className="size-3 text-text-3" />
              {t}
              {!disabled && (
                <button
                  type="button"
                  aria-label={`Remove tag ${t}`}
                  onClick={() => onChange(value.filter((v) => v !== t))}
                  className="rounded-xs p-0.5 text-text-3 hover:bg-hover hover:text-text"
                >
                  <X aria-hidden className="size-3" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!disabled && (
        <>
          <Input
            size="sm"
            value={text}
            list={listId}
            placeholder={placeholder}
            onChange={(e) => {
              const v = e.target.value;
              // Picking a suggestion from the datalist fills the whole value at once.
              if (suggestions.some((s) => s.name === v)) add(v);
              else setText(v);
            }}
            onKeyDown={(e) => {
              if ((e.key === "Enter" || e.key === ",") && text.trim()) {
                e.preventDefault();
                add(text);
              } else if (e.key === "Backspace" && !text && value.length) {
                onChange(value.slice(0, -1));
              }
            }}
            onBlur={() => text.trim() && add(text)}
          />
          <datalist id={listId}>
            {suggestions.map((t) => (
              <option key={t.id} value={t.name} />
            ))}
          </datalist>
        </>
      )}
    </div>
  );
}
