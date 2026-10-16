import { z } from "zod";
import { LIST_MEMBERSHIP_STATUSES, ListMembersAdd, MarketingListInput, isUnlimited, patchOf } from "@growthdesk/shared";
import { parseWith } from "../../../common/decorators.js";
import { badRequest } from "../../../common/errors.js";
import { ListsService, type AddResult } from "../../../marketing/lists.service.js";
import { EntitlementsService } from "../../../billing/entitlements.service.js";
import { defineTool, pageInput, paged, type McpCtx, type McpDeps } from "../../tool.js";
import { addSizeTrouble, peopleInput, resolvePeople, type PeopleArgs, type ResolvedPeople } from "./helpers.js";

/*
 * Marketing lists (shared with outreach as lead lists). Permissions are the
 * HTTP routes' own: marketing.read|contacts.read to look, marketing.write|
 * contacts.write to change (marketing.controller.ts).
 */

const READ = ["marketing.read", "contacts.read"] as const;
const WRITE = ["marketing.write", "contacts.write"] as const;

const listId = z.string().uuid().describe("The list's id (from list_lists).");

const consentInput = z
  .object({
    confirmed: z.literal(true),
    source: z.string().trim().min(1).max(200).describe("Where they gave consent, e.g. \"Signed up at the webinar\"."),
  })
  .optional()
  .describe(
    "Only when the user tells you these people agreed to receive marketing email: their consent is then recorded with this source. Without it, people without recorded consent join as leads and are left out of marketing sends (or, on a double opt-in list, are emailed a link to confirm).",
  );

const listView = (l: Awaited<ReturnType<ListsService["get"]>>) => ({
  id: l.id,
  name: l.name,
  description: l.description,
  doubleOptIn: l.doubleOptIn,
  archived: Boolean(l.archivedAt),
  members: l.counts,
});

function addOutcome(r: AddResult, resolved: ResolvedPeople, doubleOptIn: boolean) {
  const skipped = Object.fromEntries(Object.entries(r.skipped).filter(([, n]) => n > 0));
  return {
    added: r.added,
    pendingConfirmation: r.pending,
    alreadyMember: r.alreadyMember,
    skipped,
    ...(resolved.unknownEmails.length ? { unknownEmails: resolved.unknownEmails.slice(0, 50), unknownEmailCount: resolved.unknownEmails.length } : {}),
    ...(resolved.invalidEmails.length ? { invalidEmails: resolved.invalidEmails.slice(0, 50) } : {}),
    notes: [
      ...(r.pending && doubleOptIn ? [`${r.pending} people must confirm by email first (double opt-in); a confirmation link was emailed to them.`] : []),
      ...(skipped.suppressed ? ["Suppressed addresses are never added."] : []),
      ...(skipped.unsubscribed ? ["People who unsubscribed from this list are not re-added."] : []),
      ...(resolved.unknownEmails.length ? ["Unknown emails have no contact yet — create the contacts first, then add them."] : []),
    ],
  };
}

async function addPeople(ctx: McpCtx, deps: McpDeps, args: PeopleArgs & { listId: string; consent?: { confirmed: true; source: string } }, resolved: ResolvedPeople) {
  const lists = deps.get(ListsService);
  const list = await lists.get(ctx, args.listId);
  const body = parseWith(ListMembersAdd, { contactIds: resolved.contactIds, ...(args.consent ? { consent: args.consent } : {}) });
  const r = await lists.addMembers(ctx, args.listId, body);
  return { list: { id: list.id, name: list.name }, ...addOutcome(r, resolved, list.doubleOptIn) };
}

export const LIST_TOOLS = [
  defineTool({
    name: "list_lists",
    title: "List marketing lists",
    description: "Every marketing (lead) list with its member counts by status (subscribed / pending confirmation / unsubscribed) and whether it uses double opt-in. Archived lists only with includeArchived.",
    input: z.object({ includeArchived: z.boolean().default(false), ...pageInput }),
    permission: READ,
    risk: "read",
    handler: async (ctx, args, deps) => {
      const rows = await deps.get(ListsService).list(ctx, args.includeArchived);
      const start = (args.page - 1) * args.limit;
      return paged(rows.slice(start, start + args.limit).map(listView), rows.length, args.page, args.limit);
    },
  }),

  defineTool({
    name: "get_list",
    title: "Get a marketing list",
    description: "One list: name, description, double opt-in, archived, and member counts by status.",
    input: z.object({ listId }),
    permission: READ,
    risk: "read",
    handler: async (ctx, args, deps) => listView(await deps.get(ListsService).get(ctx, args.listId)),
  }),

  defineTool({
    name: "list_list_members",
    title: "List a list's members",
    description: "People on a list, newest first, with their membership status and consent. Filter by status or search by name/email.",
    input: z.object({ listId, status: z.enum(LIST_MEMBERSHIP_STATUSES).optional(), search: z.string().trim().max(200).optional(), ...pageInput }),
    permission: READ,
    risk: "read",
    handler: async (ctx, args, deps) => {
      const r = await deps.get(ListsService).members(ctx, args.listId, { page: args.page, pageSize: args.limit, status: args.status, q: args.search || undefined });
      return paged(
        r.items.map((m) => ({ contactId: m.contact.id, name: m.contact.fullName, email: m.contact.email, consent: m.contact.consentStatus, status: m.status, source: m.source, subscribedAt: m.subscribedAt })),
        r.total,
        args.page,
        args.limit,
      );
    },
  }),

  defineTool({
    name: "create_list",
    title: "Create a marketing list",
    description:
      "Creates a list. doubleOptIn: people added without recorded consent join as pending and are emailed a confirmation link — it needs a connected email service and a verified sending domain (see marketing_setup_status).",
    input: MarketingListInput,
    permission: WRITE,
    risk: "write",
    idempotent: false,
    handler: async (ctx, args, deps) => listView(await deps.get(ListsService).create(ctx, args)),
  }),

  defineTool({
    name: "update_list",
    title: "Update a marketing list",
    description: "Renames a list, changes its description, or turns double opt-in on/off. Only the fields given change.",
    input: z.object({ listId, ...patchOf(MarketingListInput).shape }),
    permission: WRITE,
    risk: "write",
    handler: async (ctx, { listId: id, ...patch }, deps) => {
      if (!Object.values(patch).some((v) => v !== undefined)) throw badRequest("Nothing to change: give name, description or doubleOptIn.");
      return listView(await deps.get(ListsService).update(ctx, id, patch));
    },
  }),

  defineTool({
    name: "archive_list",
    title: "Archive a marketing list",
    description: "Archives a list: it keeps its members and history but can no longer be sent to. Refused while a scheduled, sending or paused campaign uses it. restore_list undoes it.",
    input: z.object({ listId }),
    permission: WRITE,
    risk: "important",
    preview: async (ctx, args, deps) => {
      const l = await deps.get(ListsService).get(ctx, args.listId);
      if (l.archivedAt) throw badRequest(`"${l.name}" is already archived.`);
      return {
        summary: `Archive the list "${l.name}" (${l.counts.subscribed} subscribed, ${l.counts.pending} pending). Members and history are kept; the list can no longer be sent to until restored.`,
        details: { listId: l.id, name: l.name, members: l.counts },
      };
    },
    handler: async (ctx, args, deps) => listView(await deps.get(ListsService).archive(ctx, args.listId, true)),
  }),

  defineTool({
    name: "restore_list",
    title: "Restore an archived list",
    description: "Brings an archived list back, so campaigns can send to it again.",
    input: z.object({ listId }),
    permission: WRITE,
    risk: "write",
    handler: async (ctx, args, deps) => listView(await deps.get(ListsService).archive(ctx, args.listId, false)),
  }),

  defineTool({
    name: "add_to_list",
    title: "Add people to a list (up to 200)",
    description:
      "Adds existing contacts to a list — by contactIds, emails, and/or a contact filter (tag, stage, company…) — up to 200 people; for more use bulk_add_to_list. Suppressed people, those who refused consent and those who unsubscribed from this list are skipped. Returns added / alreadyMember / skipped (by reason) and unknown emails. On a double opt-in list it refuses when anyone would be emailed a confirmation link — use bulk_add_to_list then, so the user approves the emails first.",
    input: z.object({ listId, ...peopleInput, consent: consentInput }),
    permission: WRITE,
    risk: "write",
    idempotent: true,
    handler: async (ctx, args, deps) => {
      const resolved = await resolvePeople(ctx, deps, args);
      const trouble = addSizeTrouble(resolved.contactIds.length, "add_to_list");
      if (trouble) throw badRequest(trouble, { contactIds: trouble });
      // Emailing people (double opt-in confirmation links) is an important action: it needs the user's approval.
      if (!args.consent && resolved.contactIds.length) {
        const list = await deps.get(ListsService).get(ctx, args.listId);
        if (list.doubleOptIn) {
          const unconsented = await deps.prisma.db.contact.count({
            where: { workspaceId: ctx.workspace.id, id: { in: resolved.contactIds }, deletedAt: null, consentStatus: { not: "granted" } },
          });
          if (unconsented) {
            const msg = `"${list.name}" is a double opt-in list: ${unconsented} of these people would be emailed a confirmation link. Use bulk_add_to_list so the user can approve sending those emails.`;
            throw badRequest(msg, { listId: msg });
          }
        }
      }
      return addPeople(ctx, deps, args, resolved);
    },
  }),

  defineTool({
    name: "bulk_add_to_list",
    title: "Add many people to a list",
    description:
      "Like add_to_list for large batches (up to 5,000 people per call): resolves contactIds / emails / a contact filter, shows the user how many people would be added (and whether confirmation emails go out or consent is recorded), and adds them after approval.",
    input: z.object({ listId, ...peopleInput, consent: consentInput }),
    permission: WRITE,
    risk: "important",
    preview: async (ctx, args, deps) => {
      const list = await deps.get(ListsService).get(ctx, args.listId);
      if (list.archivedAt) throw badRequest("This list is archived. Restore it before adding people.");
      const resolved = await resolvePeople(ctx, deps, args);
      const trouble = addSizeTrouble(resolved.contactIds.length, "bulk_add_to_list");
      if (trouble) throw badRequest(trouble, { contactIds: trouble });
      const ids = resolved.contactIds;
      const db = deps.prisma.db;
      const w = ctx.workspace.id;
      const [members, consented] = await Promise.all([
        db.listMembership.groupBy({ by: ["status"], where: { workspaceId: w, listId: list.id, contactId: { in: ids } }, _count: { _all: true } }),
        db.contact.count({ where: { workspaceId: w, id: { in: ids }, deletedAt: null, consentStatus: "granted" } }),
      ]);
      const already = Object.fromEntries(members.map((m) => [m.status, m._count._all]));
      const ent = deps.get(EntitlementsService);
      const [e, used] = await Promise.all([ent.forAccount(ctx.workspace.billingAccountId), ent.usage(ctx.workspace.billingAccountId, "marketingContacts")]);
      const cap = e.limits.marketingContacts;
      const noConsent = ids.length - consented;
      const lines = [
        `Add up to ${ids.length.toLocaleString()} contacts to the list "${list.name}"${already.subscribed ? ` (${already.subscribed} are already subscribed)` : ""}.`,
        args.consent
          ? `You confirm they all agreed to marketing email ("${args.consent.source}"): consent is recorded for the ${noConsent} without it.`
          : list.doubleOptIn && noConsent
            ? `${noConsent} have no recorded consent: this is a double opt-in list, so each of them is EMAILED a confirmation link.`
            : noConsent
              ? `${noConsent} have no recorded consent: they join as leads and marketing sends leave them out.`
              : "All of them have recorded marketing consent.",
        "Suppressed people, those who refused consent and those who unsubscribed from this list are skipped.",
        isUnlimited(cap) ? "" : `Marketing contacts on the plan: ${used.toLocaleString()} of ${cap.toLocaleString()} used.`,
      ].filter(Boolean);
      return {
        summary: lines.join(" "),
        details: { listId: list.id, listName: list.name, contacts: ids.length, alreadySubscribed: already.subscribed ?? 0, withoutConsent: noConsent, doubleOptIn: list.doubleOptIn, unknownEmails: resolved.unknownEmails.length },
        // Store exactly the people shown, so a filter matching more people by the time of approval changes nothing.
        args: { listId: list.id, contactIds: ids, ...(args.consent ? { consent: args.consent } : {}) },
      };
    },
    handler: async (ctx, args, deps) => addPeople(ctx, deps, args, { contactIds: args.contactIds ?? [], unknownEmails: [], invalidEmails: [] }),
  }),

  defineTool({
    name: "remove_from_list",
    title: "Remove people from a list",
    description:
      "Takes people off a list (by contactIds, emails and/or a contact filter). People who unsubscribed themselves stay recorded as unsubscribed, so they can never be silently re-added.",
    input: z.object({ listId, ...peopleInput }),
    permission: WRITE,
    risk: "important",
    preview: async (ctx, args, deps) => {
      const list = await deps.get(ListsService).get(ctx, args.listId);
      const resolved = await resolvePeople(ctx, deps, args);
      const rows = await deps.prisma.db.listMembership.groupBy({
        by: ["status"],
        where: { workspaceId: ctx.workspace.id, listId: list.id, contactId: { in: resolved.contactIds } },
        _count: { _all: true },
      });
      const by = Object.fromEntries(rows.map((r) => [r.status, r._count._all])) as Record<string, number>;
      const removable = (by.subscribed ?? 0) + (by.pending ?? 0);
      if (!removable) throw badRequest(`None of those people are on "${list.name}" (other than people who unsubscribed themselves, who stay recorded).`);
      const members = await deps.prisma.db.listMembership.findMany({
        where: { workspaceId: ctx.workspace.id, listId: list.id, contactId: { in: resolved.contactIds }, status: { not: "unsubscribed" } },
        select: { contactId: true },
      });
      return {
        summary: `Remove ${removable.toLocaleString()} people from the list "${list.name}" (${by.subscribed ?? 0} subscribed, ${by.pending ?? 0} pending). Their contacts are kept; they just leave this list.${by.unsubscribed ? ` ${by.unsubscribed} who unsubscribed stay recorded as unsubscribed.` : ""}`,
        details: { listId: list.id, listName: list.name, removing: removable, keptUnsubscribed: by.unsubscribed ?? 0 },
        args: { listId: list.id, contactIds: members.map((m) => m.contactId) },
      };
    },
    handler: async (ctx, args, deps) => {
      const r = await deps.get(ListsService).removeMembers(ctx, args.listId, args.contactIds ?? []);
      return { listId: args.listId, ...r };
    },
  }),
];
