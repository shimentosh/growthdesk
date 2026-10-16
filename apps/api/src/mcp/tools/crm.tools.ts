import { z } from "zod";
import {
  CONTACT_STATUSES,
  CompanyInput,
  ContactFilter,
  ContactInput,
  LIFECYCLE_STAGES,
  LeadInput,
  PRIORITIES,
  QUALIFICATIONS,
  patchOf,
  type ContactFilterT,
} from "@growthdesk/shared";
import type { Prisma } from "../../generated/prisma/client.js";
import { ContactsService } from "../../crm/contacts.service.js";
import { CompaniesService } from "../../crm/companies.service.js";
import { CrmExtrasService } from "../../crm/crm-extras.service.js";
import { ConsentService } from "../../crm/consent.service.js";
import { ListsService } from "../../marketing/lists.service.js";
import { LeadIngestService, type IngestResult } from "../../integrations/lead-ingest.service.js";
import { parseWith } from "../../common/decorators.js";
import { badRequest, forbidden, notFound } from "../../common/errors.js";
import { holds } from "../../common/context.js";
import { defineTool, pageInput, paged, type McpCtx, type McpDeps } from "../tool.js";

/*
 * CRM through MCP: contacts and leads (the lifecycle stage tells them apart:
 * lead → sales → contact), companies, tags, notes, the timeline and lead
 * imports. Every handler calls the same service the HTTP controller does,
 * with the same permission, so ownership scopes, plan limits, dedupe and
 * audit behave exactly as in the app.
 */

const uuid = z.string().uuid();
/** An owner: a member's user id, "me" (the person this connection acts as) or "none". */
const ownerRef = z.union([uuid, z.literal("me"), z.literal("none")]);

const STAGE_WORDS = "lead (new, not yet worked by sales), sales (being worked: In sales) or contact (customer / past customer)";

type ContactLike = {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  jobTitle?: string | null;
  company: { id: string; name: string } | null;
  owner: { id: string; name: string } | null;
  lifecycleStage: string;
  status: string;
  qualification?: string;
  priority?: string;
  score?: number | null;
  tags: { name: string }[];
  archivedAt?: Date | null;
  lastContactedAt?: Date | null;
  lastRepliedAt?: Date | null;
  nextActionAt?: Date | null;
  createdAt?: Date;
};

/** The few fields the model needs to talk about a contact. */
export const brief = (c: ContactLike) => ({
  id: c.id,
  name: c.fullName,
  email: c.email,
  phone: c.phone,
  ...(c.jobTitle ? { jobTitle: c.jobTitle } : {}),
  company: c.company ? { id: c.company.id, name: c.company.name } : null,
  owner: c.owner ? { id: c.owner.id, name: c.owner.name } : null,
  stage: c.lifecycleStage,
  status: c.status,
  ...(c.qualification ? { qualification: c.qualification } : {}),
  ...(c.priority ? { priority: c.priority } : {}),
  ...(c.score !== undefined && c.score !== null ? { score: c.score } : {}),
  tags: c.tags.map((t) => t.name),
  ...(c.archivedAt ? { archived: true } : {}),
  ...(c.lastContactedAt ? { lastContactedAt: c.lastContactedAt } : {}),
  ...(c.lastRepliedAt ? { lastRepliedAt: c.lastRepliedAt } : {}),
  ...(c.nextActionAt ? { nextActionAt: c.nextActionAt } : {}),
});

const resolveOwner = (ctx: McpCtx, owner: string | undefined | null) => (owner === "me" ? ctx.identity.userId : owner === "none" ? null : owner);

/** Of these ids, the contacts this person may see (others are silently left out, as the bulk endpoint does). */
async function visibleIds(ctx: McpCtx, deps: McpDeps, ids: string[]) {
  const where = deps.get(ContactsService).where(ctx, { archived: "include" });
  const rows = await deps.prisma.db.contact.findMany({ where: { AND: [where, { id: { in: ids } }] } as Prisma.ContactWhereInput, select: { id: true, fullName: true, email: true } });
  return rows;
}

const contactIds = z.array(uuid).min(1).max(100).describe("Contact ids (from search_contacts), at most 100.");

/* ─── Filters (search_contacts and bulk_update_contacts) ─────────────────── */

const filterShape = {
  q: z.string().trim().max(200).optional().describe("Free text: name, email, phone, job title or company name."),
  stage: z.array(z.enum(LIFECYCLE_STAGES)).optional().describe(`Lifecycle stage(s): ${STAGE_WORDS}.`),
  status: z.array(z.enum(CONTACT_STATUSES)).optional().describe("Contact status(es)."),
  qualification: z.array(z.enum(QUALIFICATIONS)).optional(),
  priority: z.array(z.enum(PRIORITIES)).optional(),
  tag: z.array(z.string().max(50)).optional().describe("Has any of these tag names."),
  ownerId: ownerRef.optional().describe('Owner: a member\'s user id, "me" or "none" (unowned).'),
  companyId: uuid.optional(),
  listId: uuid.optional().describe("Members of this lead / marketing list."),
  campaignId: uuid.optional().describe("Enrolled in this outreach campaign."),
  leadSource: z.string().trim().max(100).optional(),
  hasEmail: z.boolean().optional(),
  createdAfter: z.string().max(40).optional().describe("ISO date/time."),
  createdBefore: z.string().max(40).optional().describe("ISO date/time."),
  archived: z.enum(["include", "only"]).optional().describe("Archived people are left out unless asked for."),
};
const FilterInput = z.object(filterShape);

const toFilter = (f: z.output<typeof FilterInput>): ContactFilterT => parseWith(ContactFilter, Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined)));

/* ─── Imports ───────────────────────────────────────────────────────────── */

/** The lead-ingest API takes 100 leads a request; larger imports go through in chunks of this size. */
const INGEST_CHUNK = 100;
const IMPORT_WRITE_MAX = 200;
const IMPORT_MAX = 2000;

const importShape = {
  tags: z.array(z.string().trim().min(1).max(50)).max(20).default([]).describe("Tags added to every imported person."),
  onDuplicate: z.enum(["update", "skip"]).default("update").describe("A row matching an existing contact (by email, phone or externalId): fill its blank fields (update — never overwrites) or leave it (skip)."),
  listId: uuid.optional().describe("Add everyone to this lead / marketing list."),
  listName: z.string().trim().min(1).max(120).optional().describe("Or a list by name: found (ignoring case) or created."),
  consent: z
    .object({ confirmed: z.literal(true), source: z.string().trim().min(1).max(200) })
    .optional()
    .describe("Only when these people really agreed to marketing email (e.g. ticked an opt-in box): records consent with where they gave it."),
};

async function runImport(ctx: McpCtx, deps: McpDeps, input: { leads: z.output<typeof LeadInput>[]; tags: string[]; onDuplicate: "update" | "skip"; listId?: string; listName?: string; consent?: { confirmed: true; source: string }; campaignId?: string }) {
  const ingest = deps.get(LeadIngestService);
  const summary = { received: 0, created: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0 };
  const failures: { row: number; error: string }[] = [];
  const created: string[] = [];
  const imports: string[] = [];
  let list: { listId: string; added: number; pending: number; alreadyMember: number; error?: string } | null = null;
  let enrollment: { campaignId: string; enrolled: number; skipped: number; error?: string } | null = null;
  for (let start = 0; start < input.leads.length; start += INGEST_CHUNK) {
    const chunk = input.leads.slice(start, start + INGEST_CHUNK);
    const res: IngestResult = await ingest.ingest(ctx, {
      leads: chunk,
      source: "api",
      onDuplicate: input.onDuplicate,
      tags: input.tags,
      ...(input.listId ? { listId: input.listId } : {}),
      ...(input.listName ? { listName: input.listName } : {}),
      ...(input.consent ? { consent: input.consent } : {}),
      ...(input.campaignId ? { campaignId: input.campaignId } : {}),
    });
    imports.push(res.importId);
    for (const k of Object.keys(summary) as (keyof typeof summary)[]) summary[k] += res.summary[k] ?? 0;
    for (const r of res.results) {
      if (r.status === "failed" && r.error) failures.push({ row: start + r.index, error: r.error.message });
      if (r.status === "created" && r.contactId && created.length < 50) created.push(r.contactId);
    }
    const l = res.list ?? (res.lists[0] ? { ...res.lists[0] } : null);
    if (l) {
      list ??= { listId: l.listId, added: 0, pending: 0, alreadyMember: 0 };
      list.added += l.added;
      list.pending += l.pending;
      list.alreadyMember += l.alreadyMember;
      if (l.error) list.error = l.error.message;
    }
    if (res.enrollment) {
      enrollment ??= { campaignId: res.enrollment.campaignId, enrolled: 0, skipped: 0 };
      enrollment.enrolled += res.enrollment.enrolled;
      enrollment.skipped += res.enrollment.skipped.length;
      if (res.enrollment.error) enrollment.error = res.enrollment.error.message;
    }
  }
  return {
    summary,
    ...(failures.length ? { failures: failures.slice(0, 50) } : {}),
    createdContactIds: created,
    ...(list ? { list } : {}),
    ...(enrollment ? { enrollment } : {}),
    importIds: imports,
    note: "Each import is listed under Contacts → Imports with its per-row results.",
  };
}

/* ─── Tools ─────────────────────────────────────────────────────────────── */

export const CRM_TOOLS = [
  defineTool({
    name: "search_contacts",
    title: "Search contacts and leads",
    description: `Find people in the CRM. Leads, people in sales and customers are all contacts; filter by lifecycle stage: ${STAGE_WORDS}. Filter by status, tag, owner, company, list or campaign, or search free text. Returns ids for the other contact tools.`,
    input: z.object({
      ...filterShape,
      sort: z.enum(["createdAt", "updatedAt", "fullName", "lastContactedAt", "nextActionAt", "priority", "score"]).default("createdAt"),
      dir: z.enum(["asc", "desc"]).default("desc"),
      ...pageInput,
    }),
    permission: "contacts.read",
    risk: "read",
    handler: async (ctx, args, deps) => {
      const { sort, dir, page, limit, ...f } = args;
      const r = await deps.get(ContactsService).list(ctx, toFilter(f), page, limit, sort, dir);
      return paged(r.items.map(brief), r.total, page, limit);
    },
  }),

  defineTool({
    name: "get_contact",
    title: "Get a contact",
    description:
      "Everything about one contact: emails and phones, company, owner, stage and status, consent, open deals and tasks, campaign enrollments, list memberships, recent conversations, meetings, calls and the latest timeline entries.",
    input: z.object({ contactId: uuid }),
    permission: "contacts.read",
    risk: "read",
    handler: async (ctx, args, deps) => {
      const c = await deps.get(ContactsService).get(ctx, args.contactId);
      const [lists, consent, timeline] = await Promise.all([
        deps.get(ListsService).forContact(ctx, c.id),
        deps.get(ConsentService).history(ctx.workspace.id, c.id),
        deps.get(CrmExtrasService).timeline(ctx, { contactId: c.id }),
      ]);
      return {
        ...brief(c),
        firstName: c.firstName,
        lastName: c.lastName,
        website: c.website,
        linkedinUrl: c.linkedinUrl,
        city: c.city,
        country: c.country,
        leadSource: c.leadSource,
        customFields: c.customFields,
        nextActionNote: c.nextActionNote || undefined,
        identifiers: c.identifiers.map((i) => ({ kind: i.kind, value: i.value, primary: i.isPrimary })),
        sources: c.sources.map((s) => ({ source: s.source, externalId: s.externalId, at: s.createdAt })),
        reachability: { doNotContact: c.doNotContact, unsubscribedAt: c.unsubscribedAt, bouncedAt: c.bouncedAt, suppressed: c.suppressed },
        consent: { status: c.consentStatus, source: c.consentSource, at: c.consentAt, history: (consent as unknown[]).slice(0, 5) },
        deals: c.deals,
        openTasks: c.tasks.map((t) => ({ id: t.id, title: t.title, type: t.type, dueAt: t.dueAt, priority: t.priority })),
        enrollments: c.enrollments.map((e) => ({ campaign: e.campaign, status: e.status, stopReason: e.stopReason, nextRunAt: e.nextRunAt })),
        lists: lists.map((l) => ({ listId: l.list.id, name: l.list.name, status: l.status })),
        conversations: c.conversations,
        meetings: c.meetings.map((m) => ({ id: m.id, title: m.title, startsAt: m.startsAt, status: m.status })),
        calls: c.calls.map((x) => ({ id: x.id, status: x.status, outcome: x.outcome, at: x.createdAt })),
        recentTimeline: timeline.slice(0, 15).map((a) => ({ type: a.type, summary: a.summary, at: a.occurredAt, by: a.actor?.name ?? null })),
      };
    },
  }),

  defineTool({
    name: "create_contact",
    title: "Create a contact or lead",
    description: `Adds one person. Give at least a name, email or phone. lifecycleStage: ${STAGE_WORDS} (default lead). companyName finds or creates the company. Refused (409, with the existing contactId) when the email or phone already belongs to someone — then use update_contact. For many people use import_leads.`,
    input: ContactInput,
    permission: "contacts.write",
    risk: "write",
    handler: async (ctx, args, deps) => brief(await deps.get(ContactsService).create(ctx, args)),
  }),

  defineTool({
    name: "update_contact",
    title: "Update a contact",
    description:
      "Changes the fields given and leaves the rest. Setting qualification to qualified hands a lead to sales. doNotContact: true also suppresses their email and phone. To change tags use add_tags / remove_tags; owners assign_owner; the stage set_lifecycle_stage.",
    input: patchOf(ContactInput.omit({ tags: true })).extend({ contactId: uuid }),
    permission: "contacts.write",
    risk: "write",
    handler: async (ctx, args, deps) => {
      const { contactId, ...patch } = args;
      if (!Object.keys(patch).length) throw badRequest("Give at least one field to change");
      return brief(await deps.get(ContactsService).update(ctx, contactId, patch));
    },
  }),

  defineTool({
    name: "add_tags",
    title: "Tag contacts",
    description: "Adds tags (created if new) to up to 100 contacts. Their other tags stay.",
    input: z.object({ contactIds, tags: z.array(z.string().trim().min(1).max(50)).min(1).max(20) }),
    permission: "contacts.write",
    risk: "write",
    handler: async (ctx, args, deps) => {
      const ids = (await visibleIds(ctx, deps, args.contactIds)).map((c) => c.id);
      if (!ids.length) throw notFound("Those contacts");
      return deps.get(ContactsService).bulk(ctx, { action: "tag", ids, tags: args.tags });
    },
  }),

  defineTool({
    name: "remove_tags",
    title: "Remove tags from contacts",
    description: "Takes these tags off up to 100 contacts. The tags themselves stay in the workspace.",
    input: z.object({ contactIds, tags: z.array(z.string().trim().min(1).max(50)).min(1).max(20) }),
    permission: "contacts.write",
    risk: "write",
    handler: async (ctx, args, deps) => {
      const ids = (await visibleIds(ctx, deps, args.contactIds)).map((c) => c.id);
      if (!ids.length) throw notFound("Those contacts");
      return deps.get(ContactsService).bulk(ctx, { action: "untag", ids, tags: args.tags });
    },
  }),

  defineTool({
    name: "assign_owner",
    title: "Assign an owner",
    description: 'Makes a member the owner of up to 100 contacts. ownerId: a member\'s user id (see whoami / get_contact owners), "me", or "none" to unassign.',
    input: z.object({ contactIds, ownerId: ownerRef }),
    permission: "contacts.write",
    risk: "write",
    handler: async (ctx, args, deps) => deps.get(ContactsService).bulk(ctx, { action: "assign", ids: args.contactIds, ownerId: resolveOwner(ctx, args.ownerId) ?? null }),
  }),

  defineTool({
    name: "set_lifecycle_stage",
    title: "Move contacts to a lifecycle stage",
    description: `Sets the lifecycle stage of up to 100 contacts: ${STAGE_WORDS}. With handToSales (stage "sales" only) it works like the app's "Hand to sales": marks them qualified, optionally sets an owner, and stops their automated outreach sequences so a person takes over.`,
    input: z.object({
      contactIds,
      stage: z.enum(LIFECYCLE_STAGES),
      handToSales: z.boolean().default(false),
      ownerId: ownerRef.optional().describe("With handToSales: the new owner."),
    }),
    permission: "contacts.write",
    risk: "write",
    handler: async (ctx, args, deps) => {
      const contacts = deps.get(ContactsService);
      if (args.handToSales) {
        if (args.stage !== "sales") throw badRequest('handToSales goes with stage "sales"');
        return contacts.transferToSales(ctx, args.contactIds, args.ownerId === undefined ? undefined : resolveOwner(ctx, args.ownerId));
      }
      return contacts.bulk(ctx, { action: "stage", ids: args.contactIds, stage: args.stage });
    },
  }),

  defineTool({
    name: "archive_contact",
    title: "Archive or restore contacts",
    description:
      "Archives up to 100 contacts: they keep their history but leave every list view, and their active outreach sequences stop. restore: true brings archived ones back. Nothing is deleted.",
    input: z.object({ contactIds, restore: z.boolean().default(false) }),
    permission: "contacts.write",
    risk: "write",
    handler: async (ctx, args, deps) => deps.get(ContactsService).archive(ctx, args.contactIds, !args.restore),
  }),

  defineTool({
    name: "delete_contact",
    title: "Delete contacts",
    description: "Deletes up to 50 contacts: they disappear from the CRM, their addresses are released and their active sequences stop. Prefer archive_contact unless the user asks to delete.",
    input: z.object({ contactIds: z.array(uuid).min(1).max(50) }),
    permission: "contacts.delete",
    risk: "important",
    preview: async (ctx, args, deps) => {
      const rows = await visibleIds(ctx, deps, args.contactIds);
      if (!rows.length) throw notFound("Those contacts");
      const names = rows.map((c) => (c.email ? `${c.fullName || c.email} <${c.email}>` : c.fullName || c.id));
      return {
        summary: `Delete ${rows.length} contact${rows.length > 1 ? "s" : ""}: ${names.slice(0, 10).join(", ")}${rows.length > 10 ? ` and ${rows.length - 10} more` : ""}. Their active sequences stop.`,
        details: { count: rows.length, notFound: args.contactIds.length - rows.length },
        args: { contactIds: rows.map((c) => c.id) },
      };
    },
    handler: async (ctx, args, deps) => deps.get(ContactsService).remove(ctx, args.contactIds),
  }),

  defineTool({
    name: "bulk_update_contacts",
    title: "Bulk-update contacts",
    description:
      "One change to many contacts at once (up to 5000), chosen by ids or by a filter (the same filters as search_contacts): tag, untag, assign (owner), status, stage, qualification, archive or unarchive. The preview tells how many people it touches, with a sample; the exact people are fixed when it is prepared.",
    input: z.object({
      action: z.enum(["tag", "untag", "assign", "status", "stage", "qualification", "archive", "unarchive"]),
      contactIds: z.array(uuid).min(1).max(5000).optional().describe("Either ids…"),
      filter: FilterInput.optional().describe("…or a filter."),
      tags: z.array(z.string().trim().min(1).max(50)).max(20).optional().describe("For tag / untag."),
      ownerId: ownerRef.optional().describe("For assign."),
      status: z.enum(CONTACT_STATUSES).optional().describe("For status."),
      stage: z.enum(LIFECYCLE_STAGES).optional().describe("For stage."),
      qualification: z.enum(QUALIFICATIONS).optional().describe("For qualification."),
    }),
    permission: "contacts.write",
    risk: "important",
    preview: async (ctx, args, deps) => {
      const need: Record<string, keyof typeof args> = { tag: "tags", untag: "tags", assign: "ownerId", status: "status", stage: "stage", qualification: "qualification" };
      const field = need[args.action];
      if (field && (args[field] === undefined || (Array.isArray(args[field]) && !(args[field] as unknown[]).length))) throw badRequest(`"${args.action}" needs ${field}`, { [field]: "Required" });
      if (!args.contactIds?.length && !args.filter) throw badRequest("Choose the contacts: contactIds or a filter");
      const contacts = deps.get(ContactsService);
      let rows: { id: string; fullName: string; email: string | null }[];
      if (args.contactIds?.length) rows = await visibleIds(ctx, deps, args.contactIds);
      else {
        const filter = toFilter(args.filter!);
        if (args.action === "unarchive" && !filter.archived) filter.archived = "only";
        rows = await deps.prisma.db.contact.findMany({ where: contacts.where(ctx, filter), select: { id: true, fullName: true, email: true }, orderBy: { createdAt: "asc" }, take: 5001 });
        if (rows.length > 5000) throw badRequest("That filter matches more than 5000 people. Narrow it, or do it in parts.");
      }
      if (!rows.length) throw badRequest("No contacts match — nothing to change.");
      const what: Record<string, string> = {
        tag: `add the tag(s) ${args.tags?.join(", ")} to`,
        untag: `remove the tag(s) ${args.tags?.join(", ")} from`,
        assign: args.ownerId === "none" ? "unassign the owner of" : `make ${args.ownerId === "me" ? "you" : `member ${args.ownerId}`} the owner of`,
        status: `set the status to "${args.status}" for`,
        stage: `move to the "${args.stage}" stage`,
        qualification: `set qualification to "${args.qualification}" for`,
        archive: "archive (and stop the sequences of)",
        unarchive: "restore from the archive",
      };
      const sample = rows.slice(0, 5).map((c) => c.fullName || c.email || c.id);
      return {
        summary: `Bulk update: ${what[args.action]} ${rows.length} contact${rows.length > 1 ? "s" : ""} (e.g. ${sample.join(", ")}${rows.length > 5 ? ", …" : ""}).`,
        details: { action: args.action, count: rows.length, sample },
        args: { ...args, filter: undefined, contactIds: rows.map((c) => c.id) },
      };
    },
    handler: async (ctx, args, deps) => {
      const ids = args.contactIds ?? [];
      const contacts = deps.get(ContactsService);
      switch (args.action) {
        case "tag":
        case "untag":
          return contacts.bulk(ctx, { action: args.action, ids, tags: args.tags ?? [] });
        case "assign":
          return contacts.bulk(ctx, { action: "assign", ids, ownerId: resolveOwner(ctx, args.ownerId) ?? null });
        case "status":
          return contacts.bulk(ctx, { action: "status", ids, status: args.status });
        case "stage":
          return contacts.bulk(ctx, { action: "stage", ids, stage: args.stage });
        case "qualification":
          return contacts.bulk(ctx, { action: "qualification", ids, qualification: args.qualification });
        default:
          return contacts.bulk(ctx, { action: args.action, ids });
      }
    },
  }),

  defineTool({
    name: "import_leads",
    title: "Import leads (up to 200)",
    description: `Adds up to ${IMPORT_WRITE_MAX} people at once, deduplicated like a CSV import: by externalId, then any email, then any phone; a match has its blank fields filled, never overwritten. Each lead: firstName/lastName or fullName, email, phone, jobTitle, companyName or company { name, domain, … }, linkedinUrl, leadSource, tags, notes, externalId. Optionally tags for all, a list (listId or listName) and consent. New contacts start as leads and trigger "lead imported" workflows. More rows, or enrolling them in an outreach campaign: import_leads_bulk.`,
    input: z.object({ leads: z.array(LeadInput).min(1).max(IMPORT_WRITE_MAX), ...importShape }),
    permission: "contacts.import",
    risk: "write",
    handler: async (ctx, args, deps) => runImport(ctx, deps, args),
  }),

  defineTool({
    name: "import_leads_bulk",
    title: "Import many leads, or import and enroll",
    description: `Like import_leads for up to ${IMPORT_MAX} people, and optionally enrolls everyone in a launched outreach campaign (campaignId) so the sequence starts emailing them. The preview shows how many are new and how many match existing contacts.`,
    input: z.object({ leads: z.array(LeadInput).min(1).max(IMPORT_MAX), ...importShape, campaignId: uuid.optional().describe("A launched (always-on or running) outreach campaign to enroll everyone in.") }),
    permission: "contacts.import",
    risk: "important",
    preview: async (ctx, args, deps) => {
      const db = deps.prisma.db;
      const emails = [...new Set(args.leads.flatMap((l) => [l.email, ...(l.emails ?? [])]).filter((e): e is string => Boolean(e)).map((e) => e.toLowerCase()))];
      const existing = emails.length
        ? await db.contactIdentifier.count({ where: { workspaceId: ctx.workspace.id, kind: "email", value: { in: emails } } })
        : 0;
      let campaign: { name: string; status: string } | null = null;
      if (args.campaignId) {
        if (!ctx.mcp.rolePermissions.includes("campaigns.launch")) throw forbidden(`Your role (${ctx.workspace.role}) cannot enroll contacts in campaigns`);
        campaign = await db.campaign.findFirst({ where: { id: args.campaignId, workspaceId: ctx.workspace.id, deletedAt: null }, select: { name: true, status: true } });
        if (!campaign) throw notFound("That campaign");
        if (!["scheduled", "running", "paused"].includes(campaign.status)) throw badRequest(`The campaign "${campaign.name}" is ${campaign.status}, so it cannot take contacts.`);
      }
      let listName = args.listName ?? null;
      if (args.listId) {
        const l = await db.marketingList.findFirst({ where: { id: args.listId, workspaceId: ctx.workspace.id }, select: { name: true } });
        if (!l) throw notFound("That list");
        listName = l.name;
      }
      const sample = args.leads.slice(0, 5).map((l) => l.fullName || [l.firstName, l.lastName].filter(Boolean).join(" ") || l.email || l.phone || "(no name)");
      const parts = [
        `Import ${args.leads.length} lead${args.leads.length > 1 ? "s" : ""} (e.g. ${sample.join(", ")}${args.leads.length > 5 ? ", …" : ""}).`,
        `${existing} of the ${emails.length} email addresses already belong to contacts (${args.onDuplicate === "update" ? "their blank fields will be filled" : "they will be left alone"}).`,
        args.tags.length ? `Tags: ${args.tags.join(", ")}.` : "",
        listName ? `Add everyone to the list "${listName}"${args.consent ? ", recording marketing consent" : ""}.` : "",
        campaign ? `ENROLL everyone in the outreach campaign "${campaign.name}" (${campaign.status}) — its sequence will start emailing them.` : "",
      ];
      return {
        summary: parts.filter(Boolean).join(" "),
        details: { rows: args.leads.length, emails: emails.length, existingEmails: existing, list: listName, campaign: campaign?.name ?? null, consent: Boolean(args.consent) },
      };
    },
    handler: async (ctx, args, deps) => runImport(ctx, deps, args),
  }),

  defineTool({
    name: "add_note",
    title: "Add a note",
    description: "Adds a note to a contact, a company or a deal (exactly one of them). It shows on their timeline.",
    input: z.object({
      contactId: uuid.optional(),
      companyId: uuid.optional(),
      dealId: uuid.optional(),
      body: z.string().trim().min(1).max(10000),
      pinned: z.boolean().optional(),
    }),
    permission: ["contacts.write", "deals.write"],
    risk: "write",
    handler: async (ctx, args, deps) => {
      const targets: { contactId?: string; companyId?: string; dealId?: string }[] = [];
      if (args.contactId) targets.push({ contactId: args.contactId });
      if (args.companyId) targets.push({ companyId: args.companyId });
      if (args.dealId) targets.push({ dealId: args.dealId });
      if (targets.length !== 1) throw badRequest("Give exactly one of contactId, companyId or dealId");
      if (args.dealId ? !holds(ctx, "deals.write") : !holds(ctx, "contacts.write")) throw forbidden(`Your access cannot add notes to ${args.dealId ? "deals" : "contacts and companies"}`);
      if (args.contactId) await deps.get(ContactsService).get(ctx, args.contactId);
      const note = await deps.get(CrmExtrasService).addNote(ctx, targets[0]!, args.body, args.pinned);
      return { noteId: note.id, added: true };
    },
  }),

  defineTool({
    name: "get_timeline",
    title: "Get a timeline",
    description: "The activity history of a contact, company or deal (newest first): emails, replies, stage changes, notes, tasks, meetings, calls.",
    input: z.object({ contactId: uuid.optional(), companyId: uuid.optional(), dealId: uuid.optional(), limit: z.number().int().min(1).max(100).default(30) }),
    permission: ["contacts.read", "deals.read"],
    risk: "read",
    handler: async (ctx, args, deps) => {
      const target = args.contactId ? { contactId: args.contactId } : args.companyId ? { companyId: args.companyId } : args.dealId ? { dealId: args.dealId } : null;
      if (!target) throw badRequest("Give a contactId, companyId or dealId");
      if (!args.dealId && !holds(ctx, "contacts.read")) throw forbidden("Your access cannot read contacts");
      if (args.dealId && !holds(ctx, "deals.read")) throw forbidden("Your access cannot read deals");
      if (args.contactId) await deps.get(ContactsService).get(ctx, args.contactId);
      const rows = await deps.get(CrmExtrasService).timeline(ctx, target);
      return { items: rows.slice(0, args.limit).map((a) => ({ type: a.type, summary: a.summary, at: a.occurredAt, by: a.actor?.name ?? null })), total: rows.length };
    },
  }),

  /* ─── Companies ─────────────────────────────────────────────────────── */

  defineTool({
    name: "search_companies",
    title: "Search companies",
    description: "Find companies by name, domain or industry. Returns ids, with how many contacts and deals each has.",
    input: z.object({ q: z.string().trim().max(200).optional(), ...pageInput }),
    permission: "contacts.read",
    risk: "read",
    handler: async (ctx, args, deps) => {
      const r = await deps.get(CompaniesService).list(ctx, args.q, args.page, args.limit);
      return paged(
        r.items.map((c) => ({ id: c.id, name: c.name, domain: c.domain, industry: c.industry, country: c.country, owner: c.owner?.name ?? null, tags: c.tags.map((t) => t.name), contacts: c.contactCount, deals: c.dealCount })),
        r.total,
        args.page,
        args.limit,
      );
    },
  }),

  defineTool({
    name: "get_company",
    title: "Get a company",
    description: "One company with its people, deals, pinned and recent notes and recent activity.",
    input: z.object({ companyId: uuid }),
    permission: "contacts.read",
    risk: "read",
    handler: async (ctx, args, deps) => {
      const c = await deps.get(CompaniesService).get(ctx, args.companyId);
      return {
        id: c.id,
        name: c.name,
        domain: c.domain,
        website: c.website,
        industry: c.industry,
        size: c.size,
        country: c.country,
        city: c.city,
        phone: c.phone,
        description: c.description,
        owner: c.owner,
        tags: c.tags.map((t) => t.name),
        customFields: c.customFields,
        contacts: c.contacts.slice(0, 30).map(brief),
        contactCount: c.contacts.length,
        deals: c.deals,
        notes: c.notes.slice(0, 10).map((n) => ({ id: n.id, body: n.body.slice(0, 1000), pinned: n.pinned, at: n.createdAt })),
        recentActivity: c.activities.slice(0, 15).map((a) => ({ type: a.type, summary: a.summary, at: a.occurredAt })),
      };
    },
  }),

  defineTool({
    name: "create_company",
    title: "Create a company",
    description: "Adds a company. Link people to it with update_contact (companyId) or create_contact (companyName).",
    input: CompanyInput,
    permission: "contacts.write",
    risk: "write",
    handler: async (ctx, args, deps) => {
      const c = await deps.get(CompaniesService).create(ctx, args);
      return { id: c.id, name: c.name, domain: c.domain };
    },
  }),

  defineTool({
    name: "update_company",
    title: "Update a company",
    description: "Changes the company fields given and leaves the rest. tags replaces the company's tags.",
    input: patchOf(CompanyInput).extend({ companyId: uuid }),
    permission: "contacts.write",
    risk: "write",
    handler: async (ctx, args, deps) => {
      const { companyId, ...patch } = args;
      if (!Object.keys(patch).length) throw badRequest("Give at least one field to change");
      const c = await deps.get(CompaniesService).update(ctx, companyId, patch);
      return { id: c.id, name: c.name, domain: c.domain, updated: true };
    },
  }),
];
