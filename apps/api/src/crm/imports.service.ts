import { Injectable, Logger } from "@nestjs/common";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import { type ContactFilterT, type ContactInputT, IMPORT_FIELDS, isUnlimited } from "@growthdesk/shared";
import { PrismaService } from "../prisma/prisma.service.js";
import { EntitlementsService } from "../billing/entitlements.service.js";
import { EventsService } from "../core/events.service.js";
import { Queues } from "../queues/queues.js";
import { queueConfirmations } from "../marketing/double-opt-in.js";
import { ContactsService } from "./contacts.service.js";
import { badRequest, isApiError, notFound } from "../common/errors.js";
import { actorId, ws, type RequestContext } from "../common/context.js";

const MAX_ROWS = 50_000;
const CHUNK = 200;
const MAX_ERRORS = 500;

/** Header → field guesses for the mapping screen. */
const GUESSES: [RegExp, string][] = [
  [/^(e-?mail|email address|work email)$/i, "email"],
  [/^(first ?name|given name|fname)$/i, "firstName"],
  [/^(last ?name|surname|family name|lname)$/i, "lastName"],
  [/^(full ?name|name|contact name|contact)$/i, "fullName"],
  [/^(phone|phone number|mobile|tel|telephone|cell)$/i, "phone"],
  [/^(title|job title|position|role)$/i, "jobTitle"],
  [/^(company|company name|organi[sz]ation|account)$/i, "company"],
  [/^(domain|company domain)$/i, "companyDomain"],
  [/^(website|url|site|company website)$/i, "website"],
  [/^(linkedin|linkedin url|linkedin profile)$/i, "linkedinUrl"],
  [/^(city|town)$/i, "city"],
  [/^(country)$/i, "country"],
  [/^(source|lead source)$/i, "leadSource"],
  [/^(tags?|labels?)$/i, "tags"],
  [/^(id|external id|lead id|record id)$/i, "externalId"],
  [/^(notes?|comment|comments)$/i, "notes"],
];

type Row = Record<string, string>;

export function parseCsv(csv: string): { headers: string[]; rows: Row[] } {
  let records: string[][];
  try {
    records = parse(csv.replace(/^﻿/, ""), { skip_empty_lines: true, relax_column_count: true, trim: true, bom: true }) as string[][];
  } catch (e) {
    throw badRequest(`That file could not be read as CSV: ${e instanceof Error ? e.message : String(e)}`);
  }
  const [header, ...body] = records;
  if (!header?.length) throw badRequest("The file has no header row.");
  const headers = header.map((h, i) => h.trim() || `Column ${i + 1}`);
  if (new Set(headers).size !== headers.length) throw badRequest("Two columns share a header name — rename one and try again.");
  return { headers, rows: body.map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? "").trim()]))) };
}

/** One CSV row, through its mapping, into a contact input. */
export function rowToContact(row: Row, mapping: Record<string, string>): { input: ContactInputT & { notes?: string }; externalId: string | null } {
  const input: ContactInputT & { notes?: string } = {};
  const custom: Record<string, string> = {};
  let externalId: string | null = null;
  let companyDomain = "";
  for (const [header, field] of Object.entries(mapping)) {
    const value = row[header]?.trim() ?? "";
    if (!field || !value) continue;
    if (field.startsWith("custom.")) {
      custom[field.slice(7)] = value;
      continue;
    }
    switch (field) {
      case "company":
        input.companyName = value;
        break;
      case "companyDomain":
        companyDomain = value;
        break;
      case "tags":
        input.tags = value.split(/[;,|]/).map((t) => t.trim()).filter(Boolean).slice(0, 20);
        break;
      case "externalId":
        externalId = value;
        break;
      case "notes":
        input.notes = value.slice(0, 5000);
        break;
      case "email":
      case "phone":
      case "firstName":
      case "lastName":
      case "fullName":
      case "jobTitle":
      case "website":
      case "linkedinUrl":
      case "city":
      case "country":
      case "leadSource":
        (input as Record<string, string>)[field] = value;
        break;
    }
  }
  if (companyDomain && !input.website) input.website = companyDomain;
  if (companyDomain && !input.companyName) input.companyName = companyDomain;
  if (Object.keys(custom).length) input.customFields = custom;
  return { input, externalId };
}

@Injectable()
export class ImportsService {
  private readonly log = new Logger("imports");

  constructor(
    private readonly prisma: PrismaService,
    private readonly contacts: ContactsService,
    private readonly entitlements: EntitlementsService,
    private readonly events: EventsService,
    private readonly queues: Queues,
  ) {}

  preview(csv: string) {
    const { headers, rows } = parseCsv(csv);
    const suggested: Record<string, string> = {};
    const used = new Set<string>();
    for (const h of headers) {
      const hit = GUESSES.find(([re, field]) => re.test(h.trim()) && !used.has(field));
      if (hit) {
        suggested[h] = hit[1];
        used.add(hit[1]);
      } else suggested[h] = "";
    }
    return { headers, sample: rows.slice(0, 10), totalRows: rows.length, suggested, fields: IMPORT_FIELDS };
  }

  async start(
    ctx: RequestContext,
    input: { fileName: string; csv: string; mapping: Record<string, string>; tags: string[]; onDuplicate: "update" | "skip"; leadSource?: string; defaultCountry?: string; listId?: string | null; newListName?: string },
  ) {
    const w = ws(ctx);
    await this.entitlements.assertFullAccess(w.billingAccountId, "Importing");
    const { headers, rows } = parseCsv(input.csv);
    if (!rows.length) throw badRequest("The file has a header row but no contacts.");
    if (rows.length > MAX_ROWS) throw badRequest(`One import can hold up to ${MAX_ROWS.toLocaleString()} rows; split the file.`);
    const targets = Object.values(input.mapping).filter(Boolean);
    const allowed = new Set<string>(IMPORT_FIELDS);
    const bad = targets.filter((t) => !allowed.has(t) && !/^custom\.[a-z][a-z0-9_]{0,39}$/.test(t));
    if (bad.length) throw badRequest(`Unknown destination field: ${bad.join(", ")}`);
    const unknownHeaders = Object.keys(input.mapping).filter((h) => !headers.includes(h));
    if (unknownHeaders.length) throw badRequest(`The mapping names columns that are not in the file: ${unknownHeaders.join(", ")}`);
    if (!targets.some((t) => ["email", "phone", "fullName", "firstName", "lastName"].includes(t))) {
      throw badRequest("Map at least one of: email, phone, or a name column.");
    }
    // Imported people land in a lead list: one chosen, or a new one made for this file.
    let listId: string | null = null;
    if (input.listId) {
      const list = await this.prisma.db.marketingList.findFirst({ where: { id: input.listId, workspaceId: w.id } });
      if (!list) throw notFound("That list");
      if (list.archivedAt) throw badRequest("That list is archived. Restore it, or choose another list.");
      listId = list.id;
    } else if (input.newListName?.trim()) {
      const list = await this.prisma.db.marketingList.create({ data: { workspaceId: w.id, name: input.newListName.trim(), description: `Imported from ${input.fileName}`, createdById: actorId(ctx) } });
      listId = list.id;
    }
    const row = await this.prisma.db.import.create({
      data: {
        workspaceId: w.id,
        source: "csv",
        fileName: input.fileName,
        mapping: input.mapping,
        options: { tags: input.tags, onDuplicate: input.onDuplicate, leadSource: input.leadSource ?? "", defaultCountry: input.defaultCountry ?? "", listId },
        rows: rows as never,
        totalRows: rows.length,
        createdById: actorId(ctx),
      },
    });
    await this.queues.add("imports", "process", { workspaceId: w.id, importId: row.id }, { jobId: `import-${row.id}` });
    return { id: row.id, totalRows: rows.length, status: row.status, listId };
  }

  /**
   * Processes an import in chunks, saving progress after each, so a worker
   * restart resumes where it stopped rather than starting again.
   */
  async process(workspaceId: string, importId: string) {
    const imp = await this.prisma.db.import.findFirst({ where: { id: importId, workspaceId } });
    if (!imp || imp.status === "completed" || imp.status === "failed") return;
    const ws = await this.prisma.db.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
    const rows = (imp.rows ?? []) as Row[];
    const mapping = imp.mapping as Record<string, string>;
    const options = imp.options as { tags?: string[]; onDuplicate?: "update" | "skip"; leadSource?: string; defaultCountry?: string; listId?: string | null };
    const list = options.listId ? await this.prisma.db.marketingList.findFirst({ where: { id: options.listId, workspaceId }, select: { id: true, name: true, doubleOptIn: true } }) : null;
    const listId = list?.id ?? null;
    const listSource = `Import: ${imp.fileName ?? "file"}`;
    const errors = [...((imp.errors ?? []) as { row: number; message: string }[])];
    let { processedRows, createdCount, updatedCount, skippedCount, failedCount } = imp;
    await this.prisma.db.import.update({ where: { id: imp.id, workspaceId }, data: { status: "processing", startedAt: imp.startedAt ?? new Date() } });

    const defaultCountry = options.defaultCountry || (await this.contacts.defaultCountry(workspaceId));
    while (processedRows < rows.length) {
      const chunk = rows.slice(processedRows, processedRows + CHUNK);
      let remaining = await this.entitlements.remaining(ws.billingAccountId, "contacts");
      let subscribersLeft = listId ? await this.entitlements.remaining(ws.billingAccountId, "marketingContacts") : Number.POSITIVE_INFINITY;
      /** Pending memberships (a double opt-in list) to email a confirmation link to after this chunk. */
      const confirmIds: string[] = [];
      for (const [i, raw] of chunk.entries()) {
        const rowNumber = processedRows + i + 2; // 1-based, after the header
        try {
          const { input, externalId } = rowToContact(raw, mapping);
          if (options.tags?.length) input.tags = [...new Set([...(input.tags ?? []), ...options.tags])];
          if (options.leadSource && !input.leadSource) input.leadSource = options.leadSource;
          const res = await this.contacts.upsert(workspaceId, ws.billingAccountId, input, {
            source: imp.source,
            externalId,
            importId: imp.id,
            onDuplicate: options.onDuplicate ?? "update",
            defaultCountry,
            actorId: imp.createdById,
            capacityChecked: true,
            emitEvent: "lead.imported",
            createBlocked: !isUnlimited(remaining) && remaining <= 0 ? "Your plan's contact limit was reached; this row was not created." : undefined,
          });
          // Skipped duplicates still join the list: the file named them as leads for it.
          const held = listId ? await this.prisma.db.listMembership.findFirst({ where: { workspaceId, listId, contactId: res.contactId }, select: { id: true, status: true } }) : null;
          // Still waiting to confirm: the email goes again (the worker sends at most one a day).
          if (held?.status === "pending" && list?.doubleOptIn) confirmIds.push(held.id);
          if (listId && !held) {
            // As in ListsService.addMembers: someone the marketing engine could mail (consent granted, an
            // email) who is on no other list yet takes a subscriber from the plan's allowance.
            const c = await this.prisma.db.contact.findFirst({ where: { id: res.contactId, workspaceId, deletedAt: null }, select: { email: true, consentStatus: true } });
            const counts =
              Boolean(c?.email) && c?.consentStatus === "granted" && !(await this.prisma.db.listMembership.findFirst({ where: { workspaceId, contactId: res.contactId, status: "subscribed" }, select: { id: true } }));
            // A double opt-in list takes anyone without recorded consent as pending, and emails them a link to confirm.
            const confirm = Boolean(list?.doubleOptIn) && c?.consentStatus !== "granted";
            if (confirm && !c?.email) {
              if (errors.length < MAX_ERRORS) errors.push({ row: rowNumber, message: "Saved, but not added to the list: it asks new subscribers to confirm by email, and this row has no email address." });
            } else if (confirm) {
              const [row] = await this.prisma.db.listMembership.createManyAndReturn({
                data: [{ workspaceId, listId, contactId: res.contactId, status: "pending", source: listSource }],
                skipDuplicates: true,
                select: { id: true },
              });
              if (row) confirmIds.push(row.id);
            } else if (counts && !isUnlimited(subscribersLeft) && subscribersLeft <= 0) {
              if (errors.length < MAX_ERRORS) errors.push({ row: rowNumber, message: "Saved, but not added to the list: your plan's marketing subscriber limit was reached." });
            } else {
              const added = await this.prisma.db.$transaction(async (tx) => {
                const r = await tx.listMembership.createMany({
                  data: [{ workspaceId, listId, contactId: res.contactId, status: "subscribed", source: listSource, subscribedAt: new Date() }],
                  skipDuplicates: true,
                });
                // Dispatched by the kick after this chunk.
                if (r.count) {
                  await this.events.emitIn(tx, {
                    workspaceId,
                    type: "list.subscribed",
                    subjectType: "contact",
                    subjectId: res.contactId,
                    payload: { contactId: res.contactId, listId, listName: list?.name ?? "", source: "import", importId: imp.id },
                  });
                }
                return r;
              });
              if (counts && added.count) subscribersLeft -= 1;
            }
          }
          if (res.created) {
            createdCount += 1;
            remaining -= 1;
          } else if (res.updated) updatedCount += 1;
          else skippedCount += 1;
        } catch (e) {
          failedCount += 1;
          if (errors.length < MAX_ERRORS) errors.push({ row: rowNumber, message: isApiError(e) ? e.message : e instanceof Error ? e.message : String(e) });
          if (!isApiError(e)) this.log.warn(`import ${importId} row ${rowNumber}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      processedRows += chunk.length;
      await this.prisma.db.import.update({
        where: { id: imp.id, workspaceId },
        data: { processedRows, createdCount, updatedCount, skippedCount, failedCount, errors: errors as never },
      });
      await this.events.kick();
      if (confirmIds.length) await queueConfirmations(this.queues, workspaceId, confirmIds);
    }
    await this.prisma.db.import.update({ where: { id: imp.id, workspaceId }, data: { status: "completed", finishedAt: new Date() } });
  }

  async markFailed(workspaceId: string, importId: string, message: string) {
    await this.prisma.db.import.updateMany({ where: { id: importId, workspaceId }, data: { status: "failed", finishedAt: new Date(), errors: [{ row: 0, message }] as never } });
  }

  async list(ctx: RequestContext) {
    const w = ws(ctx);
    return this.prisma.db.import.findMany({
      where: { workspaceId: w.id },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: { id: true, source: true, status: true, fileName: true, totalRows: true, processedRows: true, createdCount: true, updatedCount: true, skippedCount: true, failedCount: true, createdAt: true, finishedAt: true },
    });
  }

  async get(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    const imp = await this.prisma.db.import.findFirst({ where: { id, workspaceId: w.id }, omit: { rows: true } });
    if (!imp) throw notFound("That import");
    return imp;
  }

  /** Re-queues a failed or stuck import; processing resumes from the last saved row. */
  async retry(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    const imp = await this.prisma.db.import.findFirst({ where: { id, workspaceId: w.id }, select: { id: true, status: true, rows: true } });
    if (!imp) throw notFound("That import");
    if (imp.status === "completed") throw badRequest("That import has already finished.");
    if (!imp.rows) throw badRequest("The rows for that import are no longer kept; upload the file again.");
    await this.prisma.db.import.update({ where: { id, workspaceId: w.id }, data: { status: "pending" } });
    await this.queues.add("imports", "process", { workspaceId: w.id, importId: id }, { jobId: `import-${id}-${Date.now()}` });
    return { requeued: true };
  }

  /** CSV of the contacts matching a filter. Custom fields become extra columns. */
  async exportCsv(ctx: RequestContext, filter: ContactFilterT): Promise<string> {
    const w = ws(ctx);
    const ids = await this.contacts.idsFor(ctx, filter, 100_000);
    const fields = await this.prisma.db.customFieldDefinition.findMany({ where: { workspaceId: w.id, entity: "contact" }, orderBy: { position: "asc" } });
    const header = ["id", "first_name", "last_name", "full_name", "email", "phone", "job_title", "company", "company_domain", "website", "city", "country", "lead_source", "owner", "status", "qualification", "priority", "tags", "do_not_contact", "last_contacted_at", "next_action_at", "created_at", ...fields.map((f) => `custom_${f.key}`)];
    const lines: unknown[][] = [header];
    for (let i = 0; i < ids.length; i += 1000) {
      const rows = await this.prisma.db.contact.findMany({
        where: { workspaceId: w.id, id: { in: ids.slice(i, i + 1000) } },
        include: { company: true, owner: true, tags: { include: { tag: true } } },
        orderBy: { createdAt: "asc" },
      });
      for (const c of rows) {
        const custom = (c.customFields ?? {}) as Record<string, unknown>;
        lines.push([
          c.id, c.firstName, c.lastName, c.fullName, c.email ?? "", c.phone ?? "", c.jobTitle, c.company?.name ?? "", c.company?.domain ?? "", c.website, c.city, c.country, c.leadSource,
          c.owner?.email ?? "", c.status, c.qualification, c.priority, c.tags.map((t) => t.tag.name).join("; "), c.doNotContact ? "yes" : "no",
          c.lastContactedAt?.toISOString() ?? "", c.nextActionAt?.toISOString() ?? "", c.createdAt.toISOString(),
          ...fields.map((f) => (custom[f.key] === undefined || custom[f.key] === null ? "" : String(custom[f.key]))),
        ]);
      }
    }
    // A leading =, +, - or @ would be run as a formula by spreadsheet apps.
    const safe = lines.map((r) => r.map((v) => (typeof v === "string" && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v)));
    return stringify(safe);
  }
}
