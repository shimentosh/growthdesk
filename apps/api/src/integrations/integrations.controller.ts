import { Controller, Delete, Get, Headers, HttpCode, Param, Post, Res } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import type { z } from "zod";
import { ApiKeyInput, IdempotencyKeyHeader, LeadIngestInput } from "@growthdesk/shared";
import { ApiKeyScope, Body, Ctx, Permission } from "../common/decorators.js";
import { badRequest } from "../common/errors.js";
import { ws, type RequestContext } from "../common/context.js";
import { ApiKeysService } from "./api-keys.service.js";
import { IdempotencyService, fingerprint } from "./idempotency.service.js";
import { LeadIngestService } from "./lead-ingest.service.js";

@ApiTags("integrations")
@Controller("workspaces/:workspaceId")
export class IntegrationsController {
  constructor(
    private readonly keys: ApiKeysService,
    private readonly ingest: LeadIngestService,
    private readonly idempotency: IdempotencyService,
  ) {}

  // ─── API keys (session only: a key cannot mint or revoke keys) ─────────────

  @Permission("apikeys.manage")
  @Get("api-keys")
  listKeys(@Ctx() ctx: RequestContext) {
    return this.keys.list(ctx);
  }

  @Permission("apikeys.manage")
  @Post("api-keys")
  createKey(@Ctx() ctx: RequestContext, @Body(ApiKeyInput) body: z.infer<typeof ApiKeyInput>) {
    return this.keys.create(ctx, body);
  }

  @Permission("apikeys.manage")
  @Delete("api-keys/:id")
  revokeKey(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.keys.revoke(ctx, id);
  }

  // ─── Lead ingest (Business OS) ────────────────────────────────────────────

  /**
   * Upserts up to 100 leads. With an `Idempotency-Key` header, a retry of the
   * same request returns the first response (header `Idempotent-Replayed: true`)
   * instead of running again.
   */
  @ApiKeyScope("leads:write")
  @Permission("contacts.import")
  @HttpCode(200)
  @Post("leads")
  async ingestLeads(
    @Ctx() ctx: RequestContext,
    @Body(LeadIngestInput) body: z.infer<typeof LeadIngestInput>,
    @Headers("idempotency-key") rawKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const parsed = rawKey === undefined ? null : IdempotencyKeyHeader.safeParse(rawKey);
    if (parsed && !parsed.success) throw badRequest("The Idempotency-Key header must be 1–200 visible ASCII characters.");
    const key = parsed?.data;
    const result = await this.idempotency.run(ws(ctx).id, key, fingerprint("POST /leads", body), async () => ({
      statusCode: 200,
      body: await this.ingest.ingest(ctx, body),
    }));
    if (result.replayed) res.setHeader("Idempotent-Replayed", "true");
    res.status(result.statusCode);
    return result.body;
  }
}
