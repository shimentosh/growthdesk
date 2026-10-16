import { Controller, Delete, Get, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { z } from "zod";
import { McpTokenInput } from "@growthdesk/shared";
import { Body, Ctx } from "../common/decorators.js";
import type { RequestContext } from "../common/context.js";
import { McpTokensService } from "./mcp-tokens.service.js";

/**
 * Settings → MCP / Claude. Session only (no @ApiKeyScope): neither an API key
 * nor an MCP token can mint or revoke MCP tokens. Any member may use these
 * routes for their own tokens; McpTokensService widens the view to everyone's
 * for holders of apikeys.manage.
 */
@ApiTags("mcp")
@Controller("workspaces/:workspaceId/mcp")
export class McpTokensController {
  constructor(private readonly tokens: McpTokensService) {}

  @Get("tokens")
  list(@Ctx() ctx: RequestContext) {
    return this.tokens.list(ctx);
  }

  @Post("tokens")
  create(@Ctx() ctx: RequestContext, @Body(McpTokenInput) body: z.infer<typeof McpTokenInput>) {
    return this.tokens.create(ctx, body);
  }

  @Delete("tokens/:id")
  revoke(@Ctx() ctx: RequestContext, @Param("id", ParseUUIDPipe) id: string) {
    return this.tokens.revoke(ctx, id);
  }

  @Get("activity")
  activity(@Ctx() ctx: RequestContext) {
    return this.tokens.activity(ctx);
  }

  @Get("pending")
  pending(@Ctx() ctx: RequestContext) {
    return this.tokens.pending(ctx);
  }

  @Delete("pending/:id")
  cancelPending(@Ctx() ctx: RequestContext, @Param("id", ParseUUIDPipe) id: string) {
    return this.tokens.cancelPending(ctx, id);
  }
}
