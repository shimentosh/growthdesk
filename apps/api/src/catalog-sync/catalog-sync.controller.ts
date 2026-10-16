import { Controller, Get, HttpCode, Put } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { z } from "zod";
import { CatalogSyncInput } from "@growthdesk/shared";
import { ApiKeyScope, Body, Ctx, Permission } from "../common/decorators.js";
import type { RequestContext } from "../common/context.js";
import { CatalogSyncService } from "./catalog-sync.service.js";

@ApiTags("catalog")
@Controller("workspaces/:workspaceId/catalog")
export class CatalogSyncController {
  constructor(private readonly catalog: CatalogSyncService) {}

  /** Which systems sync products here, how many, and when they last did (also a connection check for a sync key). */
  @ApiKeyScope("products:write")
  @Permission("quotes.read")
  @Get("sync")
  status(@Ctx() ctx: RequestContext) {
    return this.catalog.status(ctx);
  }

  /** Brings the source's products in line with its catalog: creates, updates, archives and restores. Idempotent. */
  @ApiKeyScope("products:write")
  @Permission("products.manage")
  @HttpCode(200)
  @Put("sync")
  sync(@Ctx() ctx: RequestContext, @Body(CatalogSyncInput) body: z.infer<typeof CatalogSyncInput>) {
    return this.catalog.sync(ctx, body);
  }
}
