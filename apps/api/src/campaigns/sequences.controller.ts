import { Controller, Delete, Get, Param, Patch, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { z } from "zod";
import { SequenceInput } from "@growthdesk/shared";
import { Body, Ctx, Permission, Query } from "../common/decorators.js";
import type { RequestContext } from "../common/context.js";
import { SequenceListQuery, SequencePatch, SequencesService } from "./sequences.service.js";

@ApiTags("sequences")
@Controller("workspaces/:workspaceId/sequences")
export class SequencesController {
  constructor(private readonly sequences: SequencesService) {}

  @Permission("campaigns.read")
  @Get()
  list(@Ctx() ctx: RequestContext, @Query(SequenceListQuery) q: z.infer<typeof SequenceListQuery>) {
    return this.sequences.list(ctx, q);
  }

  @Permission("campaigns.write")
  @Post()
  create(@Ctx() ctx: RequestContext, @Body(SequenceInput) body: z.infer<typeof SequenceInput>) {
    return this.sequences.create(ctx, body);
  }

  @Permission("campaigns.read")
  @Get(":id")
  get(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.sequences.get(ctx, id);
  }

  @Permission("campaigns.write")
  @Patch(":id")
  update(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(SequencePatch) body: z.infer<typeof SequencePatch>) {
    return this.sequences.update(ctx, id, body);
  }

  @Permission("campaigns.write")
  @Delete(":id")
  remove(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.sequences.remove(ctx, id);
  }

  @Permission("campaigns.write")
  @Post(":id/duplicate")
  duplicate(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.sequences.duplicate(ctx, id);
  }
}
