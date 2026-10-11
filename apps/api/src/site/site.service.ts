import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import {
  LEGAL_SLUGS,
  SITE_CONTENT_KEYS,
  SITE_CONTENT_SCHEMAS,
  SITE_DEFAULTS,
  withProductName,
  type LegalSlug,
  type PublicLegalPage,
  type PublicSite,
  type SiteAssetKind,
  type SiteContentKey,
  type SiteContentMap,
} from "@growthdesk/shared";
import type { PlatformSiteContent } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { AuditService, type AuditInput } from "../core/audit.service.js";
import { BrandingService } from "../core/branding.service.js";
import { PlatformSettingsService } from "../core/platform-settings.service.js";
import { sha256 } from "../common/crypto.js";
import { badRequest, notFound } from "../common/errors.js";
import { actorId, type RequestContext } from "../common/context.js";
import { checkAsset } from "./asset-rules.js";

/*
 * The public website's content (PlatformSiteContent) and its images
 * (PlatformAsset). Each key has a draft the super-admin edits and a published
 * copy the site serves; a key never published serves the shared defaults.
 *
 * Platform-level, not tenant data: these tables carry no workspaceId, so
 * `prisma.db` serves them without the tenant guard getting involved.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Asset-id fields per key, and the kind of asset each must point at. */
const ASSET_FIELDS: Partial<Record<SiteContentKey, Record<string, SiteAssetKind>>> = {
  branding: { logoAssetId: "logo", faviconAssetId: "favicon", ogAssetId: "og" },
  seo: { ogAssetId: "og" },
};

export const isSiteKey = (key: string): key is SiteContentKey => (SITE_CONTENT_KEYS as readonly string[]).includes(key);

@Injectable()
export class SiteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly branding: BrandingService,
    private readonly platform: PlatformSettingsService,
  ) {}

  /**
   * Stored JSON as valid content: as stored, else stored over the defaults
   * (a key added to the schema since it was saved), else the defaults.
   */
  private coerce<K extends SiteContentKey>(key: K, stored: unknown): SiteContentMap[K] {
    const schema = SITE_CONTENT_SCHEMAS[key];
    const direct = schema.safeParse(stored);
    if (direct.success) return direct.data as SiteContentMap[K];
    if (stored && typeof stored === "object" && !Array.isArray(stored)) {
      const merged = schema.safeParse({ ...SITE_DEFAULTS[key], ...(stored as object) });
      if (merged.success) return merged.data as SiteContentMap[K];
    }
    return SITE_DEFAULTS[key];
  }

  private published<K extends SiteContentKey>(key: K, row: PlatformSiteContent | undefined | null): SiteContentMap[K] {
    return row?.publishedAt ? this.coerce(key, row.published) : SITE_DEFAULTS[key];
  }

  private draft<K extends SiteContentKey>(key: K, row: PlatformSiteContent | undefined | null): SiteContentMap[K] {
    return row ? this.coerce(key, row.draft) : this.published(key, row);
  }

  private record(ctx: RequestContext, input: AuditInput) {
    return this.audit.record(ctx, { workspaceId: null, ...input }, "platform_admin");
  }

  // ─── Public ────────────────────────────────────────────────────────────────

  async publicSite(): Promise<PublicSite> {
    const [brand, settings, rows] = await Promise.all([
      this.branding.get(),
      this.platform.get(),
      this.prisma.db.platformSiteContent.findMany({ where: { key: { in: ["branding", "landing", "announcement", "seo", "analytics"] } } }),
    ]);
    const row = (key: SiteContentKey) => rows.find((r) => r.key === key);
    const name = brand.productName;
    const brandingContent = this.published("branding", row("branding"));
    const seo = withProductName(this.published("seo", row("seo")), name);
    const a = withProductName(this.published("announcement", row("announcement")), name);
    const { enabled, ...announcement } = a;
    return {
      productName: name,
      supportEmail: brand.supportEmail,
      primaryColor: brand.primaryColor,
      logoUrl: brand.logoUrl,
      faviconUrl: brand.faviconUrl,
      landingEnabled: settings.landingEnabled,
      landing: withProductName(this.published("landing", row("landing")), name),
      announcement:
        enabled && announcement.message
          ? {
              // Changes whenever the text does, so a dismissed banner comes back for a new message.
              id: createHash("sha256").update(JSON.stringify([announcement.message, announcement.href, announcement.tone])).digest("hex").slice(0, 16),
              ...announcement,
            }
          : null,
      seo: { title: seo.title, description: seo.description, ogImageUrl: this.branding.assetUrl(seo.ogAssetId ?? brandingContent.ogAssetId) },
      analytics: this.published("analytics", row("analytics")),
    };
  }

  async legal(slug: string): Promise<PublicLegalPage> {
    if (!(LEGAL_SLUGS as readonly string[]).includes(slug)) throw notFound("That page");
    const key = `legal.${slug}` as "legal.terms" | "legal.privacy";
    const [brand, row] = await Promise.all([this.branding.get(), this.prisma.db.platformSiteContent.findUnique({ where: { key } })]);
    return {
      slug: slug as LegalSlug,
      ...withProductName(this.published(key, row), brand.productName),
      publishedAt: row?.publishedAt?.toISOString() ?? null,
    };
  }

  async asset(id: string) {
    if (!UUID.test(id)) throw notFound("That file");
    const asset = await this.prisma.db.platformAsset.findUnique({ where: { id } });
    if (!asset) throw notFound("That file");
    return asset;
  }

  // ─── Admin ─────────────────────────────────────────────────────────────────

  private async adminRow(key: SiteContentKey, row: PlatformSiteContent | null | undefined, people: Map<string, { id: string; name: string; email: string }>) {
    const draft = this.draft(key, row);
    const published = this.published(key, row);
    return {
      key,
      draft,
      published,
      publishedAt: row?.publishedAt ?? null,
      publishedBy: row?.publishedById ? (people.get(row.publishedById) ?? null) : null,
      updatedAt: row?.updatedAt ?? null,
      /** No row yet: both copies are the built-in defaults. */
      isDefault: !row,
      hasUnpublishedChanges: JSON.stringify(draft) !== JSON.stringify(published),
    };
  }

  private async people(ids: (string | null | undefined)[]) {
    const unique = [...new Set(ids.filter((v): v is string => Boolean(v)))];
    if (!unique.length) return new Map<string, { id: string; name: string; email: string }>();
    const users = await this.prisma.db.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true, email: true } });
    return new Map(users.map((u) => [u.id, u]));
  }

  async adminView() {
    const [rows, settings] = await Promise.all([this.prisma.db.platformSiteContent.findMany(), this.platform.get()]);
    const people = await this.people(rows.map((r) => r.publishedById));
    const content = Object.fromEntries(
      await Promise.all(SITE_CONTENT_KEYS.map(async (key) => [key, await this.adminRow(key, rows.find((r) => r.key === key), people)] as const)),
    );
    return { content, landingEnabled: settings.landingEnabled };
  }

  async adminKey(key: string) {
    const k = this.key(key);
    const row = await this.prisma.db.platformSiteContent.findUnique({ where: { key: k } });
    return this.adminRow(k, row, await this.people([row?.publishedById]));
  }

  private key(key: string): SiteContentKey {
    if (!isSiteKey(key)) throw notFound("That content key");
    return key;
  }

  /** Every asset id in the content must exist and be the right kind of image. */
  private async assertAssets(key: SiteContentKey, content: Record<string, unknown>) {
    const fields = ASSET_FIELDS[key];
    if (!fields) return;
    const wanted = Object.entries(fields).filter(([field]) => typeof content[field] === "string") as [string, SiteAssetKind][];
    if (!wanted.length) return;
    const ids = wanted.map(([field]) => content[field] as string);
    const found = await this.prisma.db.platformAsset.findMany({ where: { id: { in: ids } }, select: { id: true, kind: true } });
    const errors: Record<string, string> = {};
    for (const [field, kind] of wanted) {
      const asset = found.find((a) => a.id === content[field]);
      if (!asset) errors[field] = "That image was not found — upload it again";
      else if (asset.kind !== kind) errors[field] = `That image was uploaded as a ${asset.kind}, not a ${kind}`;
    }
    const first = Object.entries(errors)[0];
    if (first) throw badRequest(`${first[0]}: ${first[1]}`, errors);
  }

  async saveDraft(ctx: RequestContext, rawKey: string, body: unknown) {
    const key = this.key(rawKey);
    const parsed = SITE_CONTENT_SCHEMAS[key].safeParse(body);
    if (!parsed.success) {
      const fields: Record<string, string> = {};
      for (const issue of parsed.error.issues) fields[issue.path.join(".") || "_"] ??= issue.message;
      const first = Object.entries(fields)[0];
      throw badRequest(first ? (first[0] === "_" ? first[1] : `${first[0]}: ${first[1]}`) : "Invalid content", fields);
    }
    const draft = parsed.data as Record<string, unknown>;
    await this.assertAssets(key, draft);
    await this.prisma.db.platformSiteContent.upsert({
      where: { key },
      // A first save leaves the published copy empty (publishedAt null), so the site keeps serving the defaults.
      create: { key, draft: draft as never },
      update: { draft: draft as never },
    });
    await this.record(ctx, { action: "site.draft_saved", targetType: "site_content", targetId: key });
    return this.adminKey(key);
  }

  async publish(ctx: RequestContext, rawKey: string) {
    const key = this.key(rawKey);
    const row = await this.prisma.db.platformSiteContent.findUnique({ where: { key } });
    const content = this.draft(key, row) as Record<string, unknown>;
    await this.assertAssets(key, content);
    await this.prisma.db.platformSiteContent.upsert({
      where: { key },
      create: { key, draft: content as never, published: content as never, publishedAt: new Date(), publishedById: actorId(ctx) },
      update: { draft: content as never, published: content as never, publishedAt: new Date(), publishedById: actorId(ctx) },
    });
    if (key === "branding") this.branding.invalidate();
    await this.record(ctx, { action: "site.published", targetType: "site_content", targetId: key });
    return this.adminKey(key);
  }

  /** Throws the draft away: back to what is published (or to the defaults, if nothing ever was). */
  async discard(ctx: RequestContext, rawKey: string) {
    const key = this.key(rawKey);
    const row = await this.prisma.db.platformSiteContent.findUnique({ where: { key } });
    if (row?.publishedAt) {
      await this.prisma.db.platformSiteContent.update({ where: { key }, data: { draft: this.published(key, row) as never } });
    } else if (row) {
      await this.prisma.db.platformSiteContent.delete({ where: { key } });
    }
    await this.record(ctx, { action: "site.draft_discarded", targetType: "site_content", targetId: key });
    return this.adminKey(key);
  }

  // ─── Assets ────────────────────────────────────────────────────────────────

  private assetView(a: { id: string; kind: string; mime: string; size: number; sha256: string; createdAt: Date; createdById: string | null }) {
    return { id: a.id, kind: a.kind, mime: a.mime, size: a.size, sha256: a.sha256, createdAt: a.createdAt, createdById: a.createdById, url: this.branding.assetUrl(a.id) };
  }

  async listAssets() {
    const assets = await this.prisma.db.platformAsset.findMany({
      orderBy: { createdAt: "desc" },
      take: 200,
      select: { id: true, kind: true, mime: true, size: true, sha256: true, createdAt: true, createdById: true },
    });
    return assets.map((a) => this.assetView(a));
  }

  async uploadAsset(ctx: RequestContext, input: { kind: SiteAssetKind; mime?: string; data: string }) {
    const check = checkAsset(input.kind, input.data, input.mime);
    if (!check.ok) throw badRequest(check.message, { data: check.message });
    const digest = sha256(check.bytes);
    // The same image uploaded again for the same slot reuses the stored copy.
    const existing = await this.prisma.db.platformAsset.findFirst({
      where: { sha256: digest, kind: input.kind },
      select: { id: true, kind: true, mime: true, size: true, sha256: true, createdAt: true, createdById: true },
    });
    if (existing) return this.assetView(existing);
    const created = await this.prisma.db.platformAsset.create({
      data: { kind: input.kind, mime: check.mime, bytes: new Uint8Array(check.bytes), size: check.bytes.length, sha256: digest, createdById: actorId(ctx) },
      select: { id: true, kind: true, mime: true, size: true, sha256: true, createdAt: true, createdById: true },
    });
    await this.record(ctx, { action: "site.asset_uploaded", targetType: "platform_asset", targetId: created.id, metadata: { kind: created.kind, mime: created.mime, size: created.size } });
    return this.assetView(created);
  }
}
