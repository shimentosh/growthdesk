import { Heading, Image, Minus, MousePointerClick, Pilcrow, UnfoldVertical, type LucideIcon } from "lucide-react";
import { EMAIL_BLOCK_TYPES, type EmailBlock, type EmailBlockType } from "@growthdesk/shared";
import { IconTile, type Tint } from "@/components/ui/IconTile";

/*
 * What each email block looks like in the editor: one glyph and one tint per
 * type (same idea as ENTITY in components/ui/icons), a one-line description
 * for the "Add block" menu, and a summary for a collapsed block card.
 */

export const BLOCK_META: Record<EmailBlockType, { icon: LucideIcon; tint: Tint; label: string; hint: string }> = {
  heading: { icon: Heading, tint: "indigo", label: "Heading", hint: "A large or small title" },
  text: { icon: Pilcrow, tint: "blue", label: "Text", hint: "Paragraphs with bold, italics and links" },
  button: { icon: MousePointerClick, tint: "green", label: "Button", hint: "A call to action that opens a link" },
  image: { icon: Image, tint: "pink", label: "Image", hint: "A picture from a public URL" },
  divider: { icon: Minus, tint: "gray", label: "Divider", hint: "A thin line between sections" },
  spacer: { icon: UnfoldVertical, tint: "teal", label: "Spacer", hint: "Empty space between blocks" },
};

/** What the "Add block" menu offers, in the shared order. */
export const BLOCK_TYPES = EMAIL_BLOCK_TYPES.map((t) => ({ ...BLOCK_META[t.type], ...t }));

export function BlockTile({ type, size = "sm", className }: { type: EmailBlockType; size?: "sm" | "md"; className?: string }) {
  const { icon: Icon, tint } = BLOCK_META[type];
  return <IconTile icon={<Icon />} tint={tint} size={size} className={className} />;
}

/** A fresh, short block id that is not already used in `taken`. */
export function makeBlockId(taken: Iterable<string> = []): string {
  const used = new Set(taken);
  for (;;) {
    const id =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID().slice(0, 8)
        : Math.random().toString(16).slice(2, 10).padEnd(8, "0");
    if (!used.has(id)) return id;
  }
}

/** Markup and tokens stripped, for a one-line summary. */
const plain = (s: string) =>
  s
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/\{\{\s*([^}|]+?)\s*(?:\|([^}]*))?\}\}/g, (_m, name: string, fallback?: string) => fallback?.trim() || name)
    .replace(/\s+/g, " ")
    .trim();

const host = (url: string) => {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
};

/** What a collapsed block card says about its content. */
export function blockSummary(b: EmailBlock): string {
  switch (b.type) {
    case "heading":
      return plain(b.text) || "Empty heading";
    case "text":
      return plain(b.text) || "Empty text";
    case "button": {
      const url = b.url.trim();
      return `${b.label.trim() || "Untitled button"}${url && url !== "https://" ? ` → ${host(url)}` : ""}`;
    }
    case "image":
      return b.alt.trim() || (b.src.trim() ? host(b.src.trim()) : "No image yet");
    case "divider":
      return "A thin line";
    case "spacer":
      return `${b.height} px of space`;
  }
}
