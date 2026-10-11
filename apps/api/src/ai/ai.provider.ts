/*
 * The AI provider adapters: one function per wire format, plain fetch, no SDK.
 * Adapted from LinkDesk's provider table (ai.service.ts): the request shapes
 * are the same, and on top of them this adds a hard timeout and a single
 * error type whose `kind` says whether trying again can help.
 *
 *   anthropic  POST {base}/v1/messages           (base default https://api.anthropic.com)
 *   openai     POST {base}/chat/completions      (base default https://api.openai.com/v1)
 *
 * `openai` is any OpenAI-compatible chat endpoint; AI_BASE_URL points it at a
 * gateway or a self-hosted server (and points either adapter at a local fake
 * in tests).
 */

export type AiProviderName = "anthropic" | "openai";

export type AiProviderConfig = {
  provider: AiProviderName;
  apiKey: string;
  model: string;
  /** Overrides the provider's public endpoint (no trailing slash needed). */
  baseUrl?: string;
  timeoutMs?: number;
};

export type AiMessage = { role: "user" | "assistant"; content: string };

export type AiRequest = {
  system: string;
  messages: AiMessage[];
  maxTokens: number;
};

export type AiCompletion = {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** The model stopped at maxTokens; the text may be cut short. */
  truncated: boolean;
};

/**
 *   auth          the key was refused, or the provider account cannot be billed
 *   rate_limited  429 — retry later
 *   unavailable   5xx / 529 overloaded, network failure or timeout — retry later
 *   rejected      the provider refused the request itself (unknown model, too long…)
 *   refused       the model declined to answer (safety stop)
 *   bad_response  the answer could not be read
 */
export type AiErrorKind = "auth" | "rate_limited" | "unavailable" | "rejected" | "refused" | "bad_response";

export class AiProviderError extends Error {
  constructor(
    readonly kind: AiErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "AiProviderError";
  }

  get retryable(): boolean {
    return this.kind === "rate_limited" || this.kind === "unavailable";
  }
}

export const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Default models when the platform has not named one. `light` is the cheap
 * tier used for reply classification. An explicit model (AI_MODEL or the admin
 * setting) is used for every feature.
 */
export const DEFAULT_MODELS: Record<AiProviderName, { standard: string; light: string }> = {
  anthropic: { standard: "claude-sonnet-5-5", light: "claude-haiku-5-5" },
  openai: { standard: "gpt-4.1-mini", light: "gpt-4.1-mini" },
};

const DEFAULT_BASE: Record<AiProviderName, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com/v1",
};

export async function complete(cfg: AiProviderConfig, req: AiRequest, fetchImpl: typeof fetch = fetch): Promise<AiCompletion> {
  return cfg.provider === "anthropic" ? anthropic(cfg, req, fetchImpl) : openai(cfg, req, fetchImpl);
}

async function anthropic(cfg: AiProviderConfig, req: AiRequest, fetchImpl: typeof fetch): Promise<AiCompletion> {
  const body = await post(
    fetchImpl,
    `${base(cfg)}/v1/messages`,
    { "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01" },
    { model: cfg.model, max_tokens: req.maxTokens, system: req.system, messages: req.messages },
    cfg.timeoutMs,
  );
  const res = body as {
    model?: string;
    content?: { type: string; text?: string }[];
    stop_reason?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  if (res.stop_reason === "refusal") throw new AiProviderError("refused", "The AI model declined this request.");
  if (!Array.isArray(res.content)) throw new AiProviderError("bad_response", "The AI provider's answer had no content.");
  // Thinking blocks (and anything else that is not text) are skipped.
  const text = res.content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("")
    .trim();
  if (!text) throw new AiProviderError("bad_response", res.stop_reason === "max_tokens" ? "The AI model ran out of room before answering." : "The AI model returned an empty answer.");
  return {
    text,
    model: res.model || cfg.model,
    inputTokens: res.usage?.input_tokens ?? 0,
    outputTokens: res.usage?.output_tokens ?? 0,
    truncated: res.stop_reason === "max_tokens",
  };
}

async function openai(cfg: AiProviderConfig, req: AiRequest, fetchImpl: typeof fetch): Promise<AiCompletion> {
  const body = await post(
    fetchImpl,
    `${base(cfg)}/chat/completions`,
    { authorization: `Bearer ${cfg.apiKey}` },
    { model: cfg.model, max_tokens: req.maxTokens, messages: [{ role: "system", content: req.system }, ...req.messages] },
    cfg.timeoutMs,
  );
  const res = body as {
    model?: string;
    choices?: { message?: { content?: string | null; refusal?: string | null }; finish_reason?: string }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const choice = res.choices?.[0];
  if (!choice) throw new AiProviderError("bad_response", "The AI provider's answer had no choices.");
  if (choice.finish_reason === "content_filter" || choice.message?.refusal) throw new AiProviderError("refused", "The AI model declined this request.");
  const text = (choice.message?.content ?? "").trim();
  if (!text) throw new AiProviderError("bad_response", "The AI model returned an empty answer.");
  return {
    text,
    model: res.model || cfg.model,
    inputTokens: res.usage?.prompt_tokens ?? 0,
    outputTokens: res.usage?.completion_tokens ?? 0,
    truncated: choice.finish_reason === "length",
  };
}

const base = (cfg: AiProviderConfig) => (cfg.baseUrl || DEFAULT_BASE[cfg.provider]).replace(/\/+$/, "");

async function post(fetchImpl: typeof fetch, url: string, headers: Record<string, string>, payload: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...headers },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    if (name === "TimeoutError" || name === "AbortError") throw new AiProviderError("unavailable", `The AI provider did not answer within ${Math.round(timeoutMs / 1000)} seconds.`);
    throw new AiProviderError("unavailable", "Could not reach the AI provider.");
  }
  const raw = await res.text().catch(() => "");
  let json: unknown = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    json = null;
  }
  if (!res.ok) throw errorFor(res.status, json);
  if (json === null || typeof json !== "object") throw new AiProviderError("bad_response", "The AI provider answered with something that is not JSON.");
  return json;
}

/** Maps an HTTP failure to an error kind; the provider's own message is kept (short) because it names the problem. */
export function errorFor(status: number, json: unknown): AiProviderError {
  const detail = providerMessage(json);
  const suffix = detail ? `: ${detail}` : "";
  if (status === 401 || status === 403) return new AiProviderError("auth", `The AI provider refused this installation's API key${suffix}`, status);
  if (status === 402) return new AiProviderError("auth", `The AI provider account cannot be billed${suffix}`, status);
  if (status === 429) return new AiProviderError("rate_limited", "The AI provider is rate limiting requests — try again in a minute.", status);
  if (status === 408 || status >= 500) return new AiProviderError("unavailable", `The AI provider is unavailable right now (HTTP ${status}) — try again shortly.`, status);
  return new AiProviderError("rejected", `The AI provider rejected the request (HTTP ${status})${suffix}`, status);
}

function providerMessage(json: unknown): string {
  const err = (json as { error?: { message?: unknown } | string } | null)?.error;
  const msg = typeof err === "string" ? err : typeof err?.message === "string" ? err.message : "";
  return msg.replace(/\s+/g, " ").trim().slice(0, 300);
}
