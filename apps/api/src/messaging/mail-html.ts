/*
 * Plain-text-with-light-markdown → email HTML. Ported from LinkDesk
 * packages/core/src/lib/mail-html.ts (paragraphs, lists, quotes, links,
 * emphasis); the styles are inline and colour-literal because email clients
 * ignore CSS variables. Only http(s) and mailto links become anchors.
 */

const SAFE_LINK = /^(https?:\/\/|mailto:)/i;

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function links(escaped: string): string {
  return escaped
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, label: string, href: string) => (SAFE_LINK.test(href) ? `<a href="${href}">${label}</a>` : whole))
    .replace(/(^|[\s(])(https?:\/\/[^\s<>()]+)/g, (_m, lead: string, url: string) => `${lead}<a href="${url}">${url}</a>`);
}

function emphasis(html: string): string {
  return html
    .replace(/(\*\*|__)([^\n]+?)\1/g, "<strong>$2</strong>")
    .replace(/(^|[^*\w])\*([^*\n]+?)\*(?![*\w])/g, "$1<em>$2</em>")
    .replace(/(^|[^_\w])_([^_\n]+?)_(?![_\w])/g, "$1<em>$2</em>");
}

const inline = (raw: string) => emphasis(links(escapeHtml(raw)));

export function markdownToEmailHtml(markdown: string): string {
  const lines = (markdown ?? "").replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let paragraph: string[] = [];
  let bullets: string[] = [];
  let numbers: string[] = [];
  let quote: string[] = [];
  const flush = () => {
    if (paragraph.length) out.push(`<p style="margin:0 0 12px">${paragraph.map(inline).join("<br>")}</p>`);
    if (bullets.length) out.push(`<ul style="margin:0 0 12px;padding-left:22px">${bullets.map((b) => `<li>${inline(b)}</li>`).join("")}</ul>`);
    if (numbers.length) out.push(`<ol style="margin:0 0 12px;padding-left:24px">${numbers.map((b) => `<li>${inline(b)}</li>`).join("")}</ol>`);
    if (quote.length) out.push(`<blockquote style="margin:0 0 12px;padding-left:12px;border-left:3px solid #d4d4d8;color:#52525b">${quote.map(inline).join("<br>")}</blockquote>`);
    paragraph = [];
    bullets = [];
    numbers = [];
    quote = [];
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const number = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const quoted = /^\s*>\s?(.*)$/.exec(line);
    if (!line.trim()) flush();
    else if (bullet) {
      if (paragraph.length || numbers.length || quote.length) flush();
      bullets.push(bullet[1] ?? "");
    } else if (number) {
      if (paragraph.length || bullets.length || quote.length) flush();
      numbers.push(number[1] ?? "");
    } else if (quoted) {
      if (paragraph.length || bullets.length || numbers.length) flush();
      quote.push(quoted[1] ?? "");
    } else {
      if (bullets.length || numbers.length || quote.length) flush();
      paragraph.push(line);
    }
  }
  flush();
  return `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#18181b">${out.join("")}</div>`;
}

/** Readable text from an HTML part, for previews and for messages that arrived HTML-only. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
