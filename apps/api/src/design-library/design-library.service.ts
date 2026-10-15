import { Injectable } from "@nestjs/common";
import {
  designProblems,
  renderLibraryPreview,
  type PlatformEmailDesignImport,
  type PlatformEmailDesignInput,
  type PlatformEmailDesignPreviewInput,
  type PlatformEmailDesignUpdate,
} from "@growthdesk/shared";
import type { z } from "zod";
import type { PlatformEmailDesign } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { AuditService, type AuditInput } from "../core/audit.service.js";
import { DesignsService, readBlocks, readTheme } from "../marketing/designs.service.js";
import { badRequest, conflict, forbidden, notFound } from "../common/errors.js";
import { actorId, type RequestContext } from "../common/context.js";
import { NO_GRANT_MESSAGE } from "../admin/admin-support.service.js";
import { BUILT_IN_DESIGN_KEYS } from "./builtins.js";

/*
 * The email design template library (PlatformEmailDesign): platform staff
 * curate it in the operator console, workspaces browse the published entries
 * and copy one into their own designs.
 *
 * Platform-level, not tenant data: the table carries no workspaceId, so
 * `prisma.db` serves it without the tenant guard getting involved. Deleting
 * leaves a tombstone (deletedAt) so its key is never reused or re-seeded.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORDER = [{ sortOrder: "asc" as const }, { createdAt: "asc" as const }];

/** "Spring sale!" → "spring-sale". */
export const slugOf = (name: string) =>
  name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "design";

type Person = { id: string; name: string; email: string };

@Injectable()
export class DesignLibraryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly designs: DesignsService,
  ) {}

  private record(ctx: RequestContext, input: AuditInput) {
    return this.audit.record(ctx, { workspaceId: null, ...input }, "platform_admin");
  }

  private view(d: PlatformEmailDesign, people?: Map<string, Person>) {
    return {
      id: d.id,
      key: d.key,
      name: d.name,
      description: d.description,
      category: d.category,
      theme: readTheme(d.theme),
      blocks: readBlocks(d.blocks),
      status: d.status,
      sortOrder: d.sortOrder,
      /** Shipped with the product (packages/shared/src/email-library.ts); new workspaces start with a copy. */
      builtIn: BUILT_IN_DESIGN_KEYS.includes(d.key),
      createdBy: d.createdById ? (people?.get(d.createdById) ?? null) : null,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
      publishedAt: d.publishedAt,
    };
  }

  private async people(ids: (string | null | undefined)[]) {
    const unique = [...new Set(ids.filter((v): v is string => Boolean(v)))];
    if (!unique.length) return new Map<string, Person>();
    const users = await this.prisma.db.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true, email: true } });
    return new Map(users.map((u) => [u.id, u]));
  }

  private async find(id: string) {
    if (!UUID.test(id)) throw notFound("That template");
    const row = await this.prisma.db.platformEmailDesign.findFirst({ where: { id, deletedAt: null } });
    if (!row) throw notFound("That template");
    return row;
  }

  /** A free key: the one asked for (or an error), else the name's slug with -2, -3… as needed. Tombstoned keys stay taken. */
  private async freeKey(name: string, wanted?: string) {
    if (wanted) {
      if (await this.prisma.db.platformEmailDesign.findUnique({ where: { key: wanted }, select: { id: true } })) {
        throw conflict("That key is already used by another template (or a deleted one)", { key: "Already used" });
      }
      return wanted;
    }
    const base = slugOf(name);
    const taken = new Set(
      (await this.prisma.db.platformEmailDesign.findMany({ where: { key: { startsWith: base } }, select: { key: true } })).map((r) => r.key),
    );
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  }

  /** New entries go after everything else. */
  private async nextSortOrder() {
    const last = await this.prisma.db.platformEmailDesign.findFirst({ where: { deletedAt: null }, orderBy: { sortOrder: "desc" }, select: { sortOrder: true } });
    return (last?.sortOrder ?? 0) + 10;
  }

  // ─── Admin ─────────────────────────────────────────────────────────────────

  async list() {
    const rows = await this.prisma.db.platformEmailDesign.findMany({ where: { deletedAt: null }, orderBy: ORDER });
    const people = await this.people(rows.map((r) => r.createdById));
    return rows.map((r) => this.view(r, people));
  }

  async get(id: string) {
    const row = await this.find(id);
    return this.view(row, await this.people([row.createdById]));
  }

  async create(ctx: RequestContext, input: z.infer<typeof PlatformEmailDesignInput>) {
    const key = await this.freeKey(input.name, input.key);
    const row = await this.prisma.db.platformEmailDesign.create({
      data: {
        key,
        name: input.name,
        description: input.description,
        category: input.category,
        sortOrder: input.sortOrder ?? (await this.nextSortOrder()),
        theme: input.theme as never,
        blocks: input.blocks as never,
        createdById: actorId(ctx),
      },
    });
    await this.record(ctx, { action: "design_library.created", targetType: "platform_email_design", targetId: row.id, metadata: { key, name: row.name } });
    return this.get(row.id);
  }

  async update(ctx: RequestContext, id: string, input: z.infer<typeof PlatformEmailDesignUpdate>) {
    const before = await this.find(id);
    const fields = Object.keys(input).filter((k) => input[k as keyof typeof input] !== undefined);
    // A published entry must stay sendable: it is in every workspace's gallery.
    if (before.status === "published" && input.blocks) this.assertPublishable(input.blocks);
    await this.prisma.db.platformEmailDesign.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.category !== undefined ? { category: input.category } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
        ...(input.theme !== undefined ? { theme: input.theme as never } : {}),
        ...(input.blocks !== undefined ? { blocks: input.blocks as never } : {}),
      },
    });
    await this.record(ctx, { action: "design_library.updated", targetType: "platform_email_design", targetId: id, metadata: { key: before.key, fields } });
    return this.get(id);
  }

  private assertPublishable(blocks: unknown) {
    const parsed = readBlocks(blocks);
    if (!parsed.length) throw badRequest("Add some blocks before publishing", { blocks: "Add some blocks before publishing" });
    const problems = designProblems(parsed);
    if (problems.length) throw badRequest(problems[0]!, { blocks: problems.join(" ") });
  }

  async publish(ctx: RequestContext, id: string) {
    const row = await this.find(id);
    this.assertPublishable(row.blocks);
    await this.prisma.db.platformEmailDesign.update({ where: { id }, data: { status: "published", publishedAt: new Date() } });
    await this.record(ctx, { action: "design_library.published", targetType: "platform_email_design", targetId: id, metadata: { key: row.key, name: row.name } });
    return this.get(id);
  }

  async unpublish(ctx: RequestContext, id: string) {
    const row = await this.find(id);
    await this.prisma.db.platformEmailDesign.update({ where: { id }, data: { status: "draft" } });
    await this.record(ctx, { action: "design_library.unpublished", targetType: "platform_email_design", targetId: id, metadata: { key: row.key, name: row.name } });
    return this.get(id);
  }

  /** A tombstone, not a delete: the key stays taken, so a built-in is never inserted again on the next start. */
  async remove(ctx: RequestContext, id: string) {
    const row = await this.find(id);
    await this.prisma.db.platformEmailDesign.update({ where: { id }, data: { deletedAt: new Date(), status: "draft" } });
    await this.record(ctx, { action: "design_library.deleted", targetType: "platform_email_design", targetId: id, metadata: { key: row.key, name: row.name } });
    return { deleted: true };
  }

  /**
   * Staff read a customer's designs only as the support view does: as a
   * member of the workspace (publishing their own design from the web app),
   * or while its owner has an active SupportAccessGrant. Grant reads are
   * recorded in the customer's own audit log.
   */
  private async workspaceAccess(ctx: RequestContext, workspaceId: string, section: string) {
    if (!UUID.test(workspaceId)) throw notFound("That workspace");
    const w = await this.prisma.db.workspace.findUnique({ where: { id: workspaceId }, select: { id: true, name: true, deletedAt: true } });
    if (!w || w.deletedAt) throw notFound("That workspace");
    const userId = actorId(ctx);
    const member = userId ? await this.prisma.db.membership.findUnique({ where: { workspaceId_userId: { workspaceId, userId } }, select: { userId: true } }) : null;
    if (member) return w;
    const grant = await this.prisma.db.supportAccessGrant.findFirst({
      where: { workspaceId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { expiresAt: "desc" },
      select: { id: true },
    });
    if (!grant) throw forbidden(NO_GRANT_MESSAGE);
    await this.record(ctx, { workspaceId, action: "platform.support_viewed", targetType: "support_grant", targetId: grant.id, metadata: { section } });
    return w;
  }

  /** The designs the import dialog offers from one workspace (not archived, newest first). */
  async workspaceDesigns(ctx: RequestContext, workspaceId: string) {
    const w = await this.workspaceAccess(ctx, workspaceId, "email_designs");
    const rows = await this.prisma.db.emailDesign.findMany({
      where: { workspaceId, archivedAt: null },
      orderBy: { updatedAt: "desc" },
      take: 200,
      select: { id: true, name: true, libraryKey: true, updatedAt: true },
    });
    return { workspace: { id: w.id, name: w.name }, designs: rows.map((r) => ({ id: r.id, name: r.name, fromLibrary: Boolean(r.libraryKey), updatedAt: r.updatedAt })) };
  }

  /** A workspace's design, copied into the library as a draft. Workspaces are untouched. */
  async importDesign(ctx: RequestContext, input: z.infer<typeof PlatformEmailDesignImport>) {
    await this.workspaceAccess(ctx, input.workspaceId, "email_design_import");
    const design = await this.prisma.db.emailDesign.findFirst({ where: { id: input.designId, workspaceId: input.workspaceId } });
    if (!design) throw notFound("That design");
    const name = input.name ?? design.name;
    const row = await this.prisma.db.platformEmailDesign.create({
      data: {
        key: await this.freeKey(name),
        name,
        description: input.description ?? "",
        category: input.category ?? "",
        sortOrder: await this.nextSortOrder(),
        theme: readTheme(design.theme) as never,
        blocks: readBlocks(design.blocks) as never,
        createdById: actorId(ctx),
      },
    });
    // Filed under the customer's workspace, like every platform-admin action against a customer.
    await this.record(ctx, {
      workspaceId: input.workspaceId,
      action: "design_library.imported",
      targetType: "platform_email_design",
      targetId: row.id,
      metadata: { key: row.key, name: row.name, workspaceId: input.workspaceId, designId: input.designId },
    });
    return this.get(row.id);
  }

  /** Rendering only: an unsaved theme + blocks with the sample contact. */
  preview(input: z.infer<typeof PlatformEmailDesignPreviewInput>) {
    const { html, text } = renderLibraryPreview(input.blocks, input.theme);
    return { html, text, problems: designProblems(input.blocks) };
  }

  // ─── Workspaces ────────────────────────────────────────────────────────────

  /** The gallery: published entries, in the admins' order. */
  async published() {
    const rows = await this.prisma.db.platformEmailDesign.findMany({ where: { status: "published", deletedAt: null }, orderBy: ORDER });
    return rows.map((r) => ({
      id: r.id,
      key: r.key,
      name: r.name,
      description: r.description,
      category: r.category,
      theme: readTheme(r.theme),
      blocks: readBlocks(r.blocks),
      sortOrder: r.sortOrder,
    }));
  }

  /** Copies a published entry into the workspace's designs, through the normal create path. */
  async use(ctx: RequestContext, templateId: string) {
    if (!UUID.test(templateId)) throw notFound("That template");
    const row = await this.prisma.db.platformEmailDesign.findFirst({ where: { id: templateId, status: "published", deletedAt: null } });
    if (!row) throw notFound("That template");
    return this.designs.create(ctx, { name: row.name, blocks: readBlocks(row.blocks), theme: readTheme(row.theme) }, row.key);
  }
}
