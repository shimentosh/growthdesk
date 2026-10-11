import { simpleParser, type AddressObject, type MailParserOptions, type ParsedMail } from "mailparser";
import sanitizeHtml from "sanitize-html";
import { htmlToText } from "../messaging/mail-html.js";

/*
 * Pure readers of one inbound message: who sent it, what it answers, whether
 * a machine wrote it, whether it reports a failed delivery, and a safe copy
 * of its body. No database here, so every rule can be tested against a raw
 * fixture. Ported from LinkDesk packages/domain/src/services/inbound.service.ts
 * (addressOf, answersTo, isBounce, bodyOf) and spam.service.ts (header,
 * isAutoReply — as-is), plus real DSN (RFC 3464) parsing, which LinkDesk did
 * not have.
 */

/** mailparser keeps the message/delivery-status part as an attachment only when asked. */
export const parseMail = (source: Buffer | string): Promise<ParsedMail> =>
  simpleParser(source, { keepDeliveryStatus: true } as MailParserOptions);

export const MAX_TEXT = 200_000;
export const MAX_HTML = 500_000;

export const addressOf = (mail: ParsedMail): { name: string; email: string } => {
  const from = Array.isArray(mail.from) ? (mail.from as AddressObject[])[0] : mail.from;
  const first = from?.value?.[0];
  return { name: (first?.name || "").trim(), email: (first?.address || "").trim().toLowerCase() };
};

/** "a@x.com, b@y.com" from a parsed To/Cc header. */
export function addressList(field: AddressObject | AddressObject[] | undefined): string {
  const objects = Array.isArray(field) ? field : field ? [field] : [];
  const out: string[] = [];
  const walk = (values: AddressObject["value"]) => {
    for (const v of values) {
      if (v.address) out.push(v.address.trim().toLowerCase());
      if (v.group) walk(v.group);
    }
  };
  for (const o of objects) walk(o.value ?? []);
  return [...new Set(out)].join(", ").slice(0, 2000);
}

/**
 * The message ids this one is answering. `In-Reply-To` is the direct parent and
 * `References` is the chain above it; either is enough to place it. Each id is
 * returned with and without angle brackets — stored ids keep whatever
 * bracketing the sending server used. (LinkDesk answersTo.)
 */
export const answersTo = (mail: ParsedMail): string[] => {
  const ids = new Set<string>();
  const push = (v: unknown) => {
    for (const raw of String(v ?? "").split(/[\s,]+/)) {
      const id = raw.trim().replace(/^<|>$/g, "");
      if (!id) continue;
      ids.add(`<${id}>`);
      ids.add(id);
    }
  };
  push(mail.inReplyTo);
  push(Array.isArray(mail.references) ? mail.references.join(" ") : mail.references);
  return [...ids];
};

/** The References chain as stored (space-separated, bracketed), oldest first. */
export function referencesOf(mail: ParsedMail): string[] {
  const raw = Array.isArray(mail.references) ? mail.references.join(" ") : (mail.references ?? "");
  return raw
    .split(/[\s,]+/)
    .map((r) => r.trim().replace(/^<|>$/g, ""))
    .filter(Boolean)
    .map((id) => `<${id}>`);
}

export const bracketed = (id: string | null | undefined): string | null => {
  const bare = (id ?? "").trim().replace(/^<|>$/g, "");
  return bare ? `<${bare}>`.slice(0, 990) : null;
};

/**
 * One header, as it arrived. Read off `headerLines` rather than the parsed
 * `headers` map, because mailparser folds every `List-*` header into one
 * `list` object (LinkDesk spam.service.ts `header`, as-is).
 */
export const header = (mail: ParsedMail, name: string): string => {
  const wanted = name.toLowerCase();
  const lines = (mail.headerLines ?? []).filter((l) => l.key === wanted).map((l) => l.line.slice(l.line.indexOf(":") + 1).trim());
  if (lines.length) return lines.join(" ");
  const raw = mail.headers?.get(wanted);
  if (raw == null) return "";
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return raw.map((v) => String(v)).join(" ");
  if (typeof raw === "object" && "value" in raw) return String((raw as { value: unknown }).value ?? "");
  return String(raw);
};

/*
 * Mail a machine sent because a person is away (LinkDesk spam.service.ts,
 * ported as-is). RFC 3834 `Auto-Submitted` other than `no`, `Precedence:
 * auto_reply`, the X-Auto* family, and — narrowly, anchored at the start —
 * the subject phrases responders write.
 */
const AUTO_SUBJECT = new RegExp(
  String.raw`^\s*(?:re\s*:\s*)?(?:` +
    String.raw`out of (?:the )?office|automatic repl(?:y|ies)|auto[- ]?repl(?:y|ies)|autorespon(?:se|der)` +
    String.raw`|away from (?:my |the )?(?:office|desk|e-?mail)|on (?:annual |parental |maternity )?leave` +
    String.raw`|vacation (?:reply|response|auto)|abwesenheit\w*|absence du bureau|fuera de la oficina` +
    String.raw`)\b`,
  "i",
);

export function isAutoReply(mail: ParsedMail): boolean {
  const submitted = header(mail, "auto-submitted").trim().toLowerCase();
  if (submitted && submitted !== "no") return true;
  if (/\bauto[_-]?(reply|generated|notify)\b/i.test(header(mail, "precedence"))) return true;
  for (const name of ["x-autoreply", "x-autorespond", "x-auto-response-suppress", "x-autoreply-from"]) {
    if (header(mail, name).trim()) return true;
  }
  if (/^(?:auto[- ]?(?:replied|generated|responder)|vacation)$/i.test(header(mail, "x-mailer").trim())) return true;
  return AUTO_SUBJECT.test(String(mail.subject ?? ""));
}

/*
 * Mail no person wrote to us: newsletters, mailing lists, notifications and
 * other machine-sent mail. `Precedence: bulk/list/junk`, a `List-Id` or
 * `List-Unsubscribe` header, RFC 3834 `Auto-Submitted` other than `no`, or a
 * no-reply style sender. The caller files it only when it answers a message
 * we sent; otherwise it never becomes a contact, a reply, a task or AI work.
 */
const NO_REPLY_SENDER = /^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|notifications?|notify|alerts?|bounces?|mailer)(?:[-_.+][^@]*)?@/i;

/** Why this message is machine mail, or null when a person plausibly wrote it. */
export function machineMailReason(mail: ParsedMail, from: string): string | null {
  const precedence = header(mail, "precedence").trim().toLowerCase();
  if (/^(bulk|list|junk)\b/.test(precedence)) return `Precedence: ${precedence}`;
  if (header(mail, "list-id").trim()) return "mailing list (List-Id)";
  if (header(mail, "list-unsubscribe").trim()) return "bulk mail (List-Unsubscribe)";
  const submitted = header(mail, "auto-submitted").trim().toLowerCase();
  if (submitted && submitted !== "no") return `Auto-Submitted: ${submitted}`;
  if (NO_REPLY_SENDER.test(from)) return "no-reply sender";
  return null;
}

// ─── Delivery failures ────────────────────────────────────────────────────────

export type DsnRecipient = { recipient: string; action: string; status: string; diagnostic: string };

export type BounceReport = {
  /** dsn: a real RFC 3464 report. heuristic: looks like a bounce (sender/subject), no machine-readable report. */
  kind: "dsn" | "heuristic";
  /** hard: permanent failure (5.x.x / Action: failed). soft: delayed / 4.x.x — not a bounce, nothing to record. */
  verdict: "hard" | "soft";
  recipients: DsnRecipient[];
  /** Message-IDs this report is about: In-Reply-To/References plus the Message-ID in the returned headers. */
  referencedIds: string[];
  diagnostic: string;
};

const isDsnContainer = (mail: ParsedMail): boolean => {
  const ct = mail.headers?.get("content-type") as { value?: string; params?: Record<string, string> } | string | undefined;
  if (!ct) return false;
  if (typeof ct === "string") return /multipart\/report/i.test(ct) && /report-type\s*=\s*"?delivery-status/i.test(ct);
  return /^multipart\/report$/i.test(ct.value ?? "") && /delivery-status/i.test(ct.params?.["report-type"] ?? "");
};

/** The message/delivery-status part: an attachment when parsed with keepDeliveryStatus, else inlined into `text`. */
function deliveryStatusText(mail: ParsedMail): string | null {
  const part = (mail.attachments ?? []).find((a) => /^message\/(global-)?delivery-status$/i.test(a.contentType));
  if (part) return part.content.toString("utf8");
  // Parsed without keepDeliveryStatus, mailparser appends the report to the text body.
  const text = mail.text ?? "";
  const at = text.search(/^(Reporting-MTA|Final-Recipient|Original-Recipient|Arrival-Date)\s*:/im);
  return at >= 0 ? text.slice(at) : null;
}

/** RFC 822-style field groups separated by blank lines, with folded lines unfolded. */
function fieldGroups(text: string): Record<string, string>[] {
  const groups: Record<string, string>[] = [];
  for (const block of text.replace(/\r\n/g, "\n").split(/\n\s*\n/)) {
    const fields: Record<string, string> = {};
    let last = "";
    for (const line of block.split("\n")) {
      if (/^[ \t]/.test(line) && last) {
        fields[last] += ` ${line.trim()}`;
        continue;
      }
      const m = /^([A-Za-z0-9-]+)\s*:\s*(.*)$/.exec(line);
      if (!m) continue;
      last = m[1]!.toLowerCase();
      fields[last] = fields[last] ? `${fields[last]} ${m[2]!.trim()}` : m[2]!.trim();
    }
    if (Object.keys(fields).length) groups.push(fields);
  }
  return groups;
}

const addressFromField = (v: string | undefined) => {
  const raw = (v ?? "").split(";").pop() ?? "";
  return raw.trim().replace(/^<|>$/g, "").toLowerCase();
};

/** Per-recipient fields from a message/delivery-status body (RFC 3464 §2.3). */
export function parseDeliveryStatus(text: string): DsnRecipient[] {
  return fieldGroups(text)
    .filter((g) => g["final-recipient"] || g["original-recipient"] || g["action"])
    .map((g) => ({
      recipient: addressFromField(g["final-recipient"] ?? g["original-recipient"]),
      action: (g["action"] ?? "").trim().toLowerCase(),
      status: (/\d\.\d{1,3}\.\d{1,3}/.exec(g["status"] ?? "")?.[0] ?? "").trim(),
      diagnostic: (g["diagnostic-code"] ?? "").replace(/^[a-z0-9-]+\s*;\s*/i, "").trim().slice(0, 500),
    }));
}

/** Message-IDs quoted in the returned original (text/rfc822-headers, message/rfc822 parts). */
function returnedMessageIds(mail: ParsedMail): string[] {
  const ids: string[] = [];
  for (const a of mail.attachments ?? []) {
    if (!/^(text\/rfc822-headers|message\/rfc822|message\/global|message\/global-headers)$/i.test(a.contentType)) continue;
    const head = a.content.toString("utf8").replace(/\r\n/g, "\n").split(/\n\s*\n/)[0] ?? "";
    const unfolded = head.replace(/\n[ \t]+/g, " ");
    const m = /^message-id\s*:\s*(<[^>\s]+>|\S+)/im.exec(unfolded);
    const id = bracketed(m?.[1]);
    if (id) ids.push(id);
  }
  return ids;
}

const HEURISTIC_SENDER = /^(mailer-daemon|postmaster)@/i;
const HEURISTIC_SUBJECT = /^\s*(undeliverable|undelivered mail|delivery status notification|mail delivery (failed|failure|subsystem)|returned mail|delivery failure|failure notice)/i;
const SOFT_WORDS = /\b(delay(ed)?|will (?:be )?retr(?:y|ied)|still trying|temporar(?:y|ily)|deferred)\b/i;

/**
 * Whether this message reports a failed delivery, and how permanently.
 *
 * A real DSN (`multipart/report; report-type=delivery-status`) is read field
 * by field: Action `failed` or a 5.x.x Status is a hard bounce; `delayed` or
 * 4.x.x is not a bounce at all. Without a report, LinkDesk's sender/subject
 * heuristic marks it as a probable bounce — the caller acts on that only when
 * it can name the original message we sent, and never by guessing a
 * recipient from the body text.
 */
export function detectBounce(mail: ParsedMail, from: string): BounceReport | null {
  const referencedIds = [...new Set([...answersTo(mail).filter((id) => id.startsWith("<")), ...returnedMessageIds(mail)])];
  if (isDsnContainer(mail)) {
    const status = deliveryStatusText(mail);
    const recipients = status ? parseDeliveryStatus(status) : [];
    const hard = recipients.some((r) => r.action === "failed" || r.status.startsWith("5."));
    const diagnostic = recipients.map((r) => [r.status, r.diagnostic].filter(Boolean).join(" ")).filter(Boolean).join("; ").slice(0, 500);
    if (recipients.length) return { kind: "dsn", verdict: hard ? "hard" : "soft", recipients, referencedIds, diagnostic };
    // A report with no readable recipients: judge it like any other probable bounce.
  }
  if (HEURISTIC_SENDER.test(from) || HEURISTIC_SUBJECT.test(mail.subject ?? "") || isDsnContainer(mail)) {
    const sample = `${mail.subject ?? ""}\n${(mail.text ?? "").slice(0, 2000)}`;
    const soft = SOFT_WORDS.test(sample) && !/\b5\.\d{1,3}\.\d{1,3}\b|\b55\d\b/.test(sample);
    const diagnostic = (/\b[45]\d\d[ -][45]\.\d{1,3}\.\d{1,3}[^\n]*/.exec(sample)?.[0] ?? mail.subject ?? "Delivery failed").trim().slice(0, 500);
    return { kind: "heuristic", verdict: soft ? "soft" : "hard", recipients: [], referencedIds, diagnostic };
  }
  return null;
}

// ─── Bodies ───────────────────────────────────────────────────────────────────

/** The plain text of a message, falling back to its HTML with the tags taken out. */
export function bodyTextOf(mail: ParsedMail): string {
  const text = (mail.text ?? "").trim();
  if (text) return text.slice(0, MAX_TEXT);
  const html = typeof mail.html === "string" ? mail.html : "";
  return htmlToText(html).slice(0, MAX_TEXT);
}

const SAFE_STYLE = [/^[#a-z0-9(),.%\s-]{1,60}$/i];

/**
 * Inbound HTML made safe to render in the inbox: no scripts, styles, frames,
 * forms or event handlers; basic formatting and tables; links open in a new
 * tab with rel=noopener; images only over https (no tracking over http, no
 * data: or cid: payloads); a short list of inline styles.
 */
export function sanitizeInboundHtml(html: string | false | undefined): string | null {
  if (typeof html !== "string" || !html.trim()) return null;
  const clean = sanitizeHtml(html.slice(0, MAX_HTML * 2), {
    allowedTags: [...sanitizeHtml.defaults.allowedTags, "img", "font", "center", "u", "s", "small", "big"],
    disallowedTagsMode: "discard",
    allowedAttributes: {
      // target/rel are always overwritten by the transform below, never taken from the sender.
      a: ["href", "title", "name", "target", "rel"],
      img: ["src", "alt", "title", "width", "height"],
      font: ["color", "size", "face"],
      table: ["width", "border", "cellpadding", "cellspacing", "align"],
      td: ["colspan", "rowspan", "align", "valign", "width"],
      th: ["colspan", "rowspan", "align", "valign", "width"],
      "*": ["style", "dir", "align"],
    },
    allowedStyles: {
      "*": {
        color: SAFE_STYLE,
        "background-color": SAFE_STYLE,
        "font-weight": SAFE_STYLE,
        "font-style": SAFE_STYLE,
        "font-size": SAFE_STYLE,
        "text-align": SAFE_STYLE,
        "text-decoration": SAFE_STYLE,
        "line-height": SAFE_STYLE,
        "white-space": SAFE_STYLE,
      },
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: { img: ["https"] },
    allowedSchemesAppliedToAttributes: ["href", "src"],
    allowProtocolRelative: false,
    transformTags: {
      a: (tagName, attribs) => ({ tagName, attribs: { ...attribs, target: "_blank", rel: "noopener noreferrer nofollow" } }),
    },
    exclusiveFilter: (frame) => frame.tag === "img" && !frame.attribs.src,
  });
  return clean.trim() ? clean.slice(0, MAX_HTML) : null;
}

// ─── What the person wrote ────────────────────────────────────────────────────

/** Lines that start the quoted original: everything from here down is not the reply. */
const QUOTE_BOUNDARY = [
  /^\s*-{2,}\s*(original message|forwarded message|ursprüngliche nachricht|message d'origine|mensaje original)\s*-{2,}/i,
  /^\s*_{10,}\s*$/, // Outlook's rule above the quoted original
  /^\s*(sent from my|get outlook for)\b/i,
  /^-- ?$/, // RFC 3676 signature delimiter (our own outbound signature uses "--")
];
/** "On <date>, <person> wrote:" in the common languages, possibly wrapped over two lines. */
const ATTRIBUTION = /^\s*(on|am|le|el|il|op|den|em)\s.{0,300}\b(wrote|schrieb|a écrit|escribió|ha scritto|schreef|skrev|escreveu)\s*:\s*$/i;
/** Outlook's quoted header block: From: then Sent:/Date: within the next lines. */
const HEADER_FROM = /^\s*\*?(from|von|de|van)\s*:\*?\s/i;
const HEADER_NEXT = /^\s*\*?(sent|date|to|subject|gesendet|datum|envoyé|enviado)\s*:/i;
/** The opt-out line of our own outbound footer, in case a client quotes it without markers. */
const OWN_FOOTER = /^\s*(if you would rather not hear from me again|not interested\?\s*unsubscribe)/i;

/**
 * The part of a reply its sender wrote: quoted lines (`>`), "On … wrote:"
 * attributions, the quoted original below an Outlook header block or
 * separator, and the signature are taken out. Bottom-posted answers survive,
 * since only the quoted lines themselves are dropped until a hard boundary.
 */
export function latestReplyText(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (QUOTE_BOUNDARY.some((re) => re.test(line))) break;
    if (HEADER_FROM.test(line) && lines.slice(i + 1, i + 4).some((l) => HEADER_NEXT.test(l))) break;
    if (/^\s*>/.test(line) || OWN_FOOTER.test(line)) continue;
    if (ATTRIBUTION.test(line)) continue;
    // A long attribution wrapped by the client: "On Tue, … Jane Doe <" / "jane@x.com> wrote:".
    if (i + 1 < lines.length && ATTRIBUTION.test(`${line} ${lines[i + 1]}`)) {
      i += 1;
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * The text a person wrote in this message, quotes and signature removed. An
 * HTML-only message loses its quoted blocks (`<blockquote>`, Gmail's
 * `gmail_quote`, Outlook's reply header) before its tags are taken out, as
 * converted text carries no `>` markers.
 */
export function replyTextOf(mail: ParsedMail): string {
  const text = (mail.text ?? "").trim();
  if (text) return latestReplyText(text.slice(0, MAX_TEXT));
  const html = typeof mail.html === "string" ? mail.html.slice(0, MAX_HTML * 2) : "";
  const cut = html.search(/<div[^>]+(class="[^"]*gmail_quote|id="(divRplyFwdMsg|appendonsend)")|<hr[^>]+id="stopSpelling"/i);
  const own = (cut >= 0 ? html.slice(0, cut) : html).replace(/<blockquote[\s\S]*<\/blockquote>/gi, "");
  return latestReplyText(htmlToText(own));
}

const UNSUBSCRIBE_INTENT = /\b(unsubscribe|remove me|stop emailing|take me off)\b/i;

/** A written opt-out at the top of what the sender wrote — never in the quoted email below it. */
export const asksToUnsubscribe = (bodyText: string) => UNSUBSCRIBE_INTENT.test(latestReplyText(bodyText).slice(0, 300));

export const stripSubjectPrefix = (subject: string) => subject.replace(/^\s*((re|fwd?|aw|sv|antw)\s*:\s*)+/i, "").trim();
