import { Injectable } from "@nestjs/common";
import {
  type ContactFilterT,
  type ContactInputT,
  FREE_MAIL_DOMAINS,
  SORTABLE_CONTACT_FIELDS,
  emailDomain,
  joinName,
  normalizeCompanyName,
  normalizeDomain,
  normalizeEmail,
  normalizePhone,
  splitName,
} from "@growthdesk/shared";
import { Prisma } from "../generated/prisma/client.js";
import { PrismaService, type Tx } from "../prisma/prisma.service.js";
import { EntitlementsService } from "../billing/entitlements.service.js";
import { EventsService } from "../core/events.service.js";
import { ActivityService } from "./activity.service.js";
import { SuppressionService } from "./suppression.service.js";
import { ConsentService } from "./consent.service.js";
import { ApiError, badRequest, conflict, notFound } from "../common/errors.js";
import { actorId, ownershipScope, ws, type RequestContext } from "../common/context.js";

export type UpsertOptions = {
  source: string;
  externalId?: string | null;
  importId?: string | null;
  sourceData?: Record<string, unknown>;
  onDuplicate: "update" | "skip" | "error";
  defaultCountry?: string;
  actorId?: string | null;
  /**
   * Skip the up-front plan check (bulk callers check capacity for the whole batch). Creating a
   * contact is always checked again under the account lock, inside the transaction.
   */
  capacityChecked?: boolean;
  emitEvent?: "contact.created" | "lead.imported";
  /** When set, a row that would create a new contact is refused with this reason (plan limit reached mid-import). */
  createBlocked?: string;
};

export type UpsertResult = {
  contactId: string;
  created: boolean;
  updated: boolean;
  skipped: boolean;
  matchedBy: "external" | "email" | "phone" | null;
};

export const contactInclude = {
  company: { select: { id: true, name: true, domain: true } },
  owner: { select: { id: true, name: true, email: true } },
  tags: { include: { tag: { select: { id: true, name: true, color: true } } } },
} satisfies Prisma.ContactInclude;

type ContactRow = Prisma.ContactGetPayload<{ include: typeof contactInclude }>;

export function contactDto(c: ContactRow) {
  return {
    id: c.id,
    firstName: c.firstName,
    lastName: c.lastName,
    fullName: c.fullName,
    email: c.email,
    phone: c.phone,
    jobTitle: c.jobTitle,
    website: c.website,
    linkedinUrl: c.linkedinUrl,
    city: c.city,
    country: c.country,
    timezone: c.timezone,
    leadSource: c.leadSource,
    company: c.company,
    owner: c.owner,
    priority: c.priority,
    qualification: c.qualification,
    status: c.status,
    score: c.score,
    customFields: c.customFields,
    tags: c.tags.map((t) => t.tag),
    lastContactedAt: c.lastContactedAt,
    lastRepliedAt: c.lastRepliedAt,
    nextActionAt: c.nextActionAt,
    nextActionNote: c.nextActionNote,
    doNotContact: c.doNotContact,
    unsubscribedAt: c.unsubscribedAt,
    bouncedAt: c.bouncedAt,
    consentStatus: c.consentStatus,
    consentSource: c.consentSource,
    consentAt: c.consentAt,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

/** The consent source recorded when the input names none: where the contact came from. */
function consentSourceOf(source: string): string {
  if (source === "manual") return "Added by a team member";
  if (source === "csv") return "CSV import";
  if (source === "api") return "API";
  return source;
}

const blank = (v: unknown) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");

@Injectable()
export class ContactsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly events: EventsService,
    private readonly activity: ActivityService,
    private readonly suppression: SuppressionService,
    private readonly consent: ConsentService,
  ) {}

  // ─── Queries ───────────────────────────────────────────────────────────────

  where(ctx: RequestContext, f: ContactFilterT = {}): Prisma.ContactWhereInput {
    const w = ws(ctx);
    const and: Prisma.ContactWhereInput[] = [];
    if (f.q) {
      const q = f.q.trim();
      and.push({
        OR: [
          { fullName: { contains: q, mode: "insensitive" } },
          { email: { contains: q.toLowerCase() } },
          { phone: { contains: q.replace(/[^\d+]/g, "") || q } },
          { jobTitle: { contains: q, mode: "insensitive" } },
          { company: { name: { contains: q, mode: "insensitive" } } },
        ],
      });
    }
    if (f.status?.length) and.push({ status: { in: f.status } });
    if (f.qualification?.length) and.push({ qualification: { in: f.qualification } });
    if (f.priority?.length) and.push({ priority: { in: f.priority } });
    if (f.ownerId === "me") and.push({ ownerId: ctx.identity?.userId ?? "00000000-0000-0000-0000-000000000000" });
    else if (f.ownerId === "none") and.push({ ownerId: null });
    else if (f.ownerId) and.push({ ownerId: f.ownerId });
    if (f.companyId) and.push({ companyId: f.companyId });
    if (f.tag?.length) and.push({ tags: { some: { tag: { name: { in: f.tag } } } } });
    if (f.leadSource) and.push({ leadSource: { equals: f.leadSource, mode: "insensitive" } });
    if (f.hasEmail !== undefined) and.push(f.hasEmail ? { email: { not: null } } : { email: null });
    if (f.hasPhone !== undefined) and.push(f.hasPhone ? { phone: { not: null } } : { phone: null });
    if (f.noNextAction) and.push({ nextActionAt: null });
    if (f.createdAfter) and.push({ createdAt: { gte: f.createdAfter } });
    if (f.createdBefore) and.push({ createdAt: { lte: f.createdBefore } });
    if (f.campaignId) and.push({ enrollments: { some: { campaignId: f.campaignId } } });
    const scope = ownershipScope(ctx);
    if (Object.keys(scope).length) and.push(scope as Prisma.ContactWhereInput);
    return { workspaceId: w.id, deletedAt: null, ...(and.length ? { AND: and } : {}) };
  }

  async list(ctx: RequestContext, filter: ContactFilterT, page: number, pageSize: number, sort?: string, dir: "asc" | "desc" = "desc") {
    const where = this.where(ctx, filter);
    const field = (SORTABLE_CONTACT_FIELDS as readonly string[]).includes(sort ?? "") ? sort! : "createdAt";
    const [rows, total] = await Promise.all([
      this.prisma.db.contact.findMany({
        where,
        include: contactInclude,
        // `nulls` is only valid on nullable columns.
        orderBy: [{ [field]: ["lastContactedAt", "nextActionAt", "score"].includes(field) ? { sort: dir, nulls: "last" } : dir }, { id: "asc" }] as Prisma.ContactOrderByWithRelationInput[],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.db.contact.count({ where }),
    ]);
    return { items: rows.map(contactDto), total, page, pageSize };
  }

  /** Ids matching a filter (bulk actions, campaign audiences, exports). */
  async idsFor(ctx: RequestContext, filter: ContactFilterT, limit = 100_000): Promise<string[]> {
    const rows = await this.prisma.db.contact.findMany({ where: this.where(ctx, filter), select: { id: true }, take: limit, orderBy: { createdAt: "asc" } });
    return rows.map((r) => r.id);
  }

  async get(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    const c = await this.prisma.db.contact.findFirst({
      where: { id, workspaceId: w.id, deletedAt: null, ...(ownershipScope(ctx) as Prisma.ContactWhereInput) },
      include: {
        ...contactInclude,
        identifiers: { orderBy: { createdAt: "asc" } },
        sources: { orderBy: { createdAt: "asc" } },
      },
    });
    if (!c) throw notFound("That contact");
    const [deals, tasks, enrollments, conversations, meetings, calls] = await Promise.all([
      this.prisma.db.deal.findMany({
        where: { workspaceId: w.id, contactId: id, deletedAt: null },
        include: { stage: { select: { id: true, name: true, kind: true } } },
        orderBy: { createdAt: "desc" },
      }),
      this.prisma.db.task.findMany({ where: { workspaceId: w.id, contactId: id, status: "open" }, orderBy: { dueAt: { sort: "asc", nulls: "last" } }, take: 20 }),
      this.prisma.db.enrollment.findMany({
        where: { workspaceId: w.id, contactId: id },
        include: { campaign: { select: { id: true, name: true, status: true } } },
        orderBy: { enrolledAt: "desc" },
      }),
      this.prisma.db.conversation.findMany({
        where: { workspaceId: w.id, contactId: id },
        orderBy: { lastMessageAt: { sort: "desc", nulls: "last" } },
        take: 20,
        select: { id: true, channel: true, subject: true, lastMessageAt: true, unread: true, status: true },
      }),
      this.prisma.db.meeting.findMany({ where: { workspaceId: w.id, contactId: id }, orderBy: { startsAt: "desc" }, take: 20 }),
      this.prisma.db.call.findMany({ where: { workspaceId: w.id, contactId: id }, orderBy: { createdAt: "desc" }, take: 20 }),
    ]);
    const suppressed = await this.suppression.check(w.id, { email: c.email, phone: c.phone });
    return {
      ...contactDto(c),
      identifiers: c.identifiers.map((i) => ({ id: i.id, kind: i.kind, value: i.value, isPrimary: i.isPrimary })),
      sources: c.sources.map((s) => ({ id: s.id, source: s.source, externalId: s.externalId, importId: s.importId, createdAt: s.createdAt })),
      suppressed,
      deals: deals.map((d) => ({ id: d.id, name: d.name, value: Number(d.value), currency: d.currency, status: d.status, stage: d.stage })),
      tasks,
      enrollments: enrollments.map((e) => ({ id: e.id, status: e.status, stopReason: e.stopReason, campaign: e.campaign, enrolledAt: e.enrolledAt, nextRunAt: e.nextRunAt })),
      conversations,
      meetings,
      calls,
    };
  }

  // ─── Writes ────────────────────────────────────────────────────────────────

  async ensureTags(tx: Tx, workspaceId: string, names: string[]): Promise<string[]> {
    const ids: string[] = [];
    for (const raw of [...new Set(names.map((n) => n.trim()).filter(Boolean))]) {
      const tag = await tx.tag.upsert({
        where: { workspaceId_name: { workspaceId, name: raw } },
        create: { workspaceId, name: raw },
        update: {},
      });
      ids.push(tag.id);
    }
    return ids;
  }

  async findOrCreateCompany(tx: Tx, workspaceId: string, input: { name?: string | null; domain?: string | null; website?: string | null; industry?: string; country?: string; city?: string; description?: string }, actor: string | null) {
    const domain = normalizeDomain(input.domain ?? input.website ?? null);
    const name = (input.name ?? "").trim();
    if (domain) {
      const byDomain = await tx.company.findFirst({ where: { workspaceId, domain, deletedAt: null } });
      if (byDomain) return byDomain;
    }
    if (name) {
      const normalized = normalizeCompanyName(name);
      const byName = await tx.company.findFirst({ where: { workspaceId, normalizedName: normalized, deletedAt: null } });
      if (byName) {
        if (domain && !byName.domain) return tx.company.update({ where: { id: byName.id, workspaceId }, data: { domain } });
        return byName;
      }
    }
    if (!name && !domain) return null;
    return tx.company.create({
      data: {
        workspaceId,
        name: name || domain!,
        normalizedName: normalizeCompanyName(name || domain!),
        domain,
        website: input.website ?? (domain ? `https://${domain}` : ""),
        industry: input.industry ?? "",
        country: input.country ?? "",
        city: input.city ?? "",
        description: input.description ?? "",
        createdById: actor,
      },
    });
  }

  /**
   * The single way a contact enters the CRM. Matches, in order: the external
   * source id, any normalised email, any normalised phone. A match is updated
   * (blanks filled, never overwritten), skipped, or refused, per
   * `onDuplicate`; either way the source is attributed, so the same prospect
   * arriving from CSV, the API and an inbound reply is one canonical contact.
   */
  async upsert(workspaceId: string, billingAccountId: string, input: ContactInputT & { notes?: string }, opts: UpsertOptions): Promise<UpsertResult> {
    const emails = [...new Set([input.email ?? null, ...(input.emails ?? [])].map((e) => normalizeEmail(e)).filter((e): e is string => Boolean(e)))];
    const phones = [...new Set([input.phone ?? null, ...(input.phones ?? [])].map((p) => normalizePhone(p, opts.defaultCountry)).filter((p): p is string => Boolean(p)))];

    let { firstName, lastName, fullName } = input;
    if (blank(fullName) && (!blank(firstName) || !blank(lastName))) fullName = joinName(firstName ?? "", lastName ?? "");
    if (!blank(fullName) && blank(firstName) && blank(lastName)) ({ firstName, lastName } = splitName(fullName));
    if (blank(fullName) && !emails.length && !phones.length) {
      throw badRequest("A contact needs at least a name, an email address or a phone number.");
    }

    const attempt = async (): Promise<UpsertResult> =>
      this.prisma.db.$transaction(async (tx) => {
        // 1. Match
        let match: { id: string } | null = null;
        let matchedBy: UpsertResult["matchedBy"] = null;
        if (opts.externalId) {
          const src = await tx.contactSource.findFirst({ where: { workspaceId, source: opts.source, externalId: opts.externalId } });
          if (src) {
            const c = await tx.contact.findFirst({ where: { workspaceId, id: src.contactId } });
            if (c) {
              // A merged contact forwards to the one it was merged into.
              match = { id: c.mergedIntoId ?? c.id };
              matchedBy = "external";
            }
          }
        }
        if (!match && emails.length) {
          const ident = await tx.contactIdentifier.findFirst({ where: { workspaceId, kind: "email", value: { in: emails } } });
          if (ident) {
            match = { id: ident.contactId };
            matchedBy = "email";
          }
        }
        if (!match && phones.length) {
          const ident = await tx.contactIdentifier.findFirst({ where: { workspaceId, kind: "phone", value: { in: phones } } });
          if (ident) {
            match = { id: ident.contactId };
            matchedBy = "phone";
          }
        }

        if (match) {
          const existing = await tx.contact.findFirstOrThrow({ where: { workspaceId, id: match.id } });
          if (opts.onDuplicate === "error") {
            throw conflict(`A contact with that ${matchedBy === "phone" ? "phone number" : "email address"} already exists.`, undefined, { contactId: existing.id });
          }
          await this.attribute(tx, workspaceId, existing.id, opts);
          if (opts.onDuplicate === "skip") return { contactId: existing.id, created: false, updated: false, skipped: true, matchedBy };

          const fill: Prisma.ContactUpdateInput = {};
          const set = <K extends keyof Prisma.ContactUpdateInput>(key: K, current: unknown, next: unknown) => {
            if (blank(current) && !blank(next)) fill[key] = next as never;
          };
          set("firstName", existing.firstName, firstName);
          set("lastName", existing.lastName, lastName);
          set("fullName", existing.fullName, fullName);
          set("jobTitle", existing.jobTitle, input.jobTitle);
          set("website", existing.website, input.website);
          set("linkedinUrl", existing.linkedinUrl, input.linkedinUrl);
          set("city", existing.city, input.city);
          set("country", existing.country, input.country);
          set("timezone", existing.timezone, input.timezone);
          set("leadSource", existing.leadSource, input.leadSource);
          set("email", existing.email, emails[0]);
          set("phone", existing.phone, phones[0]);
          if (existing.score === null && input.score !== undefined && input.score !== null) fill.score = input.score;
          if (!existing.companyId && (input.companyId || input.companyName)) {
            const company = input.companyId
              ? await tx.company.findFirst({ where: { workspaceId, id: input.companyId, deletedAt: null } })
              : await this.findOrCreateCompany(tx, workspaceId, { name: input.companyName, domain: emails[0] && !FREE_MAIL_DOMAINS.has(emailDomain(emails[0])) ? emailDomain(emails[0]) : null }, opts.actorId ?? null);
            if (company) fill.company = { connect: { id: company.id } };
          }
          if (input.customFields) {
            const merged = { ...(input.customFields ?? {}), ...((existing.customFields ?? {}) as Record<string, unknown>) };
            fill.customFields = merged as never;
          }
          if (input.doNotContact && !existing.doNotContact) {
            fill.doNotContact = true;
            fill.status = "do_not_contact";
          }
          let changed = Object.keys(fill).length > 0;
          if (changed) await tx.contact.update({ where: { id: existing.id, workspaceId }, data: fill });
          // Like the other fields, consent only fills a blank: a recorded answer is never overwritten by an import.
          if (existing.consentStatus === "unknown" && input.consentStatus && input.consentStatus !== "unknown") {
            changed =
              (await this.consent.setIn(tx, {
                workspaceId,
                contactId: existing.id,
                status: input.consentStatus,
                source: input.consentSource || consentSourceOf(opts.source),
                detail: { via: opts.source, importId: opts.importId ?? null },
                actorId: opts.actorId ?? null,
              })) || changed;
          }
          await this.addIdentifiers(tx, workspaceId, existing.id, emails, phones, false);
          if (input.tags?.length) await this.tag(tx, workspaceId, [existing.id], input.tags);
          if (input.doNotContact) await this.suppressContact(tx, workspaceId, emails, phones, opts.actorId ?? null);
          if (input.notes) await tx.note.create({ data: { workspaceId, contactId: existing.id, body: input.notes, authorId: opts.actorId ?? null } });
          return { contactId: existing.id, created: false, updated: changed, skipped: false, matchedBy };
        }

        // 2. Create
        if (opts.createBlocked) throw new ApiError(402, "plan_limit", opts.createBlocked);
        // The contact limit, counted under the account's advisory lock: parallel imports and API
        // requests queue here, so together they cannot overshoot it (docs/GAP_PLAN.md §3.1.5).
        await this.entitlements.assertCapacityIn(tx, billingAccountId, "contacts");
        let companyId = input.companyId ?? null;
        if (companyId) {
          const company = await tx.company.findFirst({ where: { workspaceId, id: companyId, deletedAt: null } });
          if (!company) throw notFound("That company");
        } else {
          // A business email domain links to a company already on file; a company name finds or creates one.
          const domain = emails[0] && !FREE_MAIL_DOMAINS.has(emailDomain(emails[0])) ? emailDomain(emails[0]) : null;
          if (input.companyName) {
            companyId = (await this.findOrCreateCompany(tx, workspaceId, { name: input.companyName, domain }, opts.actorId ?? null))?.id ?? null;
          } else if (domain) {
            companyId = (await tx.company.findFirst({ where: { workspaceId, domain, deletedAt: null } }))?.id ?? null;
          }
        }
        if (input.ownerId) {
          const owner = await tx.membership.findUnique({ where: { workspaceId_userId: { workspaceId, userId: input.ownerId } } });
          if (!owner) throw badRequest("The owner must be a member of this workspace");
        }
        const contact = await tx.contact.create({
          data: {
            workspaceId,
            companyId,
            firstName: firstName ?? "",
            lastName: lastName ?? "",
            fullName: fullName ?? "",
            email: emails[0] ?? null,
            phone: phones[0] ?? null,
            jobTitle: input.jobTitle ?? "",
            website: input.website ?? "",
            linkedinUrl: input.linkedinUrl ?? "",
            city: input.city ?? "",
            country: input.country ?? "",
            timezone: input.timezone ?? "",
            leadSource: input.leadSource ?? (opts.source === "manual" ? "" : opts.source),
            ownerId: input.ownerId ?? null,
            priority: input.priority ?? "medium",
            qualification: input.qualification ?? "unqualified",
            status: input.doNotContact ? "do_not_contact" : (input.status ?? "new"),
            score: input.score ?? null,
            customFields: (input.customFields ?? {}) as never,
            nextActionAt: input.nextActionAt ?? null,
            nextActionNote: input.nextActionNote ?? "",
            doNotContact: input.doNotContact ?? false,
            createdById: opts.actorId ?? null,
          },
        });
        if (input.consentStatus && input.consentStatus !== "unknown") {
          await this.consent.setIn(tx, {
            workspaceId,
            contactId: contact.id,
            status: input.consentStatus,
            source: input.consentSource || consentSourceOf(opts.source),
            detail: { via: opts.source, importId: opts.importId ?? null },
            actorId: opts.actorId ?? null,
          });
        } else if (input.consentSource) {
          await tx.contact.update({ where: { id: contact.id, workspaceId }, data: { consentSource: input.consentSource } });
        }
        await this.addIdentifiers(tx, workspaceId, contact.id, emails, phones, true);
        await this.attribute(tx, workspaceId, contact.id, opts);
        if (input.tags?.length) await this.tag(tx, workspaceId, [contact.id], input.tags);
        if (input.doNotContact) await this.suppressContact(tx, workspaceId, emails, phones, opts.actorId ?? null);
        if (input.notes) await tx.note.create({ data: { workspaceId, contactId: contact.id, body: input.notes, authorId: opts.actorId ?? null } });
        await this.flagLikelyDuplicates(tx, workspaceId, contact.id, fullName ?? "", companyId, emails);
        await this.activity.log(
          { workspaceId, contactId: contact.id, companyId, actorId: opts.actorId, type: "contact.created", summary: `Contact created (${opts.source})`, data: { source: opts.source, importId: opts.importId } },
          tx,
        );
        await this.events.emitIn(tx, {
          workspaceId,
          type: opts.emitEvent ?? "contact.created",
          subjectType: "contact",
          subjectId: contact.id,
          actorId: opts.actorId,
          payload: { source: opts.source, importId: opts.importId ?? null },
        });
        return { contactId: contact.id, created: true, updated: false, skipped: false, matchedBy: null };
      });

    if (!opts.capacityChecked) await this.entitlements.assertCapacity(billingAccountId, "contacts");
    try {
      return await attempt();
    } catch (e) {
      // Two writers creating the same identifier at once: the loser retries and matches.
      if ((e as { code?: string }).code === "P2002") return attempt();
      throw e;
    }
  }

  private async attribute(tx: Tx, workspaceId: string, contactId: string, opts: UpsertOptions) {
    if (opts.externalId) {
      await tx.contactSource.upsert({
        where: { workspaceId_source_externalId: { workspaceId, source: opts.source, externalId: opts.externalId } },
        create: { workspaceId, contactId, source: opts.source, externalId: opts.externalId, importId: opts.importId ?? null, data: (opts.sourceData ?? undefined) as never },
        update: { importId: opts.importId ?? undefined, data: (opts.sourceData ?? undefined) as never },
      });
    } else if (opts.source !== "manual" || opts.importId) {
      await tx.contactSource.create({ data: { workspaceId, contactId, source: opts.source, importId: opts.importId ?? null, data: (opts.sourceData ?? undefined) as never } });
    }
  }

  private async addIdentifiers(tx: Tx, workspaceId: string, contactId: string, emails: string[], phones: string[], primaryFirst: boolean) {
    const add = async (kind: "email" | "phone", value: string, isPrimary: boolean) => {
      const owner = await tx.contactIdentifier.findFirst({ where: { workspaceId, kind, value } });
      if (owner) {
        // Already someone else's: record it for review rather than move it.
        if (owner.contactId !== contactId) {
          const [a, b] = [owner.contactId, contactId].sort();
          await tx.duplicateCandidate.upsert({
            where: { workspaceId_contactId_duplicateId: { workspaceId, contactId: a!, duplicateId: b! } },
            create: { workspaceId, contactId: a!, duplicateId: b!, reason: `Both use ${value}`, score: 90 },
            update: {},
          });
        }
        return;
      }
      await tx.contactIdentifier.create({ data: { workspaceId, contactId, kind, value, isPrimary } });
    };
    for (const [i, e] of emails.entries()) await add("email", e, primaryFirst && i === 0);
    for (const [i, p] of phones.entries()) await add("phone", p, primaryFirst && i === 0);
  }

  private async suppressContact(tx: Tx, workspaceId: string, emails: string[], phones: string[], actor: string | null) {
    for (const e of emails) await this.suppression.add(workspaceId, "email", e, "do_not_contact", "contact", actor, tx);
    for (const p of phones) await this.suppression.add(workspaceId, "phone", p, "do_not_contact", "contact", actor, tx);
  }

  /** Same person under a different address: same normalised name at the same company, or same name and email domain. */
  private async flagLikelyDuplicates(tx: Tx, workspaceId: string, contactId: string, fullName: string, companyId: string | null, emails: string[]) {
    const name = fullName.trim();
    if (name.split(/\s+/).length < 2) return;
    const domains = emails.map(emailDomain).filter((d) => !FREE_MAIL_DOMAINS.has(d));
    const or: Prisma.ContactWhereInput[] = [];
    if (companyId) or.push({ companyId });
    for (const d of domains) or.push({ email: { endsWith: `@${d}` } });
    if (!or.length) return;
    const similar = await tx.contact.findMany({
      where: { workspaceId, deletedAt: null, id: { not: contactId }, fullName: { equals: name, mode: "insensitive" }, OR: or },
      select: { id: true },
      take: 5,
    });
    for (const s of similar) {
      const [a, b] = [s.id, contactId].sort();
      await tx.duplicateCandidate.upsert({
        where: { workspaceId_contactId_duplicateId: { workspaceId, contactId: a!, duplicateId: b! } },
        create: { workspaceId, contactId: a!, duplicateId: b!, reason: `Same name (${name}) at the same company`, score: 70 },
        update: {},
      });
    }
  }

  async tag(tx: Tx, workspaceId: string, contactIds: string[], names: string[]) {
    const tagIds = await this.ensureTags(tx, workspaceId, names);
    await tx.contactTag.createMany({
      data: contactIds.flatMap((contactId) => tagIds.map((tagId) => ({ workspaceId, contactId, tagId }))),
      skipDuplicates: true,
    });
  }

  async create(ctx: RequestContext, input: ContactInputT) {
    const w = ws(ctx);
    const res = await this.upsert(w.id, w.billingAccountId, input, { source: "manual", onDuplicate: "error", actorId: actorId(ctx), defaultCountry: await this.defaultCountry(w.id) });
    await this.events.kick();
    return this.get(ctx, res.contactId);
  }

  async defaultCountry(workspaceId: string): Promise<string | undefined> {
    const row = await this.prisma.db.workspace.findUnique({ where: { id: workspaceId }, select: { settings: true } });
    const c = (row?.settings as { defaultCountry?: string } | null)?.defaultCountry;
    return c && /^[A-Z]{2}$/.test(c) ? c : undefined;
  }

  async update(ctx: RequestContext, id: string, input: ContactInputT) {
    const w = ws(ctx);
    const existing = await this.prisma.db.contact.findFirst({ where: { id, workspaceId: w.id, deletedAt: null, ...(ownershipScope(ctx) as Prisma.ContactWhereInput) } });
    if (!existing) throw notFound("That contact");
    const country = await this.defaultCountry(w.id);
    await this.prisma.db.$transaction(async (tx) => {
      const data: Prisma.ContactUpdateInput = {};
      for (const key of ["firstName", "lastName", "jobTitle", "website", "linkedinUrl", "city", "country", "timezone", "leadSource", "priority", "qualification", "status", "score", "nextActionAt", "nextActionNote"] as const) {
        if (input[key] !== undefined) (data as Record<string, unknown>)[key] = input[key];
      }
      if (input.fullName !== undefined) data.fullName = input.fullName;
      else if (input.firstName !== undefined || input.lastName !== undefined) {
        data.fullName = joinName(input.firstName ?? existing.firstName, input.lastName ?? existing.lastName);
      }
      if (input.customFields !== undefined) data.customFields = { ...((existing.customFields ?? {}) as object), ...input.customFields } as never;
      if (input.ownerId !== undefined) {
        if (input.ownerId) {
          const m = await tx.membership.findUnique({ where: { workspaceId_userId: { workspaceId: w.id, userId: input.ownerId } } });
          if (!m) throw badRequest("The owner must be a member of this workspace");
          data.owner = { connect: { id: input.ownerId } };
        } else data.owner = { disconnect: true };
      }
      if (input.companyId !== undefined) {
        if (input.companyId) {
          const c = await tx.company.findFirst({ where: { id: input.companyId, workspaceId: w.id, deletedAt: null } });
          if (!c) throw notFound("That company");
          data.company = { connect: { id: c.id } };
        } else data.company = { disconnect: true };
      } else if (input.companyName) {
        const c = await this.findOrCreateCompany(tx, w.id, { name: input.companyName }, actorId(ctx));
        if (c) data.company = { connect: { id: c.id } };
      }
      if (input.email !== undefined) {
        const email = input.email ? normalizeEmail(input.email) : null;
        if (input.email && !email) throw badRequest("That email address is not valid", { email: "Invalid" });
        if (email && email !== existing.email) {
          const taken = await tx.contactIdentifier.findFirst({ where: { workspaceId: w.id, kind: "email", value: email, contactId: { not: id } } });
          if (taken) throw conflict("Another contact already uses that email address.", undefined, { contactId: taken.contactId });
          await this.addIdentifiers(tx, w.id, id, [email], [], false);
          await tx.contactIdentifier.updateMany({ where: { workspaceId: w.id, contactId: id, kind: "email" }, data: { isPrimary: false } });
          await tx.contactIdentifier.updateMany({ where: { workspaceId: w.id, contactId: id, kind: "email", value: email }, data: { isPrimary: true } });
        }
        data.email = email;
      }
      if (input.phone !== undefined) {
        const phone = input.phone ? normalizePhone(input.phone, country) : null;
        if (input.phone && !phone) throw badRequest("That phone number is not valid — include the country code", { phone: "Invalid" });
        if (phone && phone !== existing.phone) {
          const taken = await tx.contactIdentifier.findFirst({ where: { workspaceId: w.id, kind: "phone", value: phone, contactId: { not: id } } });
          if (taken) throw conflict("Another contact already uses that phone number.", undefined, { contactId: taken.contactId });
          await this.addIdentifiers(tx, w.id, id, [], [phone], false);
        }
        data.phone = phone;
      }
      if (input.doNotContact !== undefined) {
        data.doNotContact = input.doNotContact;
        if (input.doNotContact) {
          data.status = "do_not_contact";
          await this.suppressContact(tx, w.id, existing.email ? [existing.email] : [], existing.phone ? [existing.phone] : [], actorId(ctx));
        }
      }
      await tx.contact.update({ where: { id, workspaceId: w.id }, data });
      if (input.consentStatus !== undefined || input.consentSource !== undefined) {
        await this.consent.setIn(tx, {
          workspaceId: w.id,
          contactId: id,
          status: input.consentStatus ?? existing.consentStatus,
          source: input.consentSource ?? existing.consentSource,
          detail: { via: "manual" },
          actorId: actorId(ctx),
        });
      }
      if (input.tags) {
        await tx.contactTag.deleteMany({ where: { workspaceId: w.id, contactId: id } });
        if (input.tags.length) await this.tag(tx, w.id, [id], input.tags);
      }
      if (input.qualification === "qualified" && existing.qualification !== "qualified") {
        await this.events.emitIn(tx, { workspaceId: w.id, type: "contact.qualified", subjectType: "contact", subjectId: id, actorId: actorId(ctx) });
        await this.activity.log({ workspaceId: w.id, contactId: id, actorId: actorId(ctx), type: "contact.qualified", summary: "Marked as qualified" }, tx);
      }
      if (input.ownerId !== undefined && input.ownerId !== existing.ownerId) {
        await this.activity.log({ workspaceId: w.id, contactId: id, actorId: actorId(ctx), type: "contact.assigned", summary: input.ownerId ? "Owner changed" : "Owner removed", data: { ownerId: input.ownerId } }, tx);
      }
      await this.events.emitIn(tx, { workspaceId: w.id, type: "contact.updated", subjectType: "contact", subjectId: id, actorId: actorId(ctx), payload: { fields: Object.keys(data) } });
    });
    await this.events.kick();
    return this.get(ctx, id);
  }

  async remove(ctx: RequestContext, ids: string[]) {
    const w = ws(ctx);
    const res = await this.prisma.db.$transaction(async (tx) => {
      const scoped = await tx.contact.findMany({ where: { workspaceId: w.id, id: { in: ids }, deletedAt: null, ...(ownershipScope(ctx) as Prisma.ContactWhereInput) }, select: { id: true } });
      const scopedIds = scoped.map((s) => s.id);
      // Soft delete: identifiers are released so the address can be re-imported; active sequences stop.
      await tx.contactIdentifier.deleteMany({ where: { workspaceId: w.id, contactId: { in: scopedIds } } });
      await tx.enrollment.updateMany({ where: { workspaceId: w.id, contactId: { in: scopedIds }, status: { in: ["active", "paused"] } }, data: { status: "stopped", stopReason: "Contact deleted", nextRunAt: null } });
      await tx.contact.updateMany({ where: { workspaceId: w.id, id: { in: scopedIds } }, data: { deletedAt: new Date() } });
      return scopedIds.length;
    });
    return { deleted: res };
  }

  /**
   * Merges duplicates into a primary. Every related record moves to the
   * primary; blanks on the primary are filled from the duplicates; the
   * duplicates are soft-deleted and forward to the primary.
   */
  async merge(ctx: RequestContext, primaryId: string, duplicateIds: string[]) {
    const w = ws(ctx);
    const others = duplicateIds.filter((d) => d !== primaryId);
    if (!others.length) throw badRequest("Choose at least one other contact to merge");
    await this.prisma.db.$transaction(async (tx) => {
      const primary = await tx.contact.findFirst({ where: { id: primaryId, workspaceId: w.id, deletedAt: null } });
      if (!primary) throw notFound("The primary contact");
      const dups = await tx.contact.findMany({ where: { id: { in: others }, workspaceId: w.id, deletedAt: null } });
      if (dups.length !== others.length) throw notFound("One of the contacts to merge");
      const fill: Prisma.ContactUpdateInput = {};
      for (const key of ["firstName", "lastName", "fullName", "email", "phone", "jobTitle", "website", "linkedinUrl", "city", "country", "timezone", "leadSource"] as const) {
        if (blank(primary[key])) {
          const v = dups.find((d) => !blank(d[key]))?.[key];
          if (v !== undefined) (fill as Record<string, unknown>)[key] = v;
        }
      }
      if (!primary.companyId) {
        const c = dups.find((d) => d.companyId)?.companyId;
        if (c) fill.company = { connect: { id: c } };
      }
      if (!primary.ownerId) {
        const o = dups.find((d) => d.ownerId)?.ownerId;
        if (o) fill.owner = { connect: { id: o } };
      }
      fill.customFields = Object.assign({}, ...dups.map((d) => d.customFields as object), primary.customFields as object) as never;
      if (dups.some((d) => d.doNotContact)) {
        fill.doNotContact = true;
        fill.status = "do_not_contact";
      }
      await tx.contact.update({ where: { id: primaryId, workspaceId: w.id }, data: fill });

      const move = { where: { workspaceId: w.id, contactId: { in: others } }, data: { contactId: primaryId } };
      await tx.contactIdentifier.updateMany({ ...move, data: { contactId: primaryId, isPrimary: false } });
      await tx.contactSource.updateMany(move);
      await tx.note.updateMany(move);
      await tx.activity.updateMany(move);
      await tx.deal.updateMany(move);
      await tx.task.updateMany(move);
      await tx.meeting.updateMany(move);
      await tx.conversation.updateMany(move);
      await tx.call.updateMany(move);
      const tags = await tx.contactTag.findMany({ where: { workspaceId: w.id, contactId: { in: others } } });
      await tx.contactTag.createMany({ data: tags.map((t) => ({ workspaceId: w.id, contactId: primaryId, tagId: t.tagId })), skipDuplicates: true });
      await tx.contactTag.deleteMany({ where: { workspaceId: w.id, contactId: { in: others } } });
      // Enrollments: keep the primary's; a duplicate's enrollment moves only where the primary has none in that campaign.
      const primaryCampaigns = new Set((await tx.enrollment.findMany({ where: { workspaceId: w.id, contactId: primaryId }, select: { campaignId: true } })).map((e) => e.campaignId));
      for (const e of await tx.enrollment.findMany({ where: { workspaceId: w.id, contactId: { in: others } } })) {
        if (primaryCampaigns.has(e.campaignId)) {
          await tx.enrollment.update({ where: { id: e.id, workspaceId: w.id }, data: { status: "stopped", stopReason: "Merged into another contact", nextRunAt: null } });
        } else {
          await tx.enrollment.update({ where: { id: e.id, workspaceId: w.id }, data: { contactId: primaryId } });
          primaryCampaigns.add(e.campaignId);
        }
      }
      await tx.contact.updateMany({ where: { workspaceId: w.id, id: { in: others } }, data: { deletedAt: new Date(), mergedIntoId: primaryId } });
      await tx.duplicateCandidate.updateMany({
        where: { workspaceId: w.id, status: "open", OR: [{ contactId: { in: [primaryId, ...others] } }, { duplicateId: { in: [primaryId, ...others] } }] },
        data: { status: "merged", resolvedAt: new Date(), resolvedById: actorId(ctx) },
      });
      await this.activity.log({ workspaceId: w.id, contactId: primaryId, actorId: actorId(ctx), type: "contact.merged", summary: `Merged ${others.length} duplicate${others.length > 1 ? "s" : ""}`, data: { mergedIds: others } }, tx);
    });
    return this.get(ctx, primaryId);
  }

  async duplicates(ctx: RequestContext) {
    const w = ws(ctx);
    const rows = await this.prisma.db.duplicateCandidate.findMany({ where: { workspaceId: w.id, status: "open" }, orderBy: [{ score: "desc" }, { createdAt: "desc" }], take: 200 });
    const ids = [...new Set(rows.flatMap((r) => [r.contactId, r.duplicateId]))];
    const contacts = await this.prisma.db.contact.findMany({ where: { workspaceId: w.id, id: { in: ids }, deletedAt: null }, include: contactInclude });
    const byId = new Map(contacts.map((c) => [c.id, contactDto(c)]));
    return rows
      .filter((r) => byId.has(r.contactId) && byId.has(r.duplicateId))
      .map((r) => ({ id: r.id, reason: r.reason, score: r.score, a: byId.get(r.contactId), b: byId.get(r.duplicateId) }));
  }

  async dismissDuplicate(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    const res = await this.prisma.db.duplicateCandidate.updateMany({ where: { id, workspaceId: w.id, status: "open" }, data: { status: "dismissed", resolvedAt: new Date(), resolvedById: actorId(ctx) } });
    if (!res.count) throw notFound("That duplicate suggestion");
  }

  async bulk(ctx: RequestContext, action: { action: string; ids: string[]; tags?: string[]; ownerId?: string | null; status?: string; qualification?: string }) {
    const w = ws(ctx);
    const where = { workspaceId: w.id, id: { in: action.ids }, deletedAt: null, ...(ownershipScope(ctx) as Prisma.ContactWhereInput) };
    switch (action.action) {
      case "tag":
        return this.prisma.db.$transaction(async (tx) => {
          const ids = (await tx.contact.findMany({ where, select: { id: true } })).map((c) => c.id);
          await this.tag(tx, w.id, ids, action.tags ?? []);
          return { affected: ids.length };
        });
      case "untag": {
        const tags = await this.prisma.db.tag.findMany({ where: { workspaceId: w.id, name: { in: action.tags ?? [] } } });
        const res = await this.prisma.db.contactTag.deleteMany({ where: { workspaceId: w.id, contactId: { in: action.ids }, tagId: { in: tags.map((t) => t.id) } } });
        return { affected: res.count };
      }
      case "assign": {
        if (action.ownerId) {
          const m = await this.prisma.db.membership.findUnique({ where: { workspaceId_userId: { workspaceId: w.id, userId: action.ownerId } } });
          if (!m) throw badRequest("The owner must be a member of this workspace");
        }
        const res = await this.prisma.db.contact.updateMany({ where, data: { ownerId: action.ownerId ?? null } });
        return { affected: res.count };
      }
      case "status": {
        const res = await this.prisma.db.contact.updateMany({ where, data: { status: action.status as never } });
        return { affected: res.count };
      }
      case "qualification": {
        const res = await this.prisma.db.contact.updateMany({ where, data: { qualification: action.qualification as never } });
        return { affected: res.count };
      }
      case "delete":
        return { affected: (await this.remove(ctx, action.ids)).deleted };
      default:
        throw badRequest("Unknown bulk action");
    }
  }
}
