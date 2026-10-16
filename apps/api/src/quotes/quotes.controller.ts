import { Controller, Delete, Get, HttpCode, Param, Patch, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { z } from "zod";
import { ProductInput, ProductListQuery, ProductUpdate, QuoteCreateInput, QuoteListQuery, QuoteSendInput, QuoteUpdateInput } from "@growthdesk/shared";
import { Body, Ctx, Permission, Query } from "../common/decorators.js";
import type { RequestContext } from "../common/context.js";
import { AuditService } from "../core/audit.service.js";
import { ProductsService } from "./products.service.js";
import { QuotesService } from "./quotes.service.js";

/*
 * The product catalogue and quotes, inside a workspace:
 *
 *   GET    /products                quotes.read (the editor's picker); costPrice only with products.manage
 *   POST   /products, PATCH/DELETE /products/:id     products.manage
 *   GET    /quotes, /quotes/:id, /deals/:dealId/quotes     quotes.read
 *   POST   /quotes, PATCH /quotes/:id, DELETE /quotes/:id (drafts)   quotes.write
 *   POST   /quotes/:id/duplicate | void | send | link     quotes.write
 *   GET    /quotes/:id/send-options                        quotes.write
 *
 * The buyer's side (view, accept, decline) is quotes-public.controller.ts.
 */
@ApiTags("quotes")
@Controller("workspaces/:workspaceId")
export class QuotesController {
  constructor(
    private readonly products: ProductsService,
    private readonly quotes: QuotesService,
    private readonly audit: AuditService,
  ) {}

  // ─── Products ──────────────────────────────────────────────────────────────

  @Permission("quotes.read", "products.manage")
  @Get("products")
  listProducts(@Ctx() ctx: RequestContext, @Query(ProductListQuery) q: z.infer<typeof ProductListQuery>) {
    return this.products.list(ctx, q);
  }

  @Permission("quotes.read", "products.manage")
  @Get("products/:id")
  getProduct(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.products.get(ctx, id);
  }

  @Permission("products.manage")
  @Post("products")
  createProduct(@Ctx() ctx: RequestContext, @Body(ProductInput) body: z.infer<typeof ProductInput>) {
    return this.products.create(ctx, body);
  }

  @Permission("products.manage")
  @Patch("products/:id")
  updateProduct(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(ProductUpdate) body: z.infer<typeof ProductUpdate>) {
    return this.products.update(ctx, id, body);
  }

  @Permission("products.manage")
  @Delete("products/:id")
  async removeProduct(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    await this.products.remove(ctx, id);
    return { deleted: true };
  }

  // ─── Quotes ────────────────────────────────────────────────────────────────

  @Permission("quotes.read")
  @Get("quotes")
  list(@Ctx() ctx: RequestContext, @Query(QuoteListQuery) q: z.infer<typeof QuoteListQuery>) {
    return this.quotes.list(ctx, q);
  }

  @Permission("quotes.read")
  @Get("deals/:dealId/quotes")
  forDeal(@Ctx() ctx: RequestContext, @Param("dealId") dealId: string) {
    return this.quotes.forDeal(ctx, dealId);
  }

  @Permission("quotes.read")
  @Get("quotes/:id")
  get(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.quotes.get(ctx, id);
  }

  @Permission("quotes.write")
  @Post("quotes")
  create(@Ctx() ctx: RequestContext, @Body(QuoteCreateInput) body: z.infer<typeof QuoteCreateInput>) {
    return this.quotes.create(ctx, body);
  }

  @Permission("quotes.write")
  @Patch("quotes/:id")
  update(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(QuoteUpdateInput) body: z.infer<typeof QuoteUpdateInput>) {
    return this.quotes.update(ctx, id, body);
  }

  @Permission("quotes.write")
  @Delete("quotes/:id")
  async remove(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    await this.quotes.remove(ctx, id);
    return { deleted: true };
  }

  @Permission("quotes.write")
  @Post("quotes/:id/duplicate")
  duplicate(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.quotes.duplicate(ctx, id);
  }

  @Permission("quotes.write")
  @HttpCode(200)
  @Post("quotes/:id/void")
  async void(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    const q = await this.quotes.void(ctx, id);
    await this.audit.record(ctx, { action: "quote.voided", targetType: "quote", targetId: id, metadata: { number: q.numberLabel } });
    return q;
  }

  @Permission("quotes.write")
  @Get("quotes/:id/send-options")
  sendOptions(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.quotes.sendOptions(ctx, id);
  }

  @Permission("quotes.write")
  @HttpCode(200)
  @Post("quotes/:id/send")
  send(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(QuoteSendInput) body: z.infer<typeof QuoteSendInput>) {
    return this.quotes.send(ctx, id, body);
  }

  /** "Copy link": the public URL, and a draft becomes sent. */
  @Permission("quotes.write")
  @HttpCode(200)
  @Post("quotes/:id/link")
  link(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.quotes.shareLink(ctx, id);
  }
}
