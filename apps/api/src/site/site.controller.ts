import { Controller, Get, HttpCode, Module, Param, Post, Put, Req as R, Res } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import type { z } from "zod";
import { SiteAssetUploadInput } from "@growthdesk/shared";
import { Body, Ctx, Platform, Public, Raw } from "../common/decorators.js";
import type { Req, RequestContext } from "../common/context.js";
import { extensionFor } from "./asset-rules.js";
import { SiteService } from "./site.service.js";

/*
 * The public website's content.
 *
 *   GET /site               everything the marketing pages and root layout need
 *   GET /site/legal/:slug   terms | privacy
 *   GET /site/assets/:id    an uploaded logo / favicon / social image
 *
 * Reached by the browser as ${PUBLIC_APP_URL}/api/site/... through the web
 * app's /api → /v1 proxy, and by the web app's server directly.
 */

/**
 * A short shared cache: content changes are published rarely and may take a
 * minute to show. If the session guard renewed the visitor's cookie on this
 * response, it must not be stored by a shared cache.
 */
function cacheShort(req: Req, res: Response) {
  const personal = Boolean(res.getHeader("set-cookie")) || Boolean(req.cookies?.gd_session);
  res.setHeader("cache-control", `${personal ? "private" : "public"}, max-age=60, stale-while-revalidate=600`);
}

@ApiTags("site")
@Public()
@Controller("site")
export class SiteController {
  constructor(private readonly site: SiteService) {}

  @Get()
  async index(@R() req: Req, @Res({ passthrough: true }) res: Response) {
    const data = await this.site.publicSite();
    cacheShort(req, res);
    return data;
  }

  @Get("legal/:slug")
  async legal(@Param("slug") slug: string, @R() req: Req, @Res({ passthrough: true }) res: Response) {
    const data = await this.site.legal(slug);
    cacheShort(req, res);
    return data;
  }

  /** Never SVG (refused at upload); served with the sniffed type, nosniff, and a CSP that runs nothing. */
  @Raw()
  @Get("assets/:id")
  async asset(@Param("id") id: string, @R() req: Req, @Res() res: Response) {
    const asset = await this.site.asset(id);
    const etag = `"${asset.sha256}"`;
    res.set({
      "content-type": asset.mime,
      "content-length": String(asset.size),
      // The id never points at different bytes: uploads create new rows.
      "cache-control": "public, max-age=31536000, immutable",
      etag,
      "x-content-type-options": "nosniff",
      "content-disposition": `inline; filename="${asset.kind}.${extensionFor(asset.mime)}"`,
      "content-security-policy": "default-src 'none'; sandbox",
      "cross-origin-resource-policy": "cross-origin",
    });
    if (req.headers["if-none-match"] === etag) {
      res.status(304).end();
      return;
    }
    res.status(200).end(Buffer.from(asset.bytes));
  }
}

/*
 * /v1/admin/site/… — the super-admin's Website pages. Support reads, admin
 * writes; every write is audited.
 */
@ApiTags("admin")
@Controller("admin/site")
export class SiteAdminController {
  constructor(private readonly site: SiteService) {}

  @Platform("support")
  @Get()
  view() {
    return this.site.adminView();
  }

  @Platform("support")
  @Get("assets")
  assets() {
    return this.site.listAssets();
  }

  @Platform("admin")
  @Post("assets")
  upload(@Ctx() ctx: RequestContext, @Body(SiteAssetUploadInput) body: z.infer<typeof SiteAssetUploadInput>) {
    return this.site.uploadAsset(ctx, body);
  }

  @Platform("support")
  @Get(":key")
  one(@Param("key") key: string) {
    return this.site.adminKey(key);
  }

  /** The body is the whole content for the key, validated by its shared schema (SITE_CONTENT_SCHEMAS). */
  @Platform("admin")
  @Put(":key")
  save(@Ctx() ctx: RequestContext, @Param("key") key: string, @R() req: Req) {
    return this.site.saveDraft(ctx, key, req.body);
  }

  @Platform("admin")
  @HttpCode(200)
  @Post(":key/publish")
  publish(@Ctx() ctx: RequestContext, @Param("key") key: string) {
    return this.site.publish(ctx, key);
  }

  @Platform("admin")
  @HttpCode(200)
  @Post(":key/discard")
  discard(@Ctx() ctx: RequestContext, @Param("key") key: string) {
    return this.site.discard(ctx, key);
  }
}

/** Public website content and its super-admin editor (/v1/site, /v1/admin/site). */
@Module({
  controllers: [SiteController, SiteAdminController],
  providers: [SiteService],
})
export class SiteModule {}
