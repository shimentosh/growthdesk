import { z } from "zod";

/*
 * Discord notifications: a workspace connects its own Discord server through
 * the installation's Discord application (a bot), chooses channels as
 * destinations, and routes its domain events (the same ones workflows and
 * outgoing webhooks see) to them through rules, each rendered by a template.
 *
 * Everything here is pure so the API (sending) and the web app (live preview,
 * validation) render and check a template the same way.
 */

// ─── Permissions ─────────────────────────────────────────────────────────────

/** Discord permission bits Growthdesk reads or asks for (https://discord.com/developers/docs/topics/permissions). */
export const DISCORD_PERMISSION = {
  ADMINISTRATOR: 1n << 3n,
  MANAGE_CHANNELS: 1n << 4n,
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  EMBED_LINKS: 1n << 14n,
} as const;

/** What the bot needs to post: see the channel, send, and attach embeds. */
export const DISCORD_SEND_PERMISSIONS = DISCORD_PERMISSION.VIEW_CHANNEL | DISCORD_PERMISSION.SEND_MESSAGES | DISCORD_PERMISSION.EMBED_LINKS;

/** The bot's permission request: the send set, plus Manage Channels only when the workspace wants to create and rename channels from Growthdesk. */
export const discordInstallPermissions = (manageChannels: boolean): string =>
  (DISCORD_SEND_PERMISSIONS | (manageChannels ? DISCORD_PERMISSION.MANAGE_CHANNELS : 0n)).toString();

export const DISCORD_PERMISSION_LABELS: { bit: keyof typeof DISCORD_PERMISSION; label: string; required: boolean }[] = [
  { bit: "VIEW_CHANNEL", label: "View channels", required: true },
  { bit: "SEND_MESSAGES", label: "Send messages", required: true },
  { bit: "EMBED_LINKS", label: "Embed links", required: true },
  { bit: "MANAGE_CHANNELS", label: "Manage channels (create and rename)", required: false },
];

export const hasDiscordPermission = (perms: string | bigint, bit: bigint): boolean => {
  const p = typeof perms === "bigint" ? perms : toBig(perms);
  return (p & DISCORD_PERMISSION.ADMINISTRATOR) === DISCORD_PERMISSION.ADMINISTRATOR || (p & bit) === bit;
};

const toBig = (v: string | number | null | undefined): bigint => {
  try {
    return BigInt(v ?? 0);
  } catch {
    return 0n;
  }
};

export type DiscordRole = { id: string; permissions: string };
export type DiscordOverwrite = { id: string; type: 0 | 1; allow: string; deny: string };

const ALL_PERMISSIONS = (1n << 53n) - 1n;

/** The bot's server-wide permissions: @everyone (the role whose id is the guild's) plus each of its roles. */
export function discordBasePermissions(input: { guildId: string; ownerId: string; userId: string; roles: DiscordRole[]; memberRoleIds: string[] }): bigint {
  if (input.ownerId === input.userId) return ALL_PERMISSIONS;
  const byId = new Map(input.roles.map((r) => [r.id, toBig(r.permissions)]));
  let p = byId.get(input.guildId) ?? 0n;
  for (const id of input.memberRoleIds) p |= byId.get(id) ?? 0n;
  return (p & DISCORD_PERMISSION.ADMINISTRATOR) === DISCORD_PERMISSION.ADMINISTRATOR ? ALL_PERMISSIONS : p;
}

/** Discord's documented overwrite order: @everyone, then every role of the member together, then the member. */
export function discordChannelPermissions(base: bigint, input: { guildId: string; userId: string; memberRoleIds: string[]; overwrites: DiscordOverwrite[] }): bigint {
  if ((base & DISCORD_PERMISSION.ADMINISTRATOR) === DISCORD_PERMISSION.ADMINISTRATOR) return ALL_PERMISSIONS;
  let p = base;
  const everyone = input.overwrites.find((o) => o.id === input.guildId);
  if (everyone) p = (p & ~toBig(everyone.deny)) | toBig(everyone.allow);
  let allow = 0n;
  let deny = 0n;
  const roles = new Set(input.memberRoleIds);
  for (const o of input.overwrites) {
    if (o.type === 0 && roles.has(o.id)) {
      allow |= toBig(o.allow);
      deny |= toBig(o.deny);
    }
  }
  p = (p & ~deny) | allow;
  const member = input.overwrites.find((o) => o.type === 1 && o.id === input.userId);
  if (member) p = (p & ~toBig(member.deny)) | toBig(member.allow);
  return p;
}

// ─── Identifiers, channel kinds ──────────────────────────────────────────────

/** A Discord snowflake: a 64-bit integer written in decimal. */
export const snowflake = z.string().regex(/^\d{15,21}$/, "Not a Discord id");

/** Channel types Growthdesk lists: categories, and the two kinds a bot can post a message into. */
export const DISCORD_CHANNEL_TYPES = { text: 0, category: 4, announcement: 5 } as const;
export type DiscordChannelKind = "text" | "announcement" | "category";

/** Text channel names: Discord lowercases them and turns spaces into dashes; we do the same so the preview is honest. */
export const normalizeDiscordChannelName = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}_-]/gu, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 100);

// ─── Limits ──────────────────────────────────────────────────────────────────

/** https://discord.com/developers/docs/resources/message#embed-object-embed-limits */
export const DISCORD_LIMITS = {
  content: 2000,
  title: 256,
  description: 4096,
  fields: 25,
  fieldName: 256,
  fieldValue: 1024,
  footer: 2048,
  author: 256,
  /** All the embed's text together. */
  embedTotal: 6000,
  buttons: 5,
  buttonLabel: 80,
  url: 512,
} as const;

// ─── Templates ───────────────────────────────────────────────────────────────

const tpl = (max: number) => z.string().max(max).default("");
const hexColor = z.string().regex(/^#?[0-9a-fA-F]{6}$/, "Use a hex colour such as #5865F2");

export const DiscordEmbedFieldInput = z.object({
  name: z.string().trim().min(1, "Required").max(DISCORD_LIMITS.fieldName),
  value: z.string().min(1, "Required").max(DISCORD_LIMITS.fieldValue),
  inline: z.boolean().default(false),
});

export const DiscordButtonInput = z.object({
  label: z.string().trim().min(1, "Required").max(DISCORD_LIMITS.buttonLabel),
  url: z.string().trim().min(1, "Required").max(DISCORD_LIMITS.url),
});

/** What a missing variable (no value, no fallback) does: leave it blank, or hold the message back. */
export const DISCORD_MISSING_MODES = ["blank", "skip"] as const;

export const DiscordTemplateBody = z.object({
  content: tpl(DISCORD_LIMITS.content),
  embed: z
    .object({
      enabled: z.boolean().default(true),
      title: tpl(DISCORD_LIMITS.title),
      url: tpl(DISCORD_LIMITS.url),
      description: tpl(DISCORD_LIMITS.description),
      color: z.union([hexColor, z.literal("")]).default("#5865F2"),
      author: tpl(DISCORD_LIMITS.author),
      footer: tpl(DISCORD_LIMITS.footer),
      timestamp: z.boolean().default(true),
      fields: z.array(DiscordEmbedFieldInput).max(DISCORD_LIMITS.fields).default([]),
    })
    .default({ enabled: true, title: "", url: "", description: "", color: "#5865F2", author: "", footer: "", timestamp: true, fields: [] }),
  buttons: z.array(DiscordButtonInput).max(DISCORD_LIMITS.buttons).default([]),
  /** Drop embed fields whose value renders empty instead of showing a blank field. */
  omitEmptyFields: z.boolean().default(true),
  missing: z.enum(DISCORD_MISSING_MODES).default("blank"),
});
export type DiscordTemplateBodyT = z.infer<typeof DiscordTemplateBody>;

export const DiscordTemplateInput = DiscordTemplateBody.extend({
  name: z.string().trim().min(1, "Required").max(120),
  description: z.string().trim().max(500).default(""),
});

/**
 * The template a rule uses when it names none: the event's name, the contact
 * and deal it concerns when there is one, and a button into Growthdesk. Every
 * value is optional, so it renders for any event.
 */
export const DEFAULT_DISCORD_TEMPLATE: DiscordTemplateBodyT = {
  content: "",
  embed: {
    enabled: true,
    title: "{{event.label}}",
    url: "{{event.link}}",
    description: "{{contact.fullName}}",
    color: "#5865F2",
    author: "{{workspace.name}}",
    footer: "{{event.type}}",
    timestamp: true,
    fields: [
      { name: "Company", value: "{{contact.company.name}}", inline: true },
      { name: "Email", value: "{{contact.email}}", inline: true },
      { name: "Owner", value: "{{contact.owner.name}}", inline: true },
      { name: "Deal", value: "{{deal.title}}", inline: true },
      { name: "Stage", value: "{{deal.stage}}", inline: true },
      { name: "Value", value: "{{deal.valueFormatted}}", inline: true },
      { name: "By", value: "{{event.actor.name}}", inline: true },
    ],
  },
  buttons: [{ label: "Open in Growthdesk", url: "{{event.link}}" }],
  omitEmptyFields: true,
  missing: "blank",
};

// ─── Rules, destinations, settings ──────────────────────────────────────────

/** An event type as the outbox writes it ("deal.won"). */
export const discordEventType = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/, "Unknown event");
/** A variable path in a template or condition ("contact.company.name", "payload.toStage"). */
export const DISCORD_PATH = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_-]+){0,6}$/;

export const DISCORD_CONDITION_OPS = ["is", "is_not", "contains", "not_contains", "gt", "lt", "exists", "not_exists"] as const;
export type DiscordConditionOp = (typeof DISCORD_CONDITION_OPS)[number];
export const DISCORD_CONDITION_OP_LABELS: Record<DiscordConditionOp, string> = {
  is: "is",
  is_not: "is not",
  contains: "contains",
  not_contains: "does not contain",
  gt: "is greater than",
  lt: "is less than",
  exists: "has a value",
  not_exists: "is empty",
};

export const DiscordConditionInput = z.object({
  field: z.string().trim().regex(DISCORD_PATH, "Not a field path"),
  op: z.enum(DISCORD_CONDITION_OPS),
  value: z.string().trim().max(200).default(""),
});
export type DiscordCondition = z.infer<typeof DiscordConditionInput>;

export const DiscordRuleInput = z.object({
  name: z.string().trim().min(1, "Required").max(120),
  events: z.array(discordEventType).min(1, "Choose at least one event").max(50),
  destinationIds: z.array(z.string().uuid()).min(1, "Choose at least one channel").max(10),
  /** null = the default template. */
  templateId: z.string().uuid().nullable().default(null),
  conditions: z.array(DiscordConditionInput).max(10).default([]),
  enabled: z.boolean().default(false),
});

export const DiscordDestinationInput = z.object({
  connectionId: z.string().uuid(),
  channelId: snowflake,
  /** A label to organise destinations by ("Sales", "Alerts"); "" = ungrouped. */
  group: z.string().trim().max(60).default(""),
});
export const DiscordDestinationPatch = z.object({ group: z.string().trim().max(60) });

export const DiscordCreateChannelInput = z.object({
  kind: z.enum(["text", "category"]),
  name: z.string().trim().min(1, "Required").max(100),
  /** The category to create a text channel in. */
  parentId: snowflake.nullable().default(null),
  /** Also save the new text channel as a destination, in this group. */
  addAsDestination: z.boolean().default(false),
  group: z.string().trim().max(60).default(""),
});
export const DiscordRenameChannelInput = z.object({ name: z.string().trim().min(1, "Required").max(100) });

/** What happens to an event no enabled rule asks for. */
export const DISCORD_UNROUTED_MODES = ["ignore", "log", "fallback"] as const;
export type DiscordUnroutedMode = (typeof DISCORD_UNROUTED_MODES)[number];
export const DiscordSettingsInput = z
  .object({
    unrouted: z.enum(DISCORD_UNROUTED_MODES),
    fallbackDestinationId: z.string().uuid().nullable().default(null),
  })
  .refine((s) => s.unrouted !== "fallback" || s.fallbackDestinationId, { message: "Choose the fallback channel", path: ["fallbackDestinationId"] });

export const DiscordConnectStartInput = z.object({ manageChannels: z.boolean().default(true) });
export const DiscordDisconnectInput = z.object({ leaveServer: z.boolean().default(false) });

/** A trial run of a rule (saved, or the form's unsaved draft) against one real or sample event. */
export const DiscordRuleTestInput = z.object({
  eventType: discordEventType,
  /** A real event to test against; omitted = the latest of that type, else a sample. */
  eventId: z.string().uuid().optional(),
  templateId: z.string().uuid().nullable().default(null),
  template: DiscordTemplateBody.optional(),
  conditions: z.array(DiscordConditionInput).max(10).default([]),
  /** Post the result to these destinations, marked as a test. Empty = only render and evaluate. */
  destinationIds: z.array(z.string().uuid()).max(10).default([]),
});

export const DISCORD_DELIVERY_STATUSES = ["pending", "sent", "failed", "filtered", "skipped", "canceled"] as const;
export type DiscordDeliveryStatus = (typeof DISCORD_DELIVERY_STATUSES)[number];
export const DiscordDeliveriesQuery = z.object({
  status: z.enum(DISCORD_DELIVERY_STATUSES).optional(),
  ruleId: z.string().uuid().optional(),
  destinationId: z.string().uuid().optional(),
  eventType: discordEventType.optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// ─── Variables ───────────────────────────────────────────────────────────────

const TOKEN = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_-]+){0,6})\s*(?:\|\s*([^}]*?))?\s*\}\}/g;

export type DiscordToken = { path: string; fallback: string | null; raw: string };

export function discordTokens(text: string): DiscordToken[] {
  const out: DiscordToken[] = [];
  for (const m of text.matchAll(TOKEN)) out.push({ path: m[1]!, fallback: m[2] === undefined ? null : m[2], raw: m[0] });
  return out;
}

/** A value at a dotted path; arrays can be indexed ("tags.0"). */
export function discordPathValue(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const part of path.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const i = Number(part);
      cur = Number.isInteger(i) ? cur[i] : undefined;
    } else if (typeof cur === "object") {
      cur = Object.prototype.hasOwnProperty.call(cur, part) ? (cur as Record<string, unknown>)[part] : undefined;
    } else return undefined;
  }
  return cur;
}

/** Text for a value: lists joined, objects as compact JSON, empty for nothing. */
export function discordValueText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(discordValueText).filter(Boolean).join(", ");
  try {
    return JSON.stringify(v);
  } catch {
    return "";
  }
}

/** Every leaf path in a context, with an example value: what the editor offers to insert. */
export function discordContextPaths(root: unknown, prefix = "", depth = 0, out: { path: string; example: string }[] = []): { path: string; example: string }[] {
  if (depth > 6 || root === null || root === undefined) return out;
  if (typeof root !== "object" || Array.isArray(root) || root instanceof Date) {
    if (prefix) out.push({ path: prefix, example: discordValueText(root).slice(0, 120) });
    return out;
  }
  for (const [k, v] of Object.entries(root as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9_-]+$/.test(k)) continue;
    discordContextPaths(v, prefix ? `${prefix}.${k}` : k, depth + 1, out);
  }
  return out;
}

// ─── Safe text ───────────────────────────────────────────────────────────────

const ZWSP = "​";

/**
 * Makes a value from the event (a contact's name, a reply's subject — text
 * anyone outside the workspace may have typed) inert in Discord: markdown is
 * escaped so it cannot restyle the message or forge a link, and mention
 * syntax is broken so it cannot ping (allowed_mentions blocks pings anyway).
 */
export function escapeDiscordMarkdown(value: string): string {
  return neutralizeMentions(value.replace(/([\\*_~`|>#[\]()<:-])/g, "\\$1"));
}

/** @everyone, @here and <@…>, <@&…>, <#…> stop being mentions; nothing else changes. */
export function neutralizeMentions(value: string): string {
  return neutralizeMassMentions(value).replace(/<(@[!&]?|#)(\d)/g, `<${ZWSP}$1$2`);
}

/**
 * For the admin's own template text: @everyone / @here are broken up (they
 * would read as an alert even unpinged); a deliberate <@id> stays, shown as a
 * mention but — like everything else — never pinging (allowed_mentions).
 */
export const neutralizeMassMentions = (value: string) => value.replace(/@(everyone|here)/gi, `@${ZWSP}$1`);

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** Only absolute http(s) URLs survive; anything else (javascript:, relative, too long) is dropped. */
export function safeDiscordUrl(value: string): string {
  const v = value.trim();
  if (!v || v.length > DISCORD_LIMITS.url) return "";
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : "";
  } catch {
    return "";
  }
}

// ─── Rendering ───────────────────────────────────────────────────────────────

export type DiscordEmbed = {
  title?: string;
  url?: string;
  description?: string;
  color?: number;
  author?: { name: string };
  footer?: { text: string };
  timestamp?: string;
  fields?: { name: string; value: string; inline: boolean }[];
};

/** The body of POST /channels/{id}/messages, less the nonce the sender adds. */
export type DiscordMessage = {
  content: string;
  embeds: DiscordEmbed[];
  components: { type: 1; components: { type: 2; style: 5; label: string; url: string }[] }[];
  allowed_mentions: { parse: [] };
};

export type DiscordRenderResult = {
  message: DiscordMessage;
  /** Variables with no value and no fallback. */
  missing: string[];
  /** The message is empty, or `missing: "skip"` and something is missing: do not send. */
  skip: string | null;
  /** Text that was cut to fit Discord's limits. */
  truncated: string[];
};

type Mode = "markdown" | "plain" | "url";

function fill(text: string, ctx: unknown, mode: Mode, missing: Set<string>): string {
  return text.replace(TOKEN, (_raw, path: string, fallback: string | undefined) => {
    let value = discordValueText(discordPathValue(ctx, path)).trim();
    if (!value) {
      if (fallback !== undefined) value = fallback;
      else missing.add(path);
    }
    if (mode === "url") return value;
    return mode === "markdown" ? escapeDiscordMarkdown(value) : neutralizeMentions(value);
  });
}

const colorInt = (hex: string) => (hex ? parseInt(hex.replace(/^#/, ""), 16) : undefined);

/**
 * Renders a template against an event's context. Admin-written text is kept
 * as written (it may use markdown on purpose); values from the event are
 * escaped; every piece is cut to Discord's limits; no mention can ping.
 */
export function renderDiscordMessage(template: DiscordTemplateBodyT, ctx: unknown, now: Date = new Date()): DiscordRenderResult {
  const missing = new Set<string>();
  const truncated: string[] = [];
  const cut = (what: string, s: string, max: number) => {
    if (s.length > max) truncated.push(what);
    return clip(s, max);
  };

  const content = cut("content", neutralizeMassMentions(fill(template.content, ctx, "markdown", missing)).trim(), DISCORD_LIMITS.content);
  const embeds: DiscordEmbed[] = [];
  const e = template.embed;
  if (e.enabled) {
    const embed: DiscordEmbed = {};
    const title = cut("title", neutralizeMassMentions(fill(e.title, ctx, "plain", missing)).trim(), DISCORD_LIMITS.title);
    if (title) embed.title = title;
    const url = safeDiscordUrl(fill(e.url, ctx, "url", missing));
    if (url && title) embed.url = url;
    const description = cut("description", neutralizeMassMentions(fill(e.description, ctx, "markdown", missing)).trim(), DISCORD_LIMITS.description);
    if (description) embed.description = description;
    const color = colorInt(e.color);
    if (color !== undefined) embed.color = color;
    const author = cut("author", fill(e.author, ctx, "plain", missing).trim(), DISCORD_LIMITS.author);
    if (author) embed.author = { name: author };
    const footer = cut("footer", fill(e.footer, ctx, "plain", missing).trim(), DISCORD_LIMITS.footer);
    if (footer) embed.footer = { text: footer };
    if (e.timestamp) embed.timestamp = (discordPathValue(ctx, "event.occurredAt") as string | undefined) ?? now.toISOString();
    const fields = [];
    for (const f of e.fields.slice(0, DISCORD_LIMITS.fields)) {
      const name = cut(`field "${f.name}"`, neutralizeMassMentions(fill(f.name, ctx, "plain", missing)).trim(), DISCORD_LIMITS.fieldName);
      const value = cut(`field "${f.name}"`, neutralizeMassMentions(fill(f.value, ctx, "markdown", missing)).trim(), DISCORD_LIMITS.fieldValue);
      if (!value && template.omitEmptyFields) continue;
      fields.push({ name: name || "​", value: value || "​", inline: f.inline });
    }
    if (fields.length) embed.fields = fields;
    // The whole embed's text has its own ceiling: shorten the description first, then drop fields from the end.
    const total = () => (embed.title?.length ?? 0) + (embed.description?.length ?? 0) + (embed.author?.name.length ?? 0) + (embed.footer?.text.length ?? 0) + (embed.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0);
    if (total() > DISCORD_LIMITS.embedTotal && embed.description) {
      truncated.push("embed");
      embed.description = clip(embed.description, Math.max(1, embed.description.length - (total() - DISCORD_LIMITS.embedTotal)));
    }
    while (total() > DISCORD_LIMITS.embedTotal && embed.fields?.length) {
      embed.fields.pop();
      if (!truncated.includes("embed")) truncated.push("embed");
    }
    if (Object.keys(embed).some((k) => k !== "color" && k !== "timestamp")) embeds.push(embed);
  }

  const buttons = template.buttons
    .slice(0, DISCORD_LIMITS.buttons)
    .map((b) => ({ label: clip(fill(b.label, ctx, "plain", missing).trim(), DISCORD_LIMITS.buttonLabel), url: safeDiscordUrl(fill(b.url, ctx, "url", missing)) }))
    .filter((b) => b.label && b.url);

  const message: DiscordMessage = {
    content,
    embeds,
    components: buttons.length ? [{ type: 1, components: buttons.map((b) => ({ type: 2 as const, style: 5 as const, label: b.label, url: b.url })) }] : [],
    allowed_mentions: { parse: [] },
  };
  const list = [...missing].sort();
  let skip: string | null = null;
  if (!content && !embeds.length) skip = "The template rendered an empty message";
  else if (template.missing === "skip" && list.length) skip = `Missing ${list.map((m) => `{{${m}}}`).join(", ")}`;
  return { message, missing: list, skip, truncated: [...new Set(truncated)] };
}

export type DiscordTemplateIssues = { errors: Record<string, string>; warnings: string[] };

/**
 * Checks a template before it is saved: something to send, valid colours and
 * URLs, and variables the event can provide. `knownPaths` (from the field
 * catalogue) turns unknown variables into warnings; a variable with a
 * fallback is never a problem.
 */
export function validateDiscordTemplate(template: DiscordTemplateBodyT, knownPaths?: Iterable<string>): DiscordTemplateIssues {
  const errors: Record<string, string> = {};
  const warnings: string[] = [];
  const e = template.embed;
  if (!template.content.trim() && !(e.enabled && (e.title.trim() || e.description.trim() || e.fields.length))) errors.content = "Write a message, or an embed with a title, description or fields";
  const urlOk = (s: string) => !s.trim() || discordTokens(s).length > 0 || Boolean(safeDiscordUrl(s));
  if (e.enabled && !urlOk(e.url)) errors["embed.url"] = "Use an http(s) link or a variable";
  template.buttons.forEach((b, i) => {
    if (!urlOk(b.url) || !b.url.trim()) errors[`buttons.${i}.url`] = "Use an http(s) link or a variable";
  });
  if (/@(everyone|here)/i.test(template.content + e.title + e.description)) warnings.push("@everyone and @here are shown as text: Growthdesk never pings from Discord notifications.");

  const texts = [template.content, e.title, e.url, e.description, e.author, e.footer, ...e.fields.flatMap((f) => [f.name, f.value]), ...template.buttons.flatMap((b) => [b.label, b.url])];
  const known = knownPaths ? new Set(knownPaths) : null;
  const unknown = new Set<string>();
  for (const t of texts) {
    for (const tok of discordTokens(t)) {
      if (known && tok.fallback === null && !known.has(tok.path) && ![...known].some((k) => k.startsWith(`${tok.path}.`))) unknown.add(tok.path);
    }
    const open = (t.match(/\{\{/g) ?? []).length;
    if (open !== discordTokens(t).length) warnings.push(`"${clip(t, 40)}" has a {{ … }} that is not a variable; it is sent as written.`);
  }
  if (unknown.size) warnings.push(`Not provided by every chosen event: ${[...unknown].map((p) => `{{${p}}}`).join(", ")}. Add a fallback ({{path|text}}) or they render blank.`);
  return { errors, warnings: [...new Set(warnings)] };
}

// ─── Conditions ──────────────────────────────────────────────────────────────

const norm = (v: unknown) => discordValueText(v).trim().toLowerCase();
const num = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
};

export function testDiscordCondition(c: DiscordCondition, ctx: unknown): boolean {
  const actual = discordPathValue(ctx, c.field);
  const expected = c.value.trim().toLowerCase();
  const list = Array.isArray(actual) ? actual : null;
  switch (c.op) {
    case "exists":
      return list ? list.length > 0 : norm(actual) !== "";
    case "not_exists":
      return list ? list.length === 0 : norm(actual) === "";
    case "is":
      return list ? list.some((a) => norm(a) === expected) : actual !== undefined && actual !== null && norm(actual) === expected;
    case "is_not":
      return list ? !list.some((a) => norm(a) === expected) : norm(actual) !== expected;
    case "contains":
      return list ? list.some((a) => norm(a).includes(expected)) : norm(actual).includes(expected);
    case "not_contains":
      return list ? !list.some((a) => norm(a).includes(expected)) : !norm(actual).includes(expected);
    case "gt":
    case "lt": {
      const a = num(actual);
      const b = num(c.value);
      if (a === null || b === null) return false;
      return c.op === "gt" ? a > b : a < b;
    }
  }
}

/** All must hold. Returns the first that does not, for the delivery log. */
export function evaluateDiscordConditions(conditions: DiscordCondition[], ctx: unknown): { met: boolean; failed: DiscordCondition | null } {
  for (const c of conditions) if (!testDiscordCondition(c, ctx)) return { met: false, failed: c };
  return { met: true, failed: null };
}

export const describeDiscordCondition = (c: DiscordCondition) =>
  `${c.field} ${DISCORD_CONDITION_OP_LABELS[c.op]}${c.op === "exists" || c.op === "not_exists" ? "" : ` "${c.value}"`}`;

// ─── Delivery ────────────────────────────────────────────────────────────────

/**
 * The nonce sent with a delivery (≤ 25 characters). With enforce_nonce, Discord
 * returns the earlier message instead of posting again when a retry repeats a
 * send that had in fact gone through (within its nonce window of a few minutes).
 */
export const discordNonce = (deliveryId: string) => deliveryId.replace(/-/g, "").slice(-25);

/** Retry delays after a retryable failure (attempt 1 failed → wait the first). Then the delivery fails. */
export const DISCORD_RETRY_DELAYS_MS = [15_000, 60_000, 5 * 60_000, 20 * 60_000, 60 * 60_000] as const;
export const DISCORD_MAX_ATTEMPTS = DISCORD_RETRY_DELAYS_MS.length + 1;

/** "deal.stage_changed" → "Deal stage changed". */
export const discordEventLabel = (type: string) => {
  const s = type.replace(/[._]/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
};
