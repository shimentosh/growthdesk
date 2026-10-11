import { createHash } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { PlatformSettingsService } from "../core/platform-settings.service.js";
import { EntitlementsService } from "../billing/entitlements.service.js";
import { ApiError, unavailable } from "../common/errors.js";
import { AiProviderError, DEFAULT_MODELS, DEFAULT_TIMEOUT_MS, complete, type AiProviderConfig, type AiProviderName, type AiRequest } from "./ai.provider.js";

/*
 * Every AI call goes through AiEngine.run, which owns the rules around it:
 *
 *   1. A provider must be configured (platform settings, else AI_PROVIDER and
 *      its key) — otherwise 503 with a message that says so.
 *   2. The billing account's plan must include `ai` — otherwise 402.
 *   3. An identical prompt (same feature, provider, model and text) within the
 *      cache window is answered from AiCache: no provider call, no credit.
 *   4. One `monthlyAiCredits` credit is consumed before the call (atomic, so
 *      concurrent calls cannot overshoot the allowance) and given back if the
 *      call or its parsing fails — a person is charged only for an answer.
 *   5. Every answer, cached or not, is recorded in AiUsage.
 *
 * The provider's text is parsed by the caller's `parse`; only parsed output is
 * cached, so a malformed answer is never replayed.
 */

export const AI_CREDITS_PER_CALL = 1;

export type AiFeature = "reply_draft" | "message_draft" | "write" | "classify" | "contact_summary" | "deal_summary";

export type AiRunInput<T> = {
  workspaceId: string;
  billingAccountId: string;
  userId: string | null;
  feature: AiFeature;
  /** `light` uses the cheaper default model (classification) unless the platform named one. */
  tier?: "standard" | "light";
  request: AiRequest;
  parse: (text: string) => T;
  cacheTtlMs: number;
  /** Skip the cache lookup (the answer is still cached for next time). */
  fresh?: boolean;
};

export type AiRunResult<T> = { output: T; cached: boolean; provider: AiProviderName; model: string };

/** A provider failure surfaced to an API caller; `retryable` tells the worker whether to try again. */
export class AiCallError extends ApiError {
  constructor(
    status: number,
    code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(status, code, message);
  }
}

export const NOT_CONFIGURED =
  "The AI assistant is not available: no AI provider is configured on this installation. An administrator needs to choose a provider and API key (AI_PROVIDER with ANTHROPIC_API_KEY or OPENAI_API_KEY, or the platform admin settings).";

@Injectable()
export class AiEngine {
  private readonly log = new Logger("ai");

  constructor(
    private readonly prisma: PrismaService,
    private readonly platform: PlatformSettingsService,
    private readonly entitlements: EntitlementsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** The provider to use, or null when none is configured. */
  async provider(tier: "standard" | "light" = "standard"): Promise<AiProviderConfig | null> {
    const s = await this.platform.get();
    if (s.aiProvider !== "anthropic" && s.aiProvider !== "openai") return null;
    const apiKey = await this.platform.aiApiKey();
    if (!apiKey) return null;
    return {
      provider: s.aiProvider,
      apiKey,
      model: s.aiModel.trim() || DEFAULT_MODELS[s.aiProvider][tier],
      baseUrl: this.config.AI_BASE_URL,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    };
  }

  cacheKey(feature: AiFeature, cfg: Pick<AiProviderConfig, "provider" | "model">, request: AiRequest): string {
    return createHash("sha256").update(JSON.stringify([feature, cfg.provider, cfg.model, request.system, request.messages, request.maxTokens])).digest("hex");
  }

  /** A cached answer for this prompt, if one is still fresh (no credit, nothing recorded). */
  async peek<T>(workspaceId: string, feature: AiFeature, request: AiRequest, tier: "standard" | "light" = "standard"): Promise<T | null> {
    const cfg = await this.provider(tier);
    if (!cfg) return null;
    const hit = await this.prisma.db.aiCache.findFirst({ where: { workspaceId, key: this.cacheKey(feature, cfg, request), expiresAt: { gt: new Date() } } });
    return hit ? ((hit.output as { value: T }).value ?? null) : null;
  }

  async run<T>(input: AiRunInput<T>): Promise<AiRunResult<T>> {
    const cfg = await this.provider(input.tier);
    if (!cfg) throw unavailable(NOT_CONFIGURED);
    await this.entitlements.assertFeature(input.billingAccountId, "ai");

    const db = this.prisma.db;
    const key = this.cacheKey(input.feature, cfg, input.request);
    if (!input.fresh) {
      const hit = await db.aiCache.findFirst({ where: { workspaceId: input.workspaceId, key, expiresAt: { gt: new Date() } } });
      if (hit) {
        await this.record(input, cfg.provider, cfg.model, 0, 0, true);
        return { output: (hit.output as { value: T }).value, cached: true, provider: cfg.provider, model: cfg.model };
      }
    }

    const period = await this.entitlements.assertConsume(input.workspaceId, input.billingAccountId, "monthlyAiCredits", AI_CREDITS_PER_CALL);
    let output: T;
    let model = cfg.model;
    try {
      const res = await complete(cfg, input.request);
      model = res.model;
      try {
        output = input.parse(res.text);
      } catch (e) {
        this.log.warn(`${input.feature}: unusable answer from ${cfg.provider}/${res.model}${res.truncated ? " (truncated)" : ""}: ${e instanceof Error ? e.message : String(e)}`);
        throw new AiProviderError("bad_response", "The AI model's answer could not be used — try again.");
      }
      await this.record(input, cfg.provider, res.model, res.inputTokens, res.outputTokens, false);
    } catch (e) {
      await this.refund(input.workspaceId, period);
      throw this.toApiError(e);
    }

    const expiresAt = new Date(Date.now() + input.cacheTtlMs);
    await db.aiCache.upsert({
      where: { workspaceId_key: { workspaceId: input.workspaceId, key } },
      create: { workspaceId: input.workspaceId, key, feature: input.feature, output: { value: output } as never, expiresAt },
      update: { output: { value: output } as never, expiresAt, createdAt: new Date() },
    });
    return { output, cached: false, provider: cfg.provider, model };
  }

  private async record(input: AiRunInput<unknown>, provider: string, model: string, inputTokens: number, outputTokens: number, cached: boolean) {
    await this.prisma.db.aiUsage.create({
      data: { workspaceId: input.workspaceId, userId: input.userId, feature: input.feature, provider, model, inputTokens, outputTokens, cached },
    });
  }

  /** Gives back the credit taken for a call that produced nothing usable. */
  private async refund(workspaceId: string, period: string) {
    await this.prisma.db.usageCounter
      .updateMany({ where: { workspaceId, metric: "ai_credits", period, value: { gte: AI_CREDITS_PER_CALL } }, data: { value: { decrement: AI_CREDITS_PER_CALL } } })
      .catch((e: unknown) => this.log.error(`could not refund an AI credit for ${workspaceId}: ${e instanceof Error ? e.message : String(e)}`));
  }

  private toApiError(e: unknown): ApiError {
    if (e instanceof ApiError) return e;
    if (!(e instanceof AiProviderError)) {
      this.log.error(`AI call failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
      return new AiCallError(502, "ai_failed", "The AI request failed — try again.", true);
    }
    this.log.warn(`AI provider error (${e.kind}${e.status ? `, HTTP ${e.status}` : ""}): ${e.message}`);
    switch (e.kind) {
      case "auth":
        return new AiCallError(503, "ai_unavailable", `${e.message}. An administrator needs to check the AI provider settings.`, false);
      case "rate_limited":
        return new AiCallError(429, "ai_rate_limited", e.message, true);
      case "unavailable":
        return new AiCallError(503, "ai_unavailable", e.message, true);
      case "refused":
        return new AiCallError(422, "ai_refused", "The AI model declined this request. Rephrase the instructions and try again.", false);
      case "rejected":
        return new AiCallError(502, "ai_rejected", e.message, false);
      case "bad_response":
        return new AiCallError(502, "ai_bad_response", e.message, true);
    }
  }
}
