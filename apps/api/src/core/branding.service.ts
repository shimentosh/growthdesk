import { Inject, Injectable } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { PrismaService } from "../prisma/prisma.service.js";

/*
 * The product's public identity, edited in the super-admin (Website → Branding)
 * and stored as the published `branding` PlatformSiteContent row. Everything a
 * person reads — email footers, the From display name, page titles, the
 * maintenance notice — takes the name from here. Technical identifiers
 * (webhook header names, the DNS TXT prefix, crypto salts, gd_ cookies) are
 * deliberately NOT branded: changing them would break integrations.
 */

export type Branding = {
  productName: string;
  /** Shown in email footers and on the public site; "" = none. */
  supportEmail: string;
  /** #rrggbb accent; "" = the design-system default. */
  primaryColor: string;
  /** PlatformAsset ids; null = the built-in mark. */
  logoAssetId: string | null;
  faviconAssetId: string | null;
  /** Public URL of an uploaded asset, or null. */
  logoUrl: string | null;
  faviconUrl: string | null;
};

export const DEFAULT_PRODUCT_NAME = "Growthdesk";
const TTL_MS = 30_000;
const HEX = /^#[0-9a-fA-F]{6}$/;

@Injectable()
export class BrandingService {
  private cache: { at: number; value: Branding } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async get(): Promise<Branding> {
    if (this.cache && Date.now() - this.cache.at < TTL_MS) return this.cache.value;
    const row = await this.prisma.db.platformSiteContent.findUnique({ where: { key: "branding" } });
    const p = (row?.published ?? {}) as Partial<Record<keyof Branding, unknown>>;
    const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
    const id = (v: unknown) => (typeof v === "string" && v ? v : null);
    const asset = (assetId: string | null) => this.assetUrl(assetId);
    const color = str(p.primaryColor, 7);
    const logoAssetId = id(p.logoAssetId);
    const faviconAssetId = id(p.faviconAssetId);
    const value: Branding = {
      productName: str(p.productName, 60) || DEFAULT_PRODUCT_NAME,
      supportEmail: str(p.supportEmail, 254),
      primaryColor: HEX.test(color) ? color : "",
      logoAssetId,
      faviconAssetId,
      logoUrl: asset(logoAssetId),
      faviconUrl: asset(faviconAssetId),
    };
    this.cache = { at: Date.now(), value };
    return value;
  }

  /** Where an uploaded PlatformAsset is served (through the web app's /api → /v1 proxy). */
  assetUrl(assetId: string | null | undefined): string | null {
    return assetId ? `${this.config.PUBLIC_APP_URL.replace(/\/+$/, "")}/api/site/assets/${assetId}` : null;
  }

  /** Call after publishing branding so this process stops serving the old values. */
  invalidate() {
    this.cache = null;
  }
}
