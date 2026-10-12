import { Columns3, Heading, Image, List, Megaphone, Minus, MousePointerClick, PanelTop, Pilcrow, Quote, Share2, Sparkles, UnfoldVertical, type LucideIcon } from "lucide-react";
import { ALL_EMAIL_BLOCK_TYPES, type EmailBlock, type EmailBlockType, type SocialNetwork } from "@growthdesk/shared";
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
  header: { icon: PanelTop, tint: "brown", label: "Header", hint: "Your logo or brand name across the top" },
  hero: { icon: Sparkles, tint: "orange", label: "Hero", hint: "A coloured band with a big title and a button" },
  columns: { icon: Columns3, tint: "cyan", label: "Columns", hint: "Two or three items side by side" },
  quote: { icon: Quote, tint: "purple", label: "Quote", hint: "A testimonial with who said it" },
  callout: { icon: Megaphone, tint: "yellow", label: "Callout", hint: "A tinted box for an offer, code or deadline" },
  list: { icon: List, tint: "mint", label: "List", hint: "Bulleted or numbered points" },
  social: { icon: Share2, tint: "red", label: "Social links", hint: "Links to your website and social profiles" },
};

/** What the "Add block" menu offers, in the shared order. */
export const BLOCK_TYPES = ALL_EMAIL_BLOCK_TYPES.map((t) => ({ ...BLOCK_META[t.type], ...t }));

/**
 * The block a send blocker (shared `designProblems`) is about, as an index:
 * "Button 3 needs…", "The hero's button (block 2)…", "Column 1 in block 4…".
 */
export function problemBlockIndex(problem: string): number | null {
  const hit = /^(?:Button|Image) (\d+) /.exec(problem) ?? /\(block (\d+)\)/.exec(problem) ?? /in block (\d+)/.exec(problem);
  return hit ? Number(hit[1]) - 1 : null;
}

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

/** Social networks in words, for summaries and the network picker. */
export const SOCIAL_LABEL: Record<SocialNetwork, string> = {
  website: "Website",
  linkedin: "LinkedIn",
  x: "X",
  facebook: "Facebook",
  instagram: "Instagram",
  youtube: "YouTube",
  tiktok: "TikTok",
  github: "GitHub",
};

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
    case "header":
      return plain(b.brand) || (b.logo.trim() ? host(b.logo.trim()) : "No logo or brand yet");
    case "hero":
      return plain(b.title) || plain(b.text) || "Empty hero";
    case "columns":
      return b.items.map((i) => plain(i.title) || "Untitled").join(" · ");
    case "quote":
      return plain(b.text) ? `“${plain(b.text)}”${b.author.trim() ? ` — ${b.author.trim()}` : ""}` : "Empty quote";
    case "callout":
      return plain(b.title) || plain(b.text) || "Empty callout";
    case "list": {
      const items = b.items.filter((i) => i.trim());
      return items.length ? `${items.length} item${items.length === 1 ? "" : "s"}: ${items.map(plain).join(" · ")}` : "Empty list";
    }
    case "social":
      return b.links.length ? b.links.map((l) => SOCIAL_LABEL[l.network]).join(" · ") : "No links yet";
  }
}
