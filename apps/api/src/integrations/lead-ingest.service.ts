import { Injectable, Logger } from "@nestjs/common";
import type { z } from "zod";
import { LeadInput, type ContactInputT, type LeadIngestInputT, type LeadInputT, isUnlimited } from "@growthdesk/shared";
import type { CampaignStatus } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { EntitlementsService } from "../billing/entitlements.service.js";
import { EventsService } from "../core/events.service.js";
import { ContactsService, type UpsertResult } from "../crm/contacts.service.js";
import { CampaignsService, type SkipItem } from "../campaigns/campaigns.service.js";
import { ListsService, type AddResult } from "../marketing/lists.service.js";
import { conflict, forbidden, isApiError, notFound } from "../common/errors.js";
import { actorId, holds, ws, type RequestContext } from "../common/context.js";

/** Mirrors ENROLLABLE in campaigns.service.ts: a campaign takes new contacts only once launched and until it ends. */
const ENROLLABLE: CampaignStatus[] = ["scheduled", "running", "paused"];

export type LeadStatus = "created" | "updated" | "unchanged" | "skipped" | "failed";

export type LeadResult = {
  index: number;
  externalId: string | null;
  contactId: string | null;
  status: LeadStatus;
  matchedBy: UpsertResult["matchedBy"];
  error: { code: string; message: string } | null;
};

export type IngestResult = {
  importId: string;
  source: string;
  summary: Record<LeadStatus, number> & { received: number };
  results: LeadResult[];
  enrollment: {
    campaignId: string;
    enrolled: number;
    skipped: SkipItem[];
    error: { code: string; message: string } | null;
  } | null;
  list: {
    listId: string;
    added: number;
    /** On a double opt-in list: emailed a link, subscribed once they confirm. */
    pending: number;
    alreadyMember: number;
    skipped: AddResult["skipped"] | null;
    error: { code: string; message: string } | null;
  } | null;
  /** Lists named by `listName` (the request's or each lead's): one entry per list, with what joining it did. */
  lists: {
    listId: string;
    listName: string;
    /** The list did not exist and was made by this request. */
    created: boolean;
    added: number;
    pending: number;
    alreadyMember: number;
    skipped: AddResult["skipped"] | null;
    error: { code: string; message: string } | null;
  }[];
};

/** A list name as matched: trimmed, inner whitespace collapsed, case ignored. */
const listKey = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();

const blank = (v: string | null | undefined) => !v || !v.trim();

/** Why a lead failed its checks, field by field ("phone: Too big…; email: Invalid email address"). */
function invalidLead(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
    .join("; ");
}

/** The sender's id for a lead that failed its checks, when it gave a usable one. */
const rawExternalId = (raw: unknown): string | null => {
  const v = raw && typeof raw === "object" ? (raw as Record<string, unknown>).externalId : undefined;
  return typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : null;
};

/*
 * Business OS (and any API client) lead ingest. Each lead goes through
 * ContactsService.upsert — the single way a contact enters the CRM — so it is
 * deduplicated exactly like a CSV row: by the sender's external id first,
 * then any email, then any phone (ContactIdentifier). A match has its blank
 * fields filled, never overwritten. Every lead is attributed (ContactSource:
 * source + externalId + this request's Import row), and a new contact emits
 * `lead.imported` through the outbox.
 *
 * The request is recorded as an Import (source "business_os" or "api"), so it
 * shows in Imports history with its counts and per-lead errors. Leads are
 * processed one by one and independently: one bad lead fails alone.
 */
@Injectable()
export class LeadIngestService {
  private readonly log = new Logger("lead-ingest");

  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly events: EventsService,
    private readonly contacts: ContactsService,
    private readonly campaigns: CampaignsService,
    private readonly lists: ListsService,
  ) {}

  async ingest(ctx: RequestContext, input: LeadIngestInputT): Promise<IngestResult> {
    const w = ws(ctx);
    // The guard checks the subscription's plan; this also applies the lapsed-subscription fallback (docs/BILLING.md).
    await this.entitlements.assertFeature(w.billingAccountId, "apiAccess");
    await this.entitlements.assertFullAccess(w.billingAccountId, "Importing leads");
    if (input.campaignId) await this.checkCampaign(ctx, input.campaignId);
    if (input.listId) await this.checkList(ctx, input.listId);
    // Each lead is checked on its own: one with a bad field fails alone, the others are saved.
    const checked = input.leads.map((raw) => LeadInput.safeParse(raw));
    const leads = checked.map((c) => (c.success ? c.data : null));
    // Lists named by the request or its leads are found (or made) before any lead is saved.
    const named = await this.resolveLists(ctx, [input.listName, ...leads.map((l) => l?.listName)]);

    const defaultCountry = await this.contacts.defaultCountry(w.id);
    const keyName = ctx.apiKey?.name;
    const imp = await this.prisma.db.import.create({
      data: {
        workspaceId: w.id,
        source: input.source,
        status: "processing",
        fileName: keyName ? `API key: ${keyName}` : "API request",
        options: {
          onDuplicate: input.onDuplicate,
          tags: input.tags,
          campaignId: input.campaignId ?? null,
          listId: input.listId ?? null,
          listNames: [...named.values()].map((l) => l.name),
          apiKeyId: ctx.apiKey?.id ?? null,
        },
        totalRows: input.leads.length,
        createdById: actorId(ctx),
        startedAt: new Date(),
      },
    });

    const results: LeadResult[] = [];
    try {
      // Capacity is checked for the batch, then counted down as contacts are created (as ImportsService does).
      let remaining = await this.entitlements.remaining(w.billingAccountId, "contacts");
      for (const [index, lead] of leads.entries()) {
        if (!lead) {
          const check = checked[index]!;
          const message = check.success ? "Not a lead." : invalidLead(check.error);
          results.push({ index, externalId: rawExternalId(input.leads[index]), contactId: null, status: "failed", matchedBy: null, error: { code: "validation_failed", message } });
          continue;
        }
        const externalId = lead.externalId ?? null;
        try {
          const contact = await this.toContact(w.id, lead, input.tags, ctx);
          const res = await this.contacts.upsert(w.id, w.billingAccountId, contact, {
            source: input.source,
            externalId,
            importId: imp.id,
            sourceData: lead.data,
            onDuplicate: input.onDuplicate,
            defaultCountry,
            actorId: actorId(ctx),
            capacityChecked: true,
            emitEvent: "lead.imported",
            createBlocked: !isUnlimited(remaining) && remaining <= 0 ? "Your plan's contact limit is reached; this lead was not created. Upgrade to add more contacts." : undefined,
          });
          if (res.created) remaining -= 1;
          // Someone already in the CRM (matched by email or phone, not a re-send of the same external
          // record) arriving again as a lead — a second form, a new signup — runs the lead workflows
          // too; `returning` lets a condition tell them apart. Enrollment dedupes per campaign.
          else if (res.matchedBy === "email" || res.matchedBy === "phone") {
            await this.prisma.db.$transaction((tx) =>
              this.events.emitIn(tx, {
                workspaceId: w.id,
                type: "lead.imported",
                subjectType: "contact",
                subjectId: res.contactId,
                actorId: actorId(ctx),
                payload: { source: input.source, importId: imp.id, returning: true, matchedBy: res.matchedBy },
              }),
            );
          }
          const status: LeadStatus = res.created ? "created" : res.updated ? "updated" : res.skipped ? "skipped" : "unchanged";
          results.push({ index, externalId, contactId: res.contactId, status, matchedBy: res.matchedBy, error: null });
        } catch (e) {
          if (!isApiError(e)) this.log.warn(`import ${imp.id} lead ${index}: ${e instanceof Error ? e.message : String(e)}`);
          const error = isApiError(e) ? { code: e.code, message: e.message } : { code: "server_error", message: "This lead could not be saved. Try it again." };
          results.push({ index, externalId, contactId: null, status: "failed", matchedBy: null, error });
        }
      }
    } catch (e) {
      // Something outside a single lead (the database, the plan lookup) failed: close the import as failed.
      await this.prisma.db.import.updateMany({
        where: { id: imp.id, workspaceId: w.id },
        data: { status: "failed", finishedAt: new Date(), errors: [{ row: 0, message: "The request stopped before every lead was processed." }] as never },
      });
      await this.events.kick();
      throw e;
    }

    const count = (s: LeadStatus) => results.filter((r) => r.status === s).length;
    const summary = { received: input.leads.length, created: count("created"), updated: count("updated"), unchanged: count("unchanged"), skipped: count("skipped"), failed: count("failed") };
    await this.prisma.db.import.update({
      where: { id: imp.id, workspaceId: w.id },
      data: {
        status: "completed",
        finishedAt: new Date(),
        processedRows: results.length,
        createdCount: summary.created,
        updatedCount: summary.updated,
        skippedCount: summary.skipped + summary.unchanged,
        failedCount: summary.failed,
        // Row numbers are 1-based positions in `leads` (an import's row 0 means the whole import).
        errors: results.filter((r) => r.error).map((r) => ({ row: r.index + 1, message: r.error!.message })) as never,
      },
    });
    await this.events.kick();

    // List memberships say where they came from: the app or key that sent them, not "a team member".
    const via = ctx.apiKey ? `From ${ctx.apiKey.name}` : undefined;

    let enrollment: IngestResult["enrollment"] = null;
    if (input.campaignId) {
      const ids = [...new Set(results.map((r) => r.contactId).filter((id): id is string => Boolean(id)))];
      if (!ids.length) {
        enrollment = { campaignId: input.campaignId, enrolled: 0, skipped: [], error: null };
      } else {
        try {
          const res = await this.campaigns.enroll(ctx, input.campaignId, ids);
          enrollment = { campaignId: input.campaignId, enrolled: res.enrolled, skipped: res.skipped, error: null };
        } catch (e) {
          // The contacts are saved either way; say why enrolling them did not happen.
          if (!isApiError(e)) throw e;
          enrollment = { campaignId: input.campaignId, enrolled: 0, skipped: [], error: { code: e.code, message: e.message } };
        }
      }
    }

    let list: IngestResult["list"] = null;
    if (input.listId) {
      const ids = [...new Set(results.map((r) => r.contactId).filter((id): id is string => Boolean(id)))];
      if (!ids.length) {
        list = { listId: input.listId, added: 0, pending: 0, alreadyMember: 0, skipped: null, error: null };
      } else {
        try {
          const res = await this.lists.addMembers(ctx, input.listId, { contactIds: ids, ...(input.consent ? { consent: input.consent } : {}) }, via);
          list = { listId: input.listId, added: res.added, pending: res.pending, alreadyMember: res.alreadyMember, skipped: res.skipped, error: null };
        } catch (e) {
          // The contacts are saved either way; say why subscribing them did not happen (plan limit, archived list).
          if (!isApiError(e)) throw e;
          list = { listId: input.listId, added: 0, pending: 0, alreadyMember: 0, skipped: null, error: { code: e.code, message: e.message } };
        }
      }
    }

    // Each named list gets the contacts whose lead named it (or, without one, the request's listName).
    const lists: IngestResult["lists"] = [];
    const members = new Map<string, Set<string>>();
    for (const r of results) {
      const name = leads[r.index]?.listName ?? input.listName;
      const target = name ? named.get(listKey(name)) : undefined;
      if (!target || !r.contactId) continue;
      if (!members.has(target.id)) members.set(target.id, new Set());
      members.get(target.id)!.add(r.contactId);
    }
    for (const target of named.values()) {
      const ids = [...(members.get(target.id) ?? [])];
      const base = { listId: target.id, listName: target.name, created: target.created };
      if (!ids.length) {
        lists.push({ ...base, added: 0, pending: 0, alreadyMember: 0, skipped: null, error: null });
        continue;
      }
      try {
        // Through ListsService, so double opt-in, suppression, plan limits and list.subscribed all hold.
        const res = await this.lists.addMembers(ctx, target.id, { contactIds: ids, ...(input.consent ? { consent: input.consent } : {}) }, via);
        lists.push({ ...base, added: res.added, pending: res.pending, alreadyMember: res.alreadyMember, skipped: res.skipped, error: null });
      } catch (e) {
        if (!isApiError(e)) throw e;
        lists.push({ ...base, added: 0, pending: 0, alreadyMember: 0, skipped: null, error: { code: e.code, message: e.message } });
      }
    }

    return { importId: imp.id, source: input.source, summary, results, enrollment, list, lists };
  }

  /**
   * Lists by name: the active list with that name (case and spacing ignored),
   * else a new one. Names repeated across leads resolve once.
   */
  private async resolveLists(ctx: RequestContext, names: (string | undefined)[]) {
    const wanted = new Map<string, string>();
    for (const n of names) if (n && n.trim()) wanted.set(listKey(n), n.trim().replace(/\s+/g, " "));
    const out = new Map<string, { id: string; name: string; created: boolean }>();
    if (!wanted.size) return out;
    if (!ctx.apiKey && !holds(ctx, "marketing.write")) throw forbidden(`Your role (${ws(ctx).role}) cannot add people to lists`);
    const w = ws(ctx);
    const active = await this.prisma.db.marketingList.findMany({ where: { workspaceId: w.id, archivedAt: null }, select: { id: true, name: true }, orderBy: { createdAt: "asc" } });
    for (const [key, name] of wanted) {
      const found = active.find((l) => listKey(l.name) === key);
      if (found) {
        out.set(key, { id: found.id, name: found.name, created: false });
        continue;
      }
      const made = await this.lists.create(ctx, { name, description: "Created by lead ingest" });
      out.set(key, { id: made.id, name: made.name, created: true });
    }
    return out;
  }

  /** Refuses up front, before any lead is saved, when the list cannot take people. */
  private async checkList(ctx: RequestContext, listId: string) {
    if (!ctx.apiKey && !holds(ctx, "marketing.write")) throw forbidden(`Your role (${ws(ctx).role}) cannot add people to lists`);
    const l = await this.prisma.db.marketingList.findFirst({ where: { id: listId, workspaceId: ws(ctx).id }, select: { archivedAt: true } });
    if (!l) throw notFound("That list");
    if (l.archivedAt) throw conflict("This list is archived. Restore it before adding people.");
  }

  /** Refuses up front, before any lead is saved, when the campaign cannot take contacts. */
  private async checkCampaign(ctx: RequestContext, campaignId: string) {
    // A signed-in person needs the launch permission to enroll (as on POST /campaigns/:id/enroll);
    // an API key's leads:write scope covers it.
    if (!ctx.apiKey && !holds(ctx, "campaigns.launch")) throw forbidden(`Your role (${ws(ctx).role}) cannot enroll contacts in campaigns`);
    const c = await this.prisma.db.campaign.findFirst({ where: { id: campaignId, workspaceId: ws(ctx).id, deletedAt: null }, select: { status: true } });
    if (!c) throw notFound("That campaign");
    if (!ENROLLABLE.includes(c.status)) {
      throw conflict(
        c.status === "draft"
          ? "This campaign has not been launched, so it cannot take contacts yet."
          : `This campaign is ${c.status} and no longer takes new contacts.`,
      );
    }
  }

  /**
   * One lead as a contact input. A company given with a domain or website is
   * matched or created here (by domain, then name) so the contact links to
   * it; a bare company name is left to the upsert, which also links a
   * business email's domain.
   */
  private async toContact(workspaceId: string, lead: LeadInputT, tags: string[], ctx: RequestContext): Promise<ContactInputT & { notes?: string }> {
    const { externalId: _e, company, companyName, data: _d, tags: leadTags, listName: _l, ...fields } = lead;
    const contact: ContactInputT & { notes?: string } = { ...fields };
    const allTags = [...new Set([...(leadTags ?? []), ...tags])];
    if (allTags.length) contact.tags = allTags.slice(0, 50);

    const name = company?.name || companyName;
    const domain = company?.domain || company?.website;
    if (!blank(domain)) {
      const hasIdentity = [lead.fullName, lead.firstName, lead.lastName, lead.email, lead.phone, ...(lead.emails ?? []), ...(lead.phones ?? [])].some((v) => !blank(v));
      // A lead that cannot become a contact must not leave a company behind; the upsert reports why.
      if (hasIdentity) {
        const row = await this.prisma.db.$transaction((tx) =>
          this.contacts.findOrCreateCompany(
            tx,
            workspaceId,
            { name, domain: company?.domain || null, website: company?.website || null, industry: company?.industry, country: company?.country, city: company?.city, description: company?.description },
            actorId(ctx),
          ),
        );
        if (row) contact.companyId = row.id;
      }
    } else if (!blank(name)) {
      contact.companyName = name;
    }
    return contact;
  }
}
