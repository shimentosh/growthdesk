import { Inject, Injectable } from "@nestjs/common";
import { MARKETING_ASSET_WORKSPACE_MAX_BYTES } from "@growthdesk/shared";
import { PrismaService } from "../prisma/prisma.service.js";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { AuditService } from "../core/audit.service.js";
import { sha256 } from "../common/crypto.js";
import { badRequest, conflict, notFound } from "../common/errors.js";
import { actorId, ws, type RequestContext } from "../common/context.js";
import { checkEmailImage, extensionFor } from "../site/asset-rules.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MB = 1024 * 1024;

/** "<uuid>" or "<uuid>.png" → the uuid, or null. */
export function assetIdFrom(file: string): string | null {
  const id = file.replace(/\.[a-z0-9]{2,5}$/i, "");
  return UUID.test(id) ? id.toLowerCase() : null;
}

type AssetRow = { id: string; contentType: string; size: number; fileName: string; createdAt: Date };

/*
 * Images uploaded for marketing emails (the designer's image, hero, header
 * and column blocks), kept in Postgres like the site's PlatformAsset. Each is
 * checked by its bytes (PNG, JPEG, GIF or WebP; never SVG), capped at 1 MB,
 * and a workspace holds at most 100 MB in all. They are served without
 * sign-in at ${PUBLIC_APP_URL}/api/m/assets/<id>.<ext> (MarketingPublicController),
 * because mail clients fetch images anonymously; the id is a random uuid
 * and the bytes behind it never change.
 */
@Injectable()
export class MarketingAssetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** The absolute address an email embeds. */
  url(a: { id: string; contentType: string }) {
    return `${this.config.PUBLIC_APP_URL.replace(/\/+$/, "")}/api/m/assets/${a.id}.${extensionFor(a.contentType)}`;
  }

  private view(a: AssetRow) {
    return { id: a.id, contentType: a.contentType, size: a.size, fileName: a.fileName, createdAt: a.createdAt, url: this.url(a) };
  }

  private used(workspaceId: string) {
    return this.prisma.db.workspaceAsset.aggregate({ where: { workspaceId }, _sum: { size: true } }).then((r) => r._sum.size ?? 0);
  }

  async list(ctx: RequestContext) {
    const w = ws(ctx);
    const select = { id: true, contentType: true, size: true, fileName: true, createdAt: true };
    const [rows, used] = await Promise.all([this.prisma.db.workspaceAsset.findMany({ where: { workspaceId: w.id }, orderBy: { createdAt: "desc" }, take: 500, select }), this.used(w.id)]);
    return { items: rows.map((a) => this.view(a)), usedBytes: used, maxBytes: MARKETING_ASSET_WORKSPACE_MAX_BYTES };
  }

  async upload(ctx: RequestContext, input: { data: string; mime?: string; fileName?: string }) {
    const w = ws(ctx);
    const check = checkEmailImage(input.data, input.mime);
    if (!check.ok) throw badRequest(check.message, { data: check.message });
    const digest = sha256(check.bytes);
    const select = { id: true, contentType: true, size: true, fileName: true, createdAt: true };
    const created = await this.prisma.db.$transaction(async (tx) => {
      // One upload at a time per workspace, so parallel uploads cannot pass the total cap together.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`workspace-assets:${w.id}`}))`;
      // The same image uploaded again reuses the stored copy (and its URL).
      const existing = await tx.workspaceAsset.findFirst({ where: { workspaceId: w.id, sha256: digest }, select });
      if (existing) return { row: existing, fresh: false };
      const used = (await tx.workspaceAsset.aggregate({ where: { workspaceId: w.id }, _sum: { size: true } }))._sum.size ?? 0;
      if (used + check.bytes.length > MARKETING_ASSET_WORKSPACE_MAX_BYTES) {
        throw conflict(
          `This workspace's uploaded images already use ${(used / MB).toFixed(1)} MB of ${MARKETING_ASSET_WORKSPACE_MAX_BYTES / MB} MB. Use an image hosted elsewhere (paste its https:// address) or remove unused uploads.`,
          { data: "Image storage is full" },
        );
      }
      const row = await tx.workspaceAsset.create({
        data: { workspaceId: w.id, contentType: check.mime, bytes: new Uint8Array(check.bytes), size: check.bytes.length, sha256: digest, fileName: (input.fileName ?? "").slice(0, 200), createdById: actorId(ctx) },
        select,
      });
      return { row, fresh: true };
    });
    if (created.fresh) {
      await this.audit.record(ctx, { action: "marketing.asset_uploaded", targetType: "workspace_asset", targetId: created.row.id, metadata: { contentType: created.row.contentType, size: created.row.size } });
    }
    return this.view(created.row);
  }

  /** Deleting breaks the image in emails already sent with it; the UI should say so. */
  async remove(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    if (!UUID.test(id)) throw notFound("That image");
    const res = await this.prisma.db.workspaceAsset.deleteMany({ where: { id, workspaceId: w.id } });
    if (!res.count) throw notFound("That image");
    await this.audit.record(ctx, { action: "marketing.asset_deleted", targetType: "workspace_asset", targetId: id });
    return { deleted: true };
  }

  /** The bytes for the public route. Unscoped by design: the unguessable id is the only key, as with a link in an email. */
  async serve(file: string) {
    const id = assetIdFrom(file);
    if (!id) throw notFound("That image");
    const a = await this.prisma.unscoped.workspaceAsset.findUnique({ where: { id }, select: { id: true, contentType: true, bytes: true, size: true, sha256: true } });
    if (!a) throw notFound("That image");
    return a;
  }
}
