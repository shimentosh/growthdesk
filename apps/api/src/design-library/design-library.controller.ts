import { Controller, Delete, Get, HttpCode, Module, Param, Patch, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { z } from "zod";
import { PlatformEmailDesignImport, PlatformEmailDesignInput, PlatformEmailDesignPreviewInput, PlatformEmailDesignUpdate } from "@growthdesk/shared";
import { Body, Ctx, Permission, Platform } from "../common/decorators.js";
import type { RequestContext } from "../common/context.js";
import { MarketingModule } from "../marketing/marketing.module.js";
import { DesignLibraryService } from "./design-library.service.js";

/*
 * /v1/admin/email-designs/… — the email design template library in the
 * operator console. Support reads and previews; admin changes. Every change
 * is audited.
 */
@ApiTags("admin")
@Controller("admin/email-designs")
export class DesignLibraryAdminController {
  constructor(private readonly library: DesignLibraryService) {}

  @Platform("support")
  @Get()
  list() {
    return this.library.list();
  }

  @Platform("admin")
  @Post()
  create(@Ctx() ctx: RequestContext, @Body(PlatformEmailDesignInput) body: z.infer<typeof PlatformEmailDesignInput>) {
    return this.library.create(ctx, body);
  }

  /** Rendering only — no state changes, so support may preview too. */
  @Platform("support")
  @HttpCode(200)
  @Post("preview")
  preview(@Body(PlatformEmailDesignPreviewInput) body: z.infer<typeof PlatformEmailDesignPreviewInput>) {
    return this.library.preview(body);
  }

  /** A workspace's designs, for the import dialog. Admin: only admins import, and these are a customer's content. */
  @Platform("admin")
  @Get("sources/:workspaceId")
  sources(@Ctx() ctx: RequestContext, @Param("workspaceId") workspaceId: string) {
    return this.library.workspaceDesigns(ctx, workspaceId);
  }

  /** Copies a workspace's design in as a draft (also reached from the web app's designs, for staff). */
  @Platform("admin")
  @Post("import")
  importDesign(@Ctx() ctx: RequestContext, @Body(PlatformEmailDesignImport) body: z.infer<typeof PlatformEmailDesignImport>) {
    return this.library.importDesign(ctx, body);
  }

  @Platform("support")
  @Get(":id")
  one(@Param("id") id: string) {
    return this.library.get(id);
  }

  @Platform("admin")
  @Patch(":id")
  update(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(PlatformEmailDesignUpdate) body: z.infer<typeof PlatformEmailDesignUpdate>) {
    return this.library.update(ctx, id, body);
  }

  @Platform("admin")
  @HttpCode(200)
  @Post(":id/publish")
  publish(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.library.publish(ctx, id);
  }

  @Platform("admin")
  @HttpCode(200)
  @Post(":id/unpublish")
  unpublish(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.library.unpublish(ctx, id);
  }

  @Platform("admin")
  @Delete(":id")
  remove(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.library.remove(ctx, id);
  }
}

/** The gallery a workspace starts designs from. */
@ApiTags("marketing")
@Controller("workspaces/:workspaceId/marketing/design-library")
export class DesignLibraryController {
  constructor(private readonly library: DesignLibraryService) {}

  @Permission("marketing.read")
  @Get()
  list() {
    return this.library.published();
  }

  @Permission("marketing.write")
  @Post(":templateId/use")
  use(@Ctx() ctx: RequestContext, @Param("templateId") templateId: string) {
    return this.library.use(ctx, templateId);
  }
}

/** The email design template library: /v1/admin/email-designs and /v1/workspaces/:id/marketing/design-library. */
@Module({
  imports: [MarketingModule],
  controllers: [DesignLibraryAdminController, DesignLibraryController],
  providers: [DesignLibraryService],
})
export class DesignLibraryModule {}
