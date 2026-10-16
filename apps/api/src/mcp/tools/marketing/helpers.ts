import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ALL_EMAIL_BLOCK_TYPES, ContactFilter, EmailBlocks, isUnlimited, type EmailBlock as EmailBlockT, type EmailBlockType } from "@growthdesk/shared";
import { parseWith } from "../../../common/decorators.js";
import { badRequest } from "../../../common/errors.js";
import { ContactsService } from "../../../crm/contacts.service.js";
import { EntitlementsService } from "../../../billing/entitlements.service.js";
import type { McpCtx, McpDeps } from "../../tool.js";

/*
 * Pure helpers and small lookups shared by the marketing MCP tools
 * (marketing.tools.ts). The pure parts are unit-tested in helpers.spec.ts.
 */

export const shortId = () => randomUUID().slice(0, 8);

/* ─── People to add/remove ─────────────────────────────────────────────────── */

/** add_to_list takes at most this many people; more goes through bulk_add_to_list, which asks the user first. */
export const ADD_TO_LIST_MAX = 200;
/** The most one list call takes (ListMembersAdd / ListMembersRemove). */
export const LIST_BATCH_MAX = 5000;

/** Why a resolved set of people is the wrong size for this tool, or null when it fits. */
export function addSizeTrouble(count: number, tool: "add_to_list" | "bulk_add_to_list"): string | null {
  if (count === 0) return "No contacts matched. Check the ids, emails or filter (contacts must already exist — create them first).";
  if (count > LIST_BATCH_MAX) return `That is ${count} contacts; one call takes at most ${LIST_BATCH_MAX}. Narrow the filter or split the batch.`;
  if (tool === "add_to_list" && count > ADD_TO_LIST_MAX) {
    return `That is ${count} contacts — add_to_list takes at most ${ADD_TO_LIST_MAX}. Use bulk_add_to_list, which shows the user what will happen and asks for approval first.`;
  }
  return null;
}

/** Who to add or remove: any mix of contact ids, email addresses and a contact filter. */
export const peopleInput = {
  contactIds: z.array(z.string().uuid()).max(LIST_BATCH_MAX).optional().describe("Contact ids (from the contact tools or list_list_members)."),
  emails: z.array(z.string().max(320)).max(LIST_BATCH_MAX).optional().describe("Email addresses of existing contacts (matched on any address a contact has). Unknown addresses are reported, not created."),
  filter: ContactFilter.optional().describe("A contact filter, e.g. { tag: [\"vip\"] }, { stage: [\"lead\"] }, { companyId }, { leadSource }, { q }. Everyone matching is included."),
};

export type PeopleArgs = { contactIds?: string[]; emails?: string[]; filter?: z.infer<typeof ContactFilter> };

export type ResolvedPeople = { contactIds: string[]; unknownEmails: string[]; invalidEmails: string[] };

/** Contact ids for ids + emails + filter (deduplicated), through ContactsService.resolve, which applies the person's record scope. */
export async function resolvePeople(ctx: McpCtx, deps: McpDeps, args: PeopleArgs): Promise<ResolvedPeople> {
  const hasEmails = Boolean(args.emails?.some((e) => e.trim()));
  if (!args.contactIds?.length && !hasEmails && !args.filter) throw badRequest("Say who: give contactIds, emails or a filter.");
  const ids = new Set(args.contactIds ?? []);
  const out: ResolvedPeople = { contactIds: [], unknownEmails: [], invalidEmails: [] };
  const contacts = deps.get(ContactsService);
  if (hasEmails) {
    const r = await contacts.resolve(ctx, { emails: args.emails });
    if (r.capped) throw badRequest(`More than ${LIST_BATCH_MAX} contacts matched. Split the batch.`);
    r.contacts.forEach((c) => ids.add(c.id));
    out.unknownEmails = r.unknownEmails;
    out.invalidEmails = r.invalid;
  }
  if (args.filter) {
    const r = await contacts.resolve(ctx, { filter: args.filter });
    if (r.capped) throw badRequest(`More than ${LIST_BATCH_MAX} contacts match that filter. Narrow it.`);
    r.contacts.forEach((c) => ids.add(c.id));
  }
  if (ids.size > LIST_BATCH_MAX) throw badRequest(`That is ${ids.size} contacts; one call takes at most ${LIST_BATCH_MAX}. Split the batch.`);
  out.contactIds = [...ids];
  return out;
}

/* ─── Scheduling ───────────────────────────────────────────────────────────── */

/** The earliest a schedule may be set for. The service sends at once for anything within a minute, so leave room. */
export const MIN_SCHEDULE_LEAD_MS = 2 * 60_000;
const MAX_SCHEDULE_AHEAD_MS = 366 * 24 * 60 * 60_000;

/** Why `at` cannot be a schedule time (checked when preparing), or null. */
export function scheduleTrouble(at: Date, now = new Date()): string | null {
  if (Number.isNaN(at.getTime())) return "That is not a valid date and time.";
  if (at.getTime() < now.getTime() + MIN_SCHEDULE_LEAD_MS) return "Pick a time at least 2 minutes from now, or use send_marketing_campaign_now to send at once.";
  if (at.getTime() > now.getTime() + MAX_SCHEDULE_AHEAD_MS) return "Pick a time within the next year.";
  return null;
}

/**
 * Whether a confirmed schedule may still go ahead: the service would send
 * immediately for a time within a minute, which is not what the user approved.
 */
export const scheduleStillValid = (at: Date, now = new Date()) => at.getTime() > now.getTime() + 61_000;

/** "Tuesday, October 20, 2026 at 9:00 AM (America/New_York)". Falls back to UTC for an unknown zone. */
export function inZone(at: Date | string | null | undefined, timeZone: string): string | null {
  if (!at) return null;
  const d = typeof at === "string" ? new Date(at) : at;
  try {
    return `${new Intl.DateTimeFormat("en-US", { timeZone, dateStyle: "full", timeStyle: "short" }).format(d)} (${timeZone})`;
  } catch {
    return `${d.toISOString()} (UTC)`;
  }
}

/* ─── Blocks ───────────────────────────────────────────────────────────────── */

/** A block as the model sends it: a type and its fields; `id` may be left out (one is made). */
export const looseBlock = z
  .object({ type: z.enum(ALL_EMAIL_BLOCK_TYPES.map((t) => t.type) as [EmailBlockType, ...EmailBlockType[]]), id: z.string().max(40).optional() })
  .catchall(z.unknown())
  .describe("One email block: { type, ...fields }. See get_design_block_reference for each type's fields. id is optional on new blocks.");

/** Validates loose blocks with the shared EmailBlocks schema, giving each block without an id a fresh one. */
export function normalizeBlocks(raw: readonly Record<string, unknown>[], makeId: () => string = shortId): EmailBlockT[] {
  const withIds = raw.map((b) => ({ ...b, id: typeof b.id === "string" && b.id.trim() ? b.id : makeId() }));
  const ids = withIds.map((b) => b.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) throw badRequest(`Two blocks share the id "${dup}". Block ids must be unique.`, { blocks: `Duplicate id ${dup}` });
  return parseWithPrefix(EmailBlocks, withIds, "blocks");
}

function parseWithPrefix<T extends z.ZodType>(schema: T, value: unknown, prefix: string): z.output<T> {
  try {
    return parseWith(schema, value);
  } catch (e) {
    const err = e as { fields?: Record<string, string>; message: string };
    if (!err.fields) throw e;
    const fields = Object.fromEntries(Object.entries(err.fields).map(([k, v]) => [k === "_" ? prefix : `${prefix}.${k}`, v]));
    const first = Object.entries(fields)[0]!;
    throw badRequest(`${first[0]}: ${first[1]}`, fields);
  }
}

const where = { afterId: z.string().max(40).optional(), beforeId: z.string().max(40).optional(), position: z.enum(["start", "end"]).optional() };

/** Partial edits to a design's blocks, applied in order. */
export const BlockOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("update"), id: z.string().max(40).describe("The block to change."), fields: z.record(z.string(), z.unknown()).describe("Fields to set on it, e.g. { text: \"…\" } or { url: \"https://…\" }. Its type cannot change.") }),
  z.object({ op: z.literal("replace"), id: z.string().max(40), block: looseBlock }),
  z.object({ op: z.literal("insert"), block: looseBlock, ...where }).describe("Inserts after afterId, before beforeId, or at position start/end (default end)."),
  z.object({ op: z.literal("remove"), id: z.string().max(40) }),
  z.object({ op: z.literal("move"), id: z.string().max(40), ...where }),
]);
export type BlockOpT = z.infer<typeof BlockOp>;

function placeAt(list: Record<string, unknown>[], block: Record<string, unknown>, at: { afterId?: string; beforeId?: string; position?: "start" | "end" }, n: number) {
  const indexOf = (id: string) => {
    const i = list.findIndex((b) => b.id === id);
    if (i < 0) throw badRequest(`Operation ${n}: there is no block "${id}".`);
    return i;
  };
  if (at.afterId) list.splice(indexOf(at.afterId) + 1, 0, block);
  else if (at.beforeId) list.splice(indexOf(at.beforeId), 0, block);
  else if (at.position === "start") list.unshift(block);
  else list.push(block);
}

/** Applies block operations to a design's blocks; the result is validated as a whole. */
export function applyBlockOps(blocks: readonly EmailBlockT[], ops: readonly BlockOpT[], makeId: () => string = shortId): EmailBlockT[] {
  const list: Record<string, unknown>[] = blocks.map((b) => ({ ...b }));
  ops.forEach((op, i) => {
    const n = i + 1;
    const find = (id: string) => {
      const at = list.findIndex((b) => b.id === id);
      if (at < 0) throw badRequest(`Operation ${n} (${op.op}): there is no block "${id}". Call get_design for the block ids.`);
      return at;
    };
    switch (op.op) {
      case "update": {
        const at = find(op.id);
        const { id: _id, type: _type, ...fields } = op.fields;
        list[at] = { ...list[at], ...fields };
        break;
      }
      case "replace": {
        const at = find(op.id);
        list[at] = { ...op.block, id: op.block.id ?? op.id };
        break;
      }
      case "insert":
        placeAt(list, { ...op.block, id: op.block.id ?? makeId() }, op, n);
        break;
      case "remove":
        list.splice(find(op.id), 1);
        break;
      case "move": {
        const [block] = list.splice(find(op.id), 1);
        placeAt(list, block!, op, n);
        break;
      }
    }
  });
  return normalizeBlocks(list, makeId);
}

/** One line per block — what the model needs to find a block by id without the whole JSON. */
export function outline(blocks: readonly EmailBlockT[]) {
  const cut = (s: string) => (s.length > 80 ? `${s.slice(0, 77)}…` : s);
  return blocks.map((b) => {
    const gist =
      b.type === "heading" || b.type === "text" || b.type === "quote" ? b.text
      : b.type === "button" ? `${b.label} → ${b.url}`
      : b.type === "image" ? b.src || "(no image yet)"
      : b.type === "hero" ? b.title || b.text
      : b.type === "callout" ? b.title || b.text
      : b.type === "header" ? b.brand || b.logo
      : b.type === "columns" ? b.items.map((it) => it.title).join(" | ")
      : b.type === "list" ? b.items.join(" | ")
      : b.type === "social" ? b.links.map((l) => l.network).join(", ")
      : b.type === "spacer" ? `${b.height}px`
      : "";
    return { id: b.id, type: b.type, gist: cut(gist.replace(/\s+/g, " ").trim()) };
  });
}

/* ─── Allowances ───────────────────────────────────────────────────────────── */

/** This month's marketing email allowance: used, limit (null = unlimited), left, and when it renews. */
export async function emailAllowance(ctx: McpCtx, deps: McpDeps) {
  const ent = deps.get(EntitlementsService);
  const account = ctx.workspace.billingAccountId;
  const [e, used, meter] = await Promise.all([ent.forAccount(account), ent.usage(account, "monthlyMarketingEmails"), ent.meterPeriodFor(account)]);
  const limit = e.limits.monthlyMarketingEmails;
  const unlimited = isUnlimited(limit);
  return { used, limit: unlimited ? null : limit, left: unlimited ? null : Math.max(0, limit - used), renewsAt: meter.resetsAt };
}

/** A sentence about the allowance for a send of `recipients` emails, for previews. */
export function allowanceLine(a: { left: number | null; limit: number | null }, recipients: number): string {
  if (a.left === null) return "The plan has no monthly limit on marketing emails.";
  if (recipients > a.left) {
    return `WARNING: only ${a.left.toLocaleString()} of ${a.limit!.toLocaleString()} marketing emails are left this month — sending pauses when they run out (the rest wait for the renewal or an upgrade).`;
  }
  return `Uses ${recipients.toLocaleString()} of the ${a.left.toLocaleString()} marketing emails left this month (plan: ${a.limit!.toLocaleString()}/month).`;
}
