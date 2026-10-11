import { Controller, Delete, Get, HttpCode, Param, Patch, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { z } from "zod";
import { TemplateInput } from "@growthdesk/shared";
import { Body, Ctx, Permission, Query } from "../common/decorators.js";
import type { RequestContext } from "../common/context.js";
import { TemplateListQuery, TemplatePatch, TemplatePreviewInput, TemplatesService } from "./templates.service.js";

@ApiTags("templates")
@Controller("workspaces/:workspaceId/templates")
export class TemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  @Permission("templates.read")
  @Get()
  list(@Ctx() ctx: RequestContext, @Query(TemplateListQuery) q: z.infer<typeof TemplateListQuery>) {
    return this.templates.list(ctx, q);
  }

  // Declared before ":id" so "variables" is not read as a template id.
  @Permission("templates.read")
  @Get("variables")
  variables(@Ctx() ctx: RequestContext) {
    return this.templates.variables(ctx);
  }

  @Permission("templates.write")
  @Post()
  create(@Ctx() ctx: RequestContext, @Body(TemplateInput) body: z.infer<typeof TemplateInput>) {
    return this.templates.create(ctx, body);
  }

  @Permission("templates.read")
  @Get(":id")
  get(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.templates.get(ctx, id);
  }

  @Permission("templates.write")
  @Patch(":id")
  update(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(TemplatePatch) body: z.infer<typeof TemplatePatch>) {
    return this.templates.update(ctx, id, body);
  }

  @Permission("templates.write")
  @Delete(":id")
  remove(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.templates.remove(ctx, id);
  }

  @Permission("templates.read")
  @Get(":id/versions")
  versions(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.templates.versions(ctx, id);
  }

  @Permission("templates.read")
  @HttpCode(200)
  @Post(":id/preview")
  preview(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(TemplatePreviewInput) body: z.infer<typeof TemplatePreviewInput>) {
    return this.templates.preview(ctx, id, body);
  }
}
