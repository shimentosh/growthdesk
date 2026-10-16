import { Controller, Get, HttpCode, Param, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { z } from "zod";
import { CustomersSyncInput, OrdersSyncInput } from "@growthdesk/shared";
import { ApiKeyScope, Body, Ctx, Permission } from "../common/decorators.js";
import type { RequestContext } from "../common/context.js";
import { CommerceService } from "./commerce.service.js";

/** Clients and orders from a client portal (Clientdesk) — API key with customers:write. */
@ApiTags("commerce")
@Controller("workspaces/:workspaceId")
export class CommerceController {
  constructor(private readonly commerce: CommerceService) {}

  /** The connection check for a sync key, and what has come in so far. */
  @ApiKeyScope("customers:write")
  @Permission("contacts.read")
  @Get("commerce/status")
  status(@Ctx() ctx: RequestContext) {
    return this.commerce.status(ctx);
  }

  /** Up to 100 clients, each upserted by (source, externalId); one bad record fails alone. */
  @ApiKeyScope("customers:write")
  @Permission("contacts.import")
  @HttpCode(200)
  @Post("commerce/customers")
  customers(@Ctx() ctx: RequestContext, @Body(CustomersSyncInput) body: z.infer<typeof CustomersSyncInput>) {
    return this.commerce.syncCustomers(ctx, body);
  }

  /** Up to 100 orders, each upserted by (source, externalId); the contacts' totals are counted again. */
  @ApiKeyScope("customers:write")
  @Permission("contacts.import")
  @HttpCode(200)
  @Post("commerce/orders")
  orders(@Ctx() ctx: RequestContext, @Body(OrdersSyncInput) body: z.infer<typeof OrdersSyncInput>) {
    return this.commerce.syncOrders(ctx, body);
  }

  /** A contact's orders, newest first. */
  @Permission("contacts.read")
  @Get("contacts/:id/orders")
  contactOrders(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.commerce.contactOrders(ctx, id);
  }
}
