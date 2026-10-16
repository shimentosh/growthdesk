import { Controller, Get, Put } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { z } from "zod";
import { Body, Ctx, Permission, Query } from "../common/decorators.js";
import type { RequestContext } from "../common/context.js";
import { DigestPreviewQuery, DigestSettingsInput, type DigestSettingsInputT } from "./digest.policy.js";
import { DigestService } from "./digest.service.js";

/** The daily / weekly digest for owners, admins and managers: settings and a preview (nothing is sent). */
@ApiTags("digest")
@Controller("workspaces/:workspaceId/digest")
export class DigestController {
  constructor(private readonly digest: DigestService) {}

  /** The digest as it would go out now: its numbers, plus the rendered title and body. */
  @Permission("analytics.team")
  @Get("preview")
  preview(@Ctx() ctx: RequestContext, @Query(DigestPreviewQuery) q: z.infer<typeof DigestPreviewQuery>) {
    return this.digest.preview(ctx, q.frequency);
  }

  @Permission("analytics.team")
  @Get("settings")
  settings(@Ctx() ctx: RequestContext) {
    return this.digest.settings(ctx);
  }

  /** On / off, daily or weekly (Mondays), and the local hour it goes out. */
  @Permission("settings.manage")
  @Put("settings")
  save(@Ctx() ctx: RequestContext, @Body(DigestSettingsInput) body: DigestSettingsInputT) {
    return this.digest.saveSettings(ctx, body);
  }
}
