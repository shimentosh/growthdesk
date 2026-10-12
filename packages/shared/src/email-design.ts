import { z } from "zod";
import { renderTemplate, tokensIn, type Variables } from "./personalize.js";

/*
 * Marketing email designs: a list of blocks, rendered to email-safe HTML
 * (tables, inline styles, 600px column) plus a plain-text part. Pure, so the
 * API sends exactly what the designer previews in the browser.
 *
 * Text blocks take a small, safe markup — **bold**, *italic*, [label](url)
 * and line breaks — never raw HTML: everything a person types is escaped.
 * Personalisation tokens ({{first_name|there}}) work in every text field and
 * URL. Unlike outreach templates, an unresolved token renders as its fallback
 * or as nothing: a newsletter must never show "{{first_name}}".
 *
 * A design also has a theme (colours, font, corner radius). An empty theme
 * renders exactly as designs did before themes existed.
 */

const httpUrl = z
  .string()
  .trim()
  .max(2000)
  .refine((u) => u === "" || /^https?:\/\//i.test(u) || /^\{\{.+\}\}$/.test(u) || /^mailto:/i.test(u), "Use a full link starting with https://");
const align = z.enum(["left", "center", "right"]).default("left");
const hex = z.string().regex(/^#[0-9a-f]{6}$/i, "Use a hex colour like #0071e3");
const blockId = z.string().min(1).max(40);

export const SOCIAL_NETWORKS = ["website", "linkedin", "x", "facebook", "instagram", "youtube", "tiktok", "github"] as const;
export type SocialNetwork = (typeof SOCIAL_NETWORKS)[number];
const SOCIAL_LABELS: Record<SocialNetwork, string> = {
  website: "Website",
  linkedin: "LinkedIn",
  x: "X",
  facebook: "Facebook",
  instagram: "Instagram",
  youtube: "YouTube",
  tiktok: "TikTok",
  github: "GitHub",
};

const ColumnItem = z.object({
  image: httpUrl.default(""),
  title: z.string().max(200).default(""),
  text: z.string().max(2000).default(""),
  linkLabel: z.string().max(80).default(""),
  linkUrl: httpUrl.default(""),
});
export type EmailColumnItem = z.infer<typeof ColumnItem>;

export const EmailBlock = z.discriminatedUnion("type", [
  z.object({ type: z.literal("heading"), id: blockId, text: z.string().max(300).default(""), level: z.union([z.literal(1), z.literal(2)]).default(1), align }),
  z.object({ type: z.literal("text"), id: blockId, text: z.string().max(10_000).default(""), align }),
  z.object({ type: z.literal("button"), id: blockId, label: z.string().max(80).default("Learn more"), url: httpUrl.default(""), align: align.default("center"), color: hex.optional() }),
  z.object({ type: z.literal("image"), id: blockId, src: httpUrl.default(""), alt: z.string().max(300).default(""), href: httpUrl.optional(), width: z.number().int().min(10).max(100).default(100) }),
  z.object({ type: z.literal("divider"), id: blockId }),
  z.object({ type: z.literal("spacer"), id: blockId, height: z.number().int().min(4).max(120).default(24) }),
  /** The top bar: a logo image, or the brand name as a wordmark, with optional small links. */
  z.object({
    type: z.literal("header"),
    id: blockId,
    logo: httpUrl.default(""),
    brand: z.string().max(80).default(""),
    tagline: z.string().max(120).default(""),
    align: align.default("left"),
    background: hex.optional(),
    color: hex.optional(),
  }),
  /** A coloured band with an eyebrow, a big title, a line of text, an optional image and a button. */
  z.object({
    type: z.literal("hero"),
    id: blockId,
    eyebrow: z.string().max(80).default(""),
    title: z.string().max(200).default(""),
    text: z.string().max(2000).default(""),
    image: httpUrl.default(""),
    buttonLabel: z.string().max(80).default(""),
    buttonUrl: httpUrl.default(""),
    align: align.default("center"),
    background: hex.optional(),
    color: hex.optional(),
  }),
  /** Two or three side-by-side items (features, products, articles); they stack on phones. */
  z.object({ type: z.literal("columns"), id: blockId, items: z.array(ColumnItem).min(2).max(3), align: align.default("left") }),
  z.object({ type: z.literal("quote"), id: blockId, text: z.string().max(1000).default(""), author: z.string().max(120).default(""), role: z.string().max(160).default("") }),
  /** A tinted box that stands out: an offer, a code, a deadline. */
  z.object({ type: z.literal("callout"), id: blockId, title: z.string().max(200).default(""), text: z.string().max(2000).default(""), background: hex.optional(), align: align.default("center") }),
  z.object({ type: z.literal("list"), id: blockId, items: z.array(z.string().max(500)).min(1).max(12), ordered: z.boolean().default(false) }),
  z.object({
    type: z.literal("social"),
    id: blockId,
    links: z.array(z.object({ network: z.enum(SOCIAL_NETWORKS), url: httpUrl })).max(8).default([]),
    align: align.default("center"),
  }),
]);
export type EmailBlock = z.infer<typeof EmailBlock>;
export type EmailBlockType = EmailBlock["type"];
export const EmailBlocks = z.array(EmailBlock).max(100);

/** The original six blocks (the platform admin editor offers only these). */
export const EMAIL_BLOCK_TYPES: { type: "heading" | "text" | "button" | "image" | "divider" | "spacer"; label: string }[] = [
  { type: "heading", label: "Heading" },
  { type: "text", label: "Text" },
  { type: "button", label: "Button" },
  { type: "image", label: "Image" },
  { type: "divider", label: "Divider" },
  { type: "spacer", label: "Spacer" },
];

/** Every block a workspace designer can add. */
export const ALL_EMAIL_BLOCK_TYPES: { type: EmailBlockType; label: string }[] = [
  { type: "header", label: "Header" },
  { type: "hero", label: "Hero" },
  ...EMAIL_BLOCK_TYPES,
  { type: "columns", label: "Columns" },
  { type: "quote", label: "Quote" },
  { type: "callout", label: "Callout" },
  { type: "list", label: "List" },
  { type: "social", label: "Social links" },
];

/** A new block of `type` with sensible starting content. */
export function newBlock(type: EmailBlockType, id: string): EmailBlock {
  switch (type) {
    case "heading":
      return { type, id, text: "A headline for your email", level: 1, align: "left" };
    case "text":
      return { type, id, text: "Hi {{first_name|there}},\n\nWrite your message here. Use **bold**, *italic* and [links](https://example.com).", align: "left" };
    case "button":
      return { type, id, label: "Learn more", url: "https://", align: "center" };
    case "image":
      return { type, id, src: "", alt: "", width: 100 };
    case "divider":
      return { type, id };
    case "spacer":
      return { type, id, height: 24 };
    case "header":
      return { type, id, logo: "", brand: "Your brand", tagline: "", align: "left" };
    case "hero":
      return { type, id, eyebrow: "New", title: "A big idea, said simply", text: "One or two lines on why it matters to the reader.", image: "", buttonLabel: "Find out more", buttonUrl: "https://", align: "center" };
    case "columns":
      return {
        type,
        id,
        align: "left",
        items: [
          { image: "", title: "First point", text: "A short line about it.", linkLabel: "", linkUrl: "" },
          { image: "", title: "Second point", text: "A short line about it.", linkLabel: "", linkUrl: "" },
        ],
      };
    case "quote":
      return { type, id, text: "This changed how our team works.", author: "Customer name", role: "Role, Company" };
    case "callout":
      return { type, id, title: "Limited time", text: "Use code **WELCOME20** before Friday.", align: "center" };
    case "list":
      return { type, id, items: ["First thing", "Second thing", "Third thing"], ordered: false };
    case "social":
      return { type, id, links: [{ network: "website", url: "https://" }, { network: "linkedin", url: "https://" }], align: "center" };
  }
}

/** A starting design for a new email. */
export function starterBlocks(makeId: () => string): EmailBlock[] {
  return [newBlock("heading", makeId()), newBlock("text", makeId()), newBlock("button", makeId())];
}

// ─── Theme ───────────────────────────────────────────────────────────────────

export const EMAIL_FONTS = {
  system: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif",
  helvetica: "'Helvetica Neue',Helvetica,Arial,sans-serif",
  georgia: "Georgia,'Times New Roman',Times,serif",
  verdana: "Verdana,Geneva,Tahoma,sans-serif",
  trebuchet: "'Trebuchet MS','Lucida Grande',Tahoma,sans-serif",
  mono: "'SFMono-Regular',Menlo,Consolas,'Courier New',monospace",
} as const;
export type EmailFont = keyof typeof EMAIL_FONTS;

export const EmailTheme = z.object({
  /** Behind the email. */
  background: hex.optional(),
  /** The email's own card. */
  surface: hex.optional(),
  text: hex.optional(),
  heading: hex.optional(),
  muted: hex.optional(),
  /** Buttons and links. */
  accent: hex.optional(),
  /** Text on the accent colour. */
  accentText: hex.optional(),
  /** Hero, callout and header bands, unless a block sets its own. */
  tint: hex.optional(),
  font: z.enum(Object.keys(EMAIL_FONTS) as [EmailFont, ...EmailFont[]]).optional(),
  headingFont: z.enum(Object.keys(EMAIL_FONTS) as [EmailFont, ...EmailFont[]]).optional(),
  /** Card corner radius. */
  radius: z.number().int().min(0).max(32).optional(),
  buttonRadius: z.number().int().min(0).max(40).optional(),
});
export type EmailTheme = z.infer<typeof EmailTheme>;

type ResolvedTheme = Required<EmailTheme>;

export const DEFAULT_EMAIL_THEME: ResolvedTheme = {
  background: "#f5f5f7",
  surface: "#ffffff",
  text: "#1d1d1f",
  heading: "#1d1d1f",
  muted: "#6e6e73",
  accent: "#0071e3",
  accentText: "#ffffff",
  tint: "#f5f5f7",
  font: "system",
  headingFont: "system",
  radius: 16,
  buttonRadius: 10,
};

/** A stored theme (any JSON) → a complete theme; unknown or invalid values fall back to the defaults. */
export function resolveTheme(raw: unknown, accent?: string): ResolvedTheme {
  const parsed = EmailTheme.safeParse(raw ?? {});
  const t = parsed.success ? parsed.data : {};
  const out = { ...DEFAULT_EMAIL_THEME };
  for (const [k, v] of Object.entries(t)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  if (accent && !t.accent) out.accent = accent;
  return out;
}

// ─── Rendering ───────────────────────────────────────────────────────────────

export type EmailFooter = {
  /** "Acme Growth Ltd" — required for marketing sends (CAN-SPAM). */
  legalName: string;
  /** Multi-line postal address. */
  postalAddress: string;
  /** The preference / unsubscribe page for this recipient. */
  preferencesUrl: string;
  /**
   * marketing (default): legal name, address and the unsubscribe link.
   * transactional: system mail (verification, receipts…) — the legal name and
   * `supportEmail`, never an unsubscribe link; `preferencesUrl` is ignored.
   */
  mode?: "marketing" | "transactional";
  /** Transactional mode: shown as "Questions? Contact …". */
  supportEmail?: string;
};

export type RenderOptions = {
  preheader?: string;
  footer: EmailFooter;
  vars?: Variables;
  /** Default button colour (the theme's accent wins when it sets one). */
  accent?: string;
  theme?: EmailTheme | null;
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Fills tokens; anything unresolved becomes its fallback or empty. */
export function fill(text: string, vars: Variables = {}): string {
  return tokensIn(text).length ? renderTemplate(text, vars).replace(/\{\{[^}]*\}\}/g, "") : text;
}

/** A URL safe to put in href/src after personalisation, or "" when it is not http(s)/mailto. */
function safeUrl(raw: string, vars: Variables): string {
  const url = fill(raw, vars).trim();
  return /^(https?:\/\/|mailto:)/i.test(url) ? url : "";
}

/** The inline markup of a text block → HTML. Input is escaped first, so only these constructs produce tags. */
function inline(text: string, vars: Variables, link = "#0071e3"): string {
  let out = esc(fill(text, vars));
  out = out.replace(/\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^)\s]+)\)/gi, (_m, label: string, url: string) => `<a href="${url}" style="color:${link};text-decoration:underline">${label}</a>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  return out.replace(/\n/g, "<br>");
}

/** The inline markup of a text block → plain text ("label (url)"). */
function inlineText(text: string, vars: Variables): string {
  return fill(text, vars)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1 ($2)")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1$2");
}

/** `a` blended into `b` (weight 0..1 of `a`). Email clients such as Outlook ignore 8-digit hex, so tints are mixed here. */
function mix(a: string, b: string, weight: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (shift: number) => Math.round(((pa >> shift) & 255) * weight + ((pb >> shift) & 255) * (1 - weight));
  return `#${[16, 8, 0].map((sh) => ch(sh).toString(16).padStart(2, "0")).join("")}`;
}

/** A hairline colour on the card; the original grey when the theme leaves those colours alone. */
function lineColor(t: ResolvedTheme): string {
  return t.muted === DEFAULT_EMAIL_THEME.muted && t.surface === DEFAULT_EMAIL_THEME.surface ? "#e5e5ea" : mix(t.muted, t.surface, 0.25);
}

/** Black or white, whichever reads better on `bg`. */
function contrastOn(bg: string): string {
  const n = parseInt(bg.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? "#1d1d1f" : "#ffffff";
}

function blockHtml(b: EmailBlock, vars: Variables, t: ResolvedTheme, link: string): string {
  const font = EMAIL_FONTS[t.font];
  const headFont = EMAIL_FONTS[t.headingFont];
  const cell = (inner: string, pad = "8px 32px", alignment = "left", bg?: string) =>
    `<tr><td style="padding:${pad};text-align:${alignment}${bg ? `;background:${bg}` : ""}">${inner}</td></tr>`;
  const button = (label: string, rawUrl: string, color = t.accent, textColor = color === t.accent ? t.accentText : contrastOn(color)) => {
    const url = safeUrl(rawUrl, vars);
    if (!url || !label.trim()) return "";
    return `<a href="${esc(url)}" style="display:inline-block;background:${color};color:${textColor};font-family:${font};font-size:16px;font-weight:600;line-height:1;text-decoration:none;padding:14px 24px;border-radius:${t.buttonRadius}px">${esc(fill(label, vars))}</a>`;
  };
  const para = (text: string, color = t.text, size = 16) => `<p style="margin:0;font-family:${font};font-size:${size}px;line-height:1.6;color:${color}">${inline(text, vars, color === t.text ? link : color)}</p>`;
  switch (b.type) {
    case "heading": {
      const size = b.level === 1 ? 28 : 21;
      return cell(`<h${b.level} style="margin:0;font-family:${headFont};font-size:${size}px;line-height:1.25;font-weight:700;color:${t.heading}">${esc(fill(b.text, vars))}</h${b.level}>`, "16px 32px 8px", b.align);
    }
    case "text":
      return cell(para(b.text), "8px 32px", b.align);
    case "button": {
      const html = button(b.label, b.url, b.color ?? t.accent);
      return html ? cell(html, "16px 32px", b.align) : "";
    }
    case "image": {
      const src = safeUrl(b.src, vars);
      if (!src) return "";
      const width = Math.round((536 * b.width) / 100);
      const img = `<img src="${esc(src)}" alt="${esc(fill(b.alt, vars))}" width="${width}" style="display:block;margin:0 auto;width:100%;max-width:${width}px;height:auto;border:0;border-radius:8px">`;
      const href = b.href ? safeUrl(b.href, vars) : "";
      return cell(href ? `<a href="${esc(href)}">${img}</a>` : img, "12px 32px", "center");
    }
    case "divider":
      return cell(`<div style="border-top:1px solid ${lineColor(t)};height:1px;line-height:1px;font-size:1px">&nbsp;</div>`, "16px 32px");
    case "spacer":
      return `<tr><td style="height:${b.height}px;line-height:${b.height}px;font-size:1px">&nbsp;</td></tr>`;
    case "header": {
      const bg = b.background ?? t.surface;
      const color = b.color ?? (b.background ? contrastOn(b.background) : t.heading);
      const logo = safeUrl(b.logo, vars);
      const mark = logo
        ? `<img src="${esc(logo)}" alt="${esc(fill(b.brand, vars))}" height="32" style="display:inline-block;height:32px;width:auto;border:0">`
        : `<span style="font-family:${headFont};font-size:20px;font-weight:800;letter-spacing:-0.3px;color:${color}">${esc(fill(b.brand, vars))}</span>`;
      const tagline = b.tagline ? `<div style="margin-top:4px;font-family:${font};font-size:12px;letter-spacing:0.4px;text-transform:uppercase;color:${color};opacity:0.7">${esc(fill(b.tagline, vars))}</div>` : "";
      return cell(mark + tagline, "20px 32px", b.align, bg);
    }
    case "hero": {
      const bg = b.background ?? t.tint;
      const color = b.color ?? contrastOn(bg);
      const img = safeUrl(b.image, vars);
      const parts = [
        b.eyebrow ? `<div style="font-family:${font};font-size:12px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:${color};opacity:0.75;margin-bottom:12px">${esc(fill(b.eyebrow, vars))}</div>` : "",
        b.title ? `<h1 style="margin:0;font-family:${headFont};font-size:34px;line-height:1.15;font-weight:800;letter-spacing:-0.5px;color:${color}">${esc(fill(b.title, vars))}</h1>` : "",
        b.text ? `<div style="margin-top:14px">${para(b.text, color, 17)}</div>` : "",
        img ? `<img src="${esc(img)}" alt="" width="536" style="display:block;margin:24px auto 0;width:100%;max-width:536px;height:auto;border:0;border-radius:${Math.min(t.radius, 12)}px">` : "",
      ];
      const btnColor = bg === t.accent ? color : t.accent;
      const btn = button(b.buttonLabel, b.buttonUrl, btnColor, btnColor === t.accent ? t.accentText : bg);
      if (btn) parts.push(`<div style="margin-top:24px">${btn}</div>`);
      return cell(parts.join(""), "44px 32px", b.align, bg);
    }
    case "columns": {
      const n = b.items.length;
      const w = Math.floor(536 / n);
      const cols = b.items
        .map((it) => {
          const img = safeUrl(it.image, vars);
          const link = safeUrl(it.linkUrl, vars);
          const inner = [
            img ? `<img src="${esc(img)}" alt="${esc(fill(it.title, vars))}" width="${w - 16}" style="display:block;width:100%;max-width:${w - 16}px;height:auto;border:0;border-radius:8px;margin-bottom:12px">` : "",
            it.title ? `<div style="font-family:${headFont};font-size:17px;font-weight:700;line-height:1.3;color:${t.heading};margin-bottom:6px">${esc(fill(it.title, vars))}</div>` : "",
            it.text ? para(it.text, t.text, 14) : "",
            link && it.linkLabel ? `<div style="margin-top:8px"><a href="${esc(link)}" style="font-family:${font};font-size:14px;font-weight:600;color:${t.accent};text-decoration:none">${esc(fill(it.linkLabel, vars))} &rarr;</a></div>` : "",
          ].join("");
          return `<td class="gd-col" width="${w}" valign="top" style="width:${w}px;padding:0 8px;vertical-align:top;text-align:${b.align}">${inner}</td>`;
        })
        .join("");
      return `<tr><td style="padding:12px 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>${cols}</tr></table></td></tr>`;
    }
    case "quote": {
      const by = [b.author, b.role].filter(Boolean).map((s) => esc(fill(s, vars)));
      return cell(
        `<div style="border-left:4px solid ${t.accent};padding:4px 0 4px 20px">
<div style="font-family:${headFont};font-size:20px;line-height:1.5;font-style:italic;color:${t.heading}">&ldquo;${esc(fill(b.text, vars))}&rdquo;</div>
${by.length ? `<div style="margin-top:10px;font-family:${font};font-size:14px;color:${t.muted}"><strong style="color:${t.text}">${by[0]}</strong>${by[1] ? ` &middot; ${by[1]}` : ""}</div>` : ""}
</div>`,
        "16px 32px",
      );
    }
    case "callout": {
      const bg = b.background ?? t.tint;
      const color = contrastOn(bg);
      const inner = [
        b.title ? `<div style="font-family:${headFont};font-size:19px;font-weight:700;color:${color};margin-bottom:6px">${esc(fill(b.title, vars))}</div>` : "",
        b.text ? para(b.text, color, 15) : "",
      ].join("");
      return cell(`<div style="background:${bg};border-radius:${Math.min(t.radius, 12)}px;padding:20px 24px;text-align:${b.align}">${inner}</div>`, "12px 32px");
    }
    case "list": {
      const tag = b.ordered ? "ol" : "ul";
      const items = b.items.filter((i) => i.trim()).map((i) => `<li style="margin:0 0 8px">${inline(i, vars, link)}</li>`).join("");
      return cell(`<${tag} style="margin:0;padding:0 0 0 22px;font-family:${font};font-size:16px;line-height:1.6;color:${t.text}">${items}</${tag}>`, "8px 32px");
    }
    case "social": {
      const links = b.links
        .map((l) => ({ label: SOCIAL_LABELS[l.network], url: safeUrl(l.url, vars) }))
        .filter((l) => l.url)
        .map((l) => `<a href="${esc(l.url)}" style="display:inline-block;margin:0 6px;padding:8px 14px;border:1px solid ${lineColor(t)};border-radius:999px;font-family:${font};font-size:13px;font-weight:600;color:${t.text};text-decoration:none">${l.label}</a>`)
        .join("");
      return links ? cell(links, "16px 32px", b.align) : "";
    }
  }
}

function blockText(b: EmailBlock, vars: Variables): string {
  switch (b.type) {
    case "heading":
      return fill(b.text, vars).toUpperCase();
    case "text":
      return inlineText(b.text, vars);
    case "button": {
      const url = safeUrl(b.url, vars);
      return url ? `${fill(b.label, vars)}: ${url}` : "";
    }
    case "image": {
      const href = b.href ? safeUrl(b.href, vars) : "";
      return b.alt ? `[${fill(b.alt, vars)}]${href ? ` ${href}` : ""}` : "";
    }
    case "divider":
      return "---";
    case "spacer":
      return "";
    case "header":
      return [fill(b.brand, vars), fill(b.tagline, vars)].filter(Boolean).join(" — ");
    case "hero": {
      const url = safeUrl(b.buttonUrl, vars);
      return [fill(b.eyebrow, vars), fill(b.title, vars).toUpperCase(), inlineText(b.text, vars), url && b.buttonLabel ? `${fill(b.buttonLabel, vars)}: ${url}` : ""].filter(Boolean).join("\n\n");
    }
    case "columns":
      return b.items
        .map((it) => {
          const url = safeUrl(it.linkUrl, vars);
          return [fill(it.title, vars), inlineText(it.text, vars), url ? `${fill(it.linkLabel || "Link", vars)}: ${url}` : ""].filter(Boolean).join("\n");
        })
        .join("\n\n");
    case "quote":
      return `"${fill(b.text, vars)}"${b.author ? `\n— ${[fill(b.author, vars), fill(b.role, vars)].filter(Boolean).join(", ")}` : ""}`;
    case "callout":
      return [fill(b.title, vars), inlineText(b.text, vars)].filter(Boolean).join("\n");
    case "list":
      return b.items
        .filter((i) => i.trim())
        .map((i, n) => `${b.ordered ? `${n + 1}.` : "-"} ${inlineText(i, vars)}`)
        .join("\n");
    case "social":
      return b.links
        .map((l) => ({ label: SOCIAL_LABELS[l.network], url: safeUrl(l.url, vars) }))
        .filter((l) => l.url)
        .map((l) => `${l.label}: ${l.url}`)
        .join("\n");
  }
}

/** Stacks columns on phones. Spaced so the braces never read as a "}}" token. */
const COLUMNS_CSS = "\n<style>@media only screen and (max-width:600px) { .gd-col { display:block!important; width:100%!important; max-width:100%!important; padding:0 0 20px!important; } }</style>";

/** Renders a design to a complete HTML document and a plain-text alternative. */
export function renderEmail(blocks: EmailBlock[], opts: RenderOptions): { html: string; text: string } {
  const vars = opts.vars ?? {};
  const t = resolveTheme(opts.theme, opts.accent);
  const font = EMAIL_FONTS[t.font];
  const preheader = fill(opts.preheader ?? "", vars);
  const { legalName, postalAddress, preferencesUrl } = opts.footer;
  const transactional = opts.footer.mode === "transactional";
  const supportEmail = (opts.footer.supportEmail ?? "").trim();
  const address = postalAddress
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  // Links follow a theme's accent; the older `accent` option only ever coloured buttons.
  const link = opts.theme?.accent ?? DEFAULT_EMAIL_THEME.accent;
  const body = blocks.map((b) => blockHtml(b, vars, t, link)).join("");
  const hasColumns = blocks.some((b) => b.type === "columns");
  // A design that opens with a full-width band (header or hero) starts flush with the card's top edge.
  const flushTop = blocks[0]?.type === "header" || blocks[0]?.type === "hero";
  const footer = `<tr><td style="padding:24px 32px 32px;text-align:center;font-family:${font};font-size:12px;line-height:1.6;color:${t.muted}">
${legalName ? `<div>${esc(legalName)}</div>` : ""}${address.length ? `<div>${address.map(esc).join(" · ")}</div>` : ""}
${
  transactional
    ? supportEmail
      ? `<div style="margin-top:8px">Questions? Contact <a href="mailto:${esc(supportEmail)}" style="color:${t.muted};text-decoration:underline">${esc(supportEmail)}</a></div>`
      : ""
    : `<div style="margin-top:8px">You are receiving this because you subscribed. <a href="${esc(preferencesUrl)}" style="color:${t.muted};text-decoration:underline">Unsubscribe or manage preferences</a></div>`
}
</td></tr>`;

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(preheader)}</title>
${hasColumns ? COLUMNS_CSS : ""}</head>
<body style="margin:0;padding:0;background:${t.background}">
${preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${esc(preheader)}</div>` : ""}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${t.background}"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:${t.surface};border-radius:${t.radius}px;overflow:hidden">
${flushTop ? "" : `<tr><td style="height:16px;line-height:16px;font-size:1px">&nbsp;</td></tr>\n`}${body}
${footer}
</table></td></tr></table>
</body></html>`;

  const textParts = blocks.map((b) => blockText(b, vars)).filter((t) => t !== "");
  if (transactional) textParts.push("--", [legalName, ...address, supportEmail ? `Questions? Contact ${supportEmail}` : ""].filter(Boolean).join("\n"));
  else textParts.push("--", [legalName, ...address].filter(Boolean).join("\n"), `Unsubscribe or manage preferences: ${preferencesUrl}`);
  return { html, text: textParts.join("\n\n").replace(/\n{3,}/g, "\n\n").trim() };
}

/** Problems that stop a design from being sent, in words for people. */
export function designProblems(blocks: EmailBlock[]): string[] {
  const out: string[] = [];
  const hasText = blocks.some(
    (b) =>
      ((b.type === "text" || b.type === "heading") && b.text.trim()) ||
      (b.type === "hero" && (b.title.trim() || b.text.trim())) ||
      (b.type === "callout" && (b.title.trim() || b.text.trim())) ||
      (b.type === "columns" && b.items.some((i) => i.title.trim() || i.text.trim())) ||
      (b.type === "list" && b.items.some((i) => i.trim())),
  );
  if (!hasText) out.push("Add some text to the email.");
  const fullUrl = /^(https?:\/\/[^/\s]+\.[^\s]+|mailto:\S+|\{\{.+\}\})$/i;
  blocks.forEach((b, i) => {
    if (b.type === "button" && !fullUrl.test(b.url.trim())) out.push(`Button ${i + 1} needs a full link (https://…).`);
    if (b.type === "image" && !/^https?:\/\/\S+$/i.test(b.src.trim())) out.push(`Image ${i + 1} needs an image URL (https://…).`);
    if (b.type === "hero" && b.buttonLabel.trim() && !fullUrl.test(b.buttonUrl.trim())) out.push(`The hero's button (block ${i + 1}) needs a full link (https://…).`);
    if (b.type === "columns") b.items.forEach((it, j) => it.linkLabel.trim() && !fullUrl.test(it.linkUrl.trim()) && out.push(`Column ${j + 1} in block ${i + 1} needs a full link (https://…).`));
    if (b.type === "social" && b.links.some((l) => !fullUrl.test(l.url.trim()))) out.push(`Every social link (block ${i + 1}) needs a full link (https://…).`);
  });
  return out;
}
