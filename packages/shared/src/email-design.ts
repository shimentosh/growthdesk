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
 */

const httpUrl = z
  .string()
  .trim()
  .max(2000)
  .refine((u) => u === "" || /^https?:\/\//i.test(u) || /^\{\{.+\}\}$/.test(u) || /^mailto:/i.test(u), "Use a full link starting with https://");
const align = z.enum(["left", "center", "right"]).default("left");
const hex = z.string().regex(/^#[0-9a-f]{6}$/i, "Use a hex colour like #0071e3");
const blockId = z.string().min(1).max(40);

export const EmailBlock = z.discriminatedUnion("type", [
  z.object({ type: z.literal("heading"), id: blockId, text: z.string().max(300).default(""), level: z.union([z.literal(1), z.literal(2)]).default(1), align }),
  z.object({ type: z.literal("text"), id: blockId, text: z.string().max(10_000).default(""), align }),
  z.object({ type: z.literal("button"), id: blockId, label: z.string().max(80).default("Learn more"), url: httpUrl.default(""), align: align.default("center"), color: hex.optional() }),
  z.object({ type: z.literal("image"), id: blockId, src: httpUrl.default(""), alt: z.string().max(300).default(""), href: httpUrl.optional(), width: z.number().int().min(10).max(100).default(100) }),
  z.object({ type: z.literal("divider"), id: blockId }),
  z.object({ type: z.literal("spacer"), id: blockId, height: z.number().int().min(4).max(120).default(24) }),
]);
export type EmailBlock = z.infer<typeof EmailBlock>;
export type EmailBlockType = EmailBlock["type"];
export const EmailBlocks = z.array(EmailBlock).max(100);

export const EMAIL_BLOCK_TYPES: { type: EmailBlockType; label: string }[] = [
  { type: "heading", label: "Heading" },
  { type: "text", label: "Text" },
  { type: "button", label: "Button" },
  { type: "image", label: "Image" },
  { type: "divider", label: "Divider" },
  { type: "spacer", label: "Spacer" },
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
  }
}

/** A starting design for a new email. */
export function starterBlocks(makeId: () => string): EmailBlock[] {
  return [newBlock("heading", makeId()), newBlock("text", makeId()), newBlock("button", makeId())];
}

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
  /** Default button colour. */
  accent?: string;
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
function inline(text: string, vars: Variables): string {
  let out = esc(fill(text, vars));
  out = out.replace(/\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^)\s]+)\)/gi, (_m, label: string, url: string) => `<a href="${url}" style="color:#0071e3;text-decoration:underline">${label}</a>`);
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

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function blockHtml(b: EmailBlock, vars: Variables, accent: string): string {
  const cell = (inner: string, pad = "8px 32px", alignment = "left") => `<tr><td style="padding:${pad};text-align:${alignment}">${inner}</td></tr>`;
  switch (b.type) {
    case "heading": {
      const size = b.level === 1 ? 28 : 21;
      return cell(`<h${b.level} style="margin:0;font-family:${FONT};font-size:${size}px;line-height:1.25;font-weight:700;color:#1d1d1f">${esc(fill(b.text, vars))}</h${b.level}>`, "16px 32px 8px", b.align);
    }
    case "text":
      return cell(`<p style="margin:0;font-family:${FONT};font-size:16px;line-height:1.6;color:#1d1d1f">${inline(b.text, vars)}</p>`, "8px 32px", b.align);
    case "button": {
      const url = safeUrl(b.url, vars);
      if (!url) return "";
      const color = b.color ?? accent;
      return cell(
        `<a href="${esc(url)}" style="display:inline-block;background:${color};color:#ffffff;font-family:${FONT};font-size:16px;font-weight:600;line-height:1;text-decoration:none;padding:14px 24px;border-radius:10px">${esc(fill(b.label, vars))}</a>`,
        "16px 32px",
        b.align,
      );
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
      return cell(`<div style="border-top:1px solid #e5e5ea;height:1px;line-height:1px;font-size:1px">&nbsp;</div>`, "16px 32px");
    case "spacer":
      return `<tr><td style="height:${b.height}px;line-height:${b.height}px;font-size:1px">&nbsp;</td></tr>`;
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
  }
}

/** Renders a design to a complete HTML document and a plain-text alternative. */
export function renderEmail(blocks: EmailBlock[], opts: RenderOptions): { html: string; text: string } {
  const vars = opts.vars ?? {};
  const accent = opts.accent ?? "#0071e3";
  const preheader = fill(opts.preheader ?? "", vars);
  const { legalName, postalAddress, preferencesUrl } = opts.footer;
  const transactional = opts.footer.mode === "transactional";
  const supportEmail = (opts.footer.supportEmail ?? "").trim();
  const address = postalAddress
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const body = blocks.map((b) => blockHtml(b, vars, accent)).join("");
  const footer = `<tr><td style="padding:24px 32px 32px;text-align:center;font-family:${FONT};font-size:12px;line-height:1.6;color:#6e6e73">
${legalName ? `<div>${esc(legalName)}</div>` : ""}${address.length ? `<div>${address.map(esc).join(" · ")}</div>` : ""}
${
  transactional
    ? supportEmail
      ? `<div style="margin-top:8px">Questions? Contact <a href="mailto:${esc(supportEmail)}" style="color:#6e6e73;text-decoration:underline">${esc(supportEmail)}</a></div>`
      : ""
    : `<div style="margin-top:8px">You are receiving this because you subscribed. <a href="${esc(preferencesUrl)}" style="color:#6e6e73;text-decoration:underline">Unsubscribe or manage preferences</a></div>`
}
</td></tr>`;

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(preheader)}</title></head>
<body style="margin:0;padding:0;background:#f5f5f7">
${preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${esc(preheader)}</div>` : ""}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f5f7"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:16px">
<tr><td style="height:16px;line-height:16px;font-size:1px">&nbsp;</td></tr>
${body}
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
  if (!blocks.some((b) => (b.type === "text" || b.type === "heading") && b.text.trim())) out.push("Add some text to the email.");
  blocks.forEach((b, i) => {
    if (b.type === "button" && !/^(https?:\/\/[^/\s]+\.[^\s]+|mailto:\S+|\{\{.+\}\})$/i.test(b.url.trim())) out.push(`Button ${i + 1} needs a full link (https://…).`);
    if (b.type === "image" && !/^https?:\/\/\S+$/i.test(b.src.trim())) out.push(`Image ${i + 1} needs an image URL (https://…).`);
  });
  return out;
}
