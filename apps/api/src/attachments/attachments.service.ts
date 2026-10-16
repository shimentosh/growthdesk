import { Injectable } from "@nestjs/common";
import type { Response } from "express";
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_WORKSPACE_MAX_BYTES,
  cleanFileName,
  isBlockedFileName,
  looksExecutable,
  sniffContentType,
  type AttachmentEntityType,
  type AttachmentUploadInputT,
} from "@growthdesk/shared";
import type { Prisma } from "../generated/prisma/client.js";
import { PrismaService, type Tx } from "../prisma/prisma.service.js";
import { ActivityService } from "../crm/activity.service.js";
import { AuditService } from "../core/audit.service.js";
import { sha256 } from "../common/crypto.js";
import { badRequest, conflict, forbidden, notFound } from "../common/errors.js";
import { actorId, holds, ownershipScope, ws, type RequestContext } from "../common/context.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MB = 1024 * 1024;

/** Which permission reads, and which writes, each kind of record's files. */
const PERMS: Record<AttachmentEntityType, { read: string; write: string; label: string }> = {
  contact: { read: "contacts.read", write: "contacts.write", label: "That contact" },
  company: { read: "contacts.read", write: "contacts.write", label: "That company" },
  deal: { read: "deals.read", write: "deals.write", label: "That deal" },
  quote: { read: "quotes.read", write: "quotes.write", label: "That quote" },
};

/** Never `bytes`: lists and metadata must not pull files out of the database. */
const meta = { id: true, entityType: true, entityId: true, fileName: true, contentType: true, size: true, uploadedById: true, createdAt: true } as const;
type MetaRow = { id: string; entityType: string; entityId: string; fileName: string; contentType: string; size: number; uploadedById: string | null; createdAt: Date };

/** Where a record's file events go on the timeline. A quote's go on its deal, else its contact, else its company. */
type Target = { contactId?: string | null; companyId?: string | null; dealId?: string | null; data?: Record<string, unknown> };

const blockedMessage = "Programs and scripts (.exe, .js, .sh and the like) can't be attached. Zip them, or share a link instead.";

/**
 * Files on contacts, companies, deals and quotes (packages/shared/src/attachments.ts
 * for the limits and type rules). Kept in Postgres like email images; lists
 * never select the bytes. Reading a record's files needs that record's read
 * permission and being able to see it (ownership for contacts, deals and
 * quotes); adding, renaming and removing need its write permission. Adds and
 * removals are on the record's timeline. Removal is soft: the row stays (out
 * of lists, downloads and the workspace total) for the audit trail.
 */
@Injectable()
export class AttachmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
    private readonly audit: AuditService,
  ) {}

  /** Refuses unless the caller may `need` this kind of record's files and can see this record. Returns its timeline target. */
  private async entity(ctx: RequestContext, type: AttachmentEntityType, id: string, need: "read" | "write"): Promise<Target> {
    const w = ws(ctx);
    const p = PERMS[type];
    if (!holds(ctx, p[need])) throw forbidden();
    if (!UUID.test(id)) throw notFound(p.label);
    const found = await (async (): Promise<Target | null> => {
      switch (type) {
        case "contact": {
          const c = await this.prisma.db.contact.findFirst({ where: { id, workspaceId: w.id, deletedAt: null, ...(ownershipScope(ctx) as Prisma.ContactWhereInput) }, select: { id: true } });
          return c ? { contactId: c.id } : null;
        }
        case "company": {
          const c = await this.prisma.db.company.findFirst({ where: { id, workspaceId: w.id, deletedAt: null }, select: { id: true } });
          return c ? { companyId: c.id } : null;
        }
        case "deal": {
          const d = await this.prisma.db.deal.findFirst({ where: { id, workspaceId: w.id, deletedAt: null, ...(ownershipScope(ctx) as Prisma.DealWhereInput) }, select: { id: true } });
          return d ? { dealId: d.id } : null;
        }
        case "quote": {
          const q = await this.prisma.db.quote.findFirst({ where: { id, workspaceId: w.id, deletedAt: null, ...(ownershipScope(ctx) as Prisma.QuoteWhereInput) }, select: { id: true, dealId: true, contactId: true, companyId: true } });
          if (!q) return null;
          return { ...(q.dealId ? { dealId: q.dealId } : q.contactId ? { contactId: q.contactId } : { companyId: q.companyId }), data: { quoteId: q.id } };
        }
      }
    })();
    if (!found) throw notFound(p.label);
    return found;
  }

  private async views(rows: MetaRow[]) {
    const ids = [...new Set(rows.map((r) => r.uploadedById).filter((x): x is string => Boolean(x)))];
    const users = ids.length ? await this.prisma.db.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
    const byId = new Map(users.map((u) => [u.id, u]));
    return rows.map((r) => ({ id: r.id, entityType: r.entityType, entityId: r.entityId, fileName: r.fileName, contentType: r.contentType, size: r.size, uploadedBy: r.uploadedById ? (byId.get(r.uploadedById) ?? null) : null, createdAt: r.createdAt }));
  }

  private used(db: Pick<Tx, "attachment">, workspaceId: string) {
    return db.attachment.aggregate({ where: { workspaceId, deletedAt: null }, _sum: { size: true } }).then((r) => r._sum.size ?? 0);
  }

  async list(ctx: RequestContext, type: AttachmentEntityType, entityId: string) {
    const w = ws(ctx);
    await this.entity(ctx, type, entityId, "read");
    const [rows, used] = await Promise.all([
      this.prisma.db.attachment.findMany({ where: { workspaceId: w.id, entityType: type, entityId, deletedAt: null }, orderBy: { createdAt: "desc" }, take: 500, select: meta }),
      this.used(this.prisma.db, w.id),
    ]);
    return { items: await this.views(rows), limits: { fileBytes: ATTACHMENT_MAX_BYTES, workspaceBytes: ATTACHMENT_WORKSPACE_MAX_BYTES, usedBytes: used } };
  }

  async upload(ctx: RequestContext, input: AttachmentUploadInputT) {
    const w = ws(ctx);
    const target = await this.entity(ctx, input.entityType, input.entityId, "write");
    const fileName = cleanFileName(input.fileName);
    if (isBlockedFileName(fileName)) throw badRequest(blockedMessage, { fileName: "This type of file can't be attached" });

    let payload = input.data.trim();
    const dataUrl = /^data:[^,]*?(;base64)?,/i.exec(payload);
    if (dataUrl) {
      if (!dataUrl[1]) throw badRequest("Upload the file as base64", { data: "Not base64" });
      payload = payload.slice(dataUrl[0].length);
    }
    payload = payload.replace(/\s+/g, "");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) throw badRequest("The file could not be read (not base64)", { data: "Not base64" });
    const bytes = Buffer.from(payload, "base64");
    if (!bytes.length) throw badRequest("The file is empty", { data: "Empty file" });
    if (bytes.length > ATTACHMENT_MAX_BYTES) throw badRequest(`Files can be up to ${ATTACHMENT_MAX_BYTES / MB} MB — this one is ${(bytes.length / MB).toFixed(1)} MB`, { data: "Too large" });
    if (looksExecutable(bytes)) throw badRequest(blockedMessage, { data: "This type of file can't be attached" });
    const contentType = sniffContentType(bytes, fileName);

    const row = await this.prisma.db.$transaction(async (tx) => {
      // One upload at a time per workspace, so parallel uploads cannot pass the total together.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`attachments:${w.id}`}))`;
      const used = await this.used(tx, w.id);
      if (used + bytes.length > ATTACHMENT_WORKSPACE_MAX_BYTES) {
        throw conflict(`This workspace's files already use ${(used / MB).toFixed(0)} MB of ${ATTACHMENT_WORKSPACE_MAX_BYTES / MB / 1024} GB. Remove files you no longer need, then try again.`, { data: "File storage is full" });
      }
      const created = await tx.attachment.create({
        data: { workspaceId: w.id, entityType: input.entityType, entityId: input.entityId, fileName, contentType, size: bytes.length, sha256: sha256(bytes), bytes: new Uint8Array(bytes), uploadedById: actorId(ctx) },
        select: meta,
      });
      await this.activity.log({ workspaceId: w.id, contactId: target.contactId, companyId: target.companyId, dealId: target.dealId, type: "file.added", summary: `File added: ${fileName}`, data: { attachmentId: created.id, fileName, size: bytes.length, ...target.data } }, tx);
      return created;
    });
    await this.audit.record(ctx, { action: "attachment.uploaded", targetType: "attachment", targetId: row.id, metadata: { entityType: input.entityType, entityId: input.entityId, contentType, size: row.size } });
    return (await this.views([row]))[0]!;
  }

  /** The row (no bytes) and its record, checked for `need`. */
  private async find(ctx: RequestContext, id: string, need: "read" | "write") {
    const w = ws(ctx);
    if (!UUID.test(id)) throw notFound("That file");
    const row = await this.prisma.db.attachment.findFirst({ where: { id, workspaceId: w.id, deletedAt: null }, select: meta });
    if (!row) throw notFound("That file");
    const target = await this.entity(ctx, row.entityType as AttachmentEntityType, row.entityId, need);
    return { row, target };
  }

  /** Always a download, never rendered: attachment disposition, the stored (sniffed) type, nosniff and a sandboxing CSP. */
  async download(ctx: RequestContext, id: string, res: Response) {
    const w = ws(ctx);
    const { row } = await this.find(ctx, id, "read");
    const file = await this.prisma.db.attachment.findFirst({ where: { id: row.id, workspaceId: w.id }, select: { bytes: true } });
    if (!file) throw notFound("That file");
    const ascii = row.fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
    res.status(200);
    res.setHeader("Content-Type", row.contentType);
    res.setHeader("Content-Length", String(file.bytes.length));
    res.setHeader("Content-Disposition", `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(row.fileName)}`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.setHeader("Cache-Control", "private, no-store");
    res.end(Buffer.from(file.bytes));
  }

  async rename(ctx: RequestContext, id: string, name: string) {
    const w = ws(ctx);
    const { row } = await this.find(ctx, id, "write");
    const fileName = cleanFileName(name);
    if (isBlockedFileName(fileName)) throw badRequest(blockedMessage, { fileName: "Choose another extension" });
    const updated = await this.prisma.db.attachment.update({ where: { id: row.id, workspaceId: w.id }, data: { fileName }, select: meta });
    await this.audit.record(ctx, { action: "attachment.renamed", targetType: "attachment", targetId: row.id, metadata: { from: row.fileName, to: fileName } });
    return (await this.views([updated]))[0]!;
  }

  async remove(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    const { row, target } = await this.find(ctx, id, "write");
    await this.prisma.db.$transaction(async (tx) => {
      await tx.attachment.updateMany({ where: { id: row.id, workspaceId: w.id, deletedAt: null }, data: { deletedAt: new Date() } });
      await this.activity.log({ workspaceId: w.id, contactId: target.contactId, companyId: target.companyId, dealId: target.dealId, type: "file.removed", summary: `File removed: ${row.fileName}`, data: { attachmentId: row.id, fileName: row.fileName, ...target.data } }, tx);
    });
    await this.audit.record(ctx, { action: "attachment.deleted", targetType: "attachment", targetId: row.id, metadata: { entityType: row.entityType, entityId: row.entityId, fileName: row.fileName } });
    return { deleted: true };
  }
}
