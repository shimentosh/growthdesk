import type { ReactNode } from "react";

/*
 * COPY of apps/web/src/components/site/Markdown.tsx (the customer site renders legal pages
 * with it), so the preview here matches what visitors see. Unify into packages/ui later.
 *
 * A small Markdown renderer for the legal pages, written to be safe rather
 * than complete. It builds React elements directly — there is no HTML string
 * and no dangerouslySetInnerHTML anywhere — so raw HTML in the source is shown
 * as text, never parsed. Links are kept only for http(s), mailto, site paths
 * and #anchors; anything else (javascript:, data:) renders as plain text.
 *
 * Supported: # headings, paragraphs, - / 1. lists (nested by indentation),
 * > quotes, ``` code blocks, --- rules, GFM pipe tables, **bold**, *italic*,
 * `code`, [links](url).
 */

const SAFE_HREF = /^(https?:\/\/|mailto:|\/(?!\/)|#)/i;

type Pattern = { re: RegExp; render: (m: RegExpExecArray, key: string) => ReactNode };

const PATTERNS: Pattern[] = [
  { re: /`([^`]+)`/, render: (m, key) => <code key={key} className="rounded-xs bg-well px-1 py-0.5 font-mono text-[0.92em]">{m[1]}</code> },
  {
    re: /\[([^\]]+)\]\(([^)\s]+)\)/,
    render: (m, key) => {
      const href = m[2] ?? "";
      if (!SAFE_HREF.test(href)) return <span key={key}>{inline(m[1] ?? "", key)}</span>;
      const external = /^https?:\/\//i.test(href);
      return (
        <a
          key={key}
          href={href}
          className="font-medium text-accent-ink underline decoration-accent/30 underline-offset-2 hover:decoration-accent"
          {...(external ? { target: "_blank", rel: "noopener noreferrer nofollow" } : {})}
        >
          {inline(m[1] ?? "", key)}
        </a>
      );
    },
  },
  { re: /\*\*(.+?)\*\*/, render: (m, key) => <strong key={key} className="font-semibold text-text-hi">{inline(m[1] ?? "", key)}</strong> },
  { re: /__(.+?)__/, render: (m, key) => <strong key={key} className="font-semibold text-text-hi">{inline(m[1] ?? "", key)}</strong> },
  { re: /\*(?!\s)(.+?)\*/, render: (m, key) => <em key={key}>{inline(m[1] ?? "", key)}</em> },
  { re: /(?<![A-Za-z0-9])_(?!\s)(.+?)_(?![A-Za-z0-9])/, render: (m, key) => <em key={key}>{inline(m[1] ?? "", key)}</em> },
];

/** Inline formatting: repeatedly takes the earliest match of any pattern. */
function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let n = 0;
  while (rest) {
    let best: { m: RegExpExecArray; p: Pattern } | null = null;
    for (const p of PATTERNS) {
      const m = p.re.exec(rest);
      if (m && (!best || m.index < best.m.index)) best = { m, p };
    }
    if (!best) {
      out.push(rest);
      break;
    }
    if (best.m.index > 0) out.push(rest.slice(0, best.m.index));
    out.push(best.p.render(best.m, `${keyBase}.${n++}`));
    rest = rest.slice(best.m.index + best.m[0].length);
  }
  return out;
}

const RE = {
  fence: /^\s*```/,
  heading: /^(#{1,6})\s+(.*?)\s*#*\s*$/,
  rule: /^\s*([-*_])(?:\s*\1){2,}\s*$/,
  quote: /^\s*>\s?/,
  item: /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/,
  tableSep: /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/,
};

const startsBlock = (line: string, next?: string) =>
  RE.fence.test(line) || RE.heading.test(line) || RE.rule.test(line) || RE.quote.test(line) || RE.item.test(line) || (line.includes("|") && next !== undefined && RE.tableSep.test(next));

const cells = (row: string) =>
  row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());

const indentOf = (line: string) => line.match(/^\s*/)?.[0].replace(/\t/g, "    ").length ?? 0;

function blocks(lines: string[], keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let i = 0;
  const key = () => `${keyBase}-${out.length}`;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!line.trim()) {
      i++;
      continue;
    }

    if (RE.fence.test(line)) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !RE.fence.test(lines[i] ?? "")) code.push(lines[i++] ?? "");
      i++;
      out.push(
        <pre key={key()} className="my-4 overflow-x-auto rounded-md border border-line bg-well p-3 font-mono text-xs leading-5 text-text">
          <code>{code.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    const h = RE.heading.exec(line);
    if (h) {
      const level = Math.min(4, Math.max(2, (h[1] ?? "#").length));
      const content = inline(h[2] ?? "", key());
      out.push(
        level === 2 ? (
          <h2 key={key()} className="mt-9 mb-3 text-xl font-semibold tracking-[-0.015em] text-text-hi first:mt-0">{content}</h2>
        ) : level === 3 ? (
          <h3 key={key()} className="mt-7 mb-2 text-lg font-semibold text-text-hi">{content}</h3>
        ) : (
          <h4 key={key()} className="mt-5 mb-2 text-base font-semibold text-text-hi">{content}</h4>
        ),
      );
      i++;
      continue;
    }

    if (RE.rule.test(line)) {
      out.push(<hr key={key()} className="my-8 border-line" />);
      i++;
      continue;
    }

    if (line.includes("|") && RE.tableSep.test(lines[i + 1] ?? "")) {
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && (lines[i] ?? "").trim() && (lines[i] ?? "").includes("|")) rows.push(cells(lines[i++] ?? ""));
      const k = key();
      out.push(
        <div key={k} className="my-5 overflow-x-auto rounded-md border border-line">
          <table className="w-full border-collapse text-left text-sm">
            <thead className="bg-well">
              <tr>
                {head.map((c, ci) => (
                  <th key={ci} className="border-b border-line px-3 py-2 font-semibold text-text-hi">{inline(c, `${k}.h${ci}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri} className="border-b border-line last:border-b-0">
                  {head.map((_, ci) => (
                    <td key={ci} className="px-3 py-2 align-top text-text-2">{inline(r[ci] ?? "", `${k}.${ri}.${ci}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    if (RE.quote.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && RE.quote.test(lines[i] ?? "")) quoted.push((lines[i++] ?? "").replace(RE.quote, ""));
      const k = key();
      out.push(
        <blockquote key={k} className="my-5 border-l-2 border-line-strong pl-4 text-text-2">
          {blocks(quoted, k)}
        </blockquote>,
      );
      continue;
    }

    const first = RE.item.exec(line);
    if (first) {
      const ordered = /\d/.test(first[2] ?? "");
      const base = indentOf(line);
      const items: string[][] = [];
      while (i < lines.length) {
        const l = lines[i] ?? "";
        const m = RE.item.exec(l);
        if (m && indentOf(l) <= base + 1 && /\d/.test(m[2] ?? "") === ordered) {
          items.push([m[3] ?? ""]);
          i++;
          continue;
        }
        if (!l.trim()) {
          // A blank line ends the list unless the list (or an item's body) carries on after it.
          const next = lines[i + 1] ?? "";
          if (next.trim() && (indentOf(next) > base + 1 || (RE.item.test(next) && indentOf(next) <= base + 1))) {
            items.at(-1)?.push("");
            i++;
            continue;
          }
          break;
        }
        if (indentOf(l) > base + 1) {
          items.at(-1)?.push(l.slice(Math.min(indentOf(l), base + 2)));
          i++;
          continue;
        }
        if (startsBlock(l, lines[i + 1])) break;
        // A lazy continuation of the item's paragraph.
        const last = items.at(-1);
        if (last) last[last.length - 1] = `${last[last.length - 1]} ${l.trim()}`;
        i++;
      }
      const k = key();
      const lis = items.map((body, ii) => {
        const simple = body.length === 1;
        return (
          <li key={ii} className="pl-1">
            {simple ? inline(body[0] ?? "", `${k}.${ii}`) : blocks(body, `${k}.${ii}`)}
          </li>
        );
      });
      out.push(
        ordered ? (
          <ol key={k} className="my-4 list-decimal space-y-1.5 pl-6 text-text-2 marker:text-text-3">{lis}</ol>
        ) : (
          <ul key={k} className="my-4 list-disc space-y-1.5 pl-6 text-text-2 marker:text-text-3">{lis}</ul>
        ),
      );
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && (lines[i] ?? "").trim() && (para.length === 0 || !startsBlock(lines[i] ?? "", lines[i + 1]))) para.push((lines[i++] ?? "").trim());
    out.push(
      <p key={key()} className="my-4 text-text-2">
        {inline(para.join(" "), key())}
      </p>,
    );
  }
  return out;
}

export function Markdown({ source, className }: { source: string; className?: string }) {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  return <div className={className ?? "text-[15px] leading-7"}>{blocks(lines, "md")}</div>;
}
