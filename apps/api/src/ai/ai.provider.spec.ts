import { AiProviderError, complete, errorFor, type AiProviderConfig } from "./ai.provider.js";

/** A fetch stand-in that records the request and answers with `status` / `body`. */
function fakeFetch(status: number, body: unknown, seen: { url?: string; init?: RequestInit }[] = []) {
  return (async (url: string, init?: RequestInit) => {
    seen.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

const anthropic: AiProviderConfig = { provider: "anthropic", apiKey: "test-key", model: "claude-sonnet-5-5", baseUrl: "http://fake.local/" };
const openai: AiProviderConfig = { provider: "openai", apiKey: "test-key", model: "gpt-test", baseUrl: "http://fake.local/v1" };
const req = { system: "sys", messages: [{ role: "user" as const, content: "hi" }], maxTokens: 100 };

describe("AI provider adapters", () => {
  it("speaks the Anthropic Messages API and skips non-text blocks", async () => {
    const seen: { url?: string; init?: RequestInit }[] = [];
    const res = await complete(
      anthropic,
      req,
      fakeFetch(200, { model: "claude-sonnet-5-5", content: [{ type: "thinking", thinking: "" }, { type: "text", text: " Hello " }], stop_reason: "end_turn", usage: { input_tokens: 12, output_tokens: 3 } }, seen),
    );
    expect(res).toEqual({ text: "Hello", model: "claude-sonnet-5-5", inputTokens: 12, outputTokens: 3, truncated: false });
    expect(seen[0]!.url).toBe("http://fake.local/v1/messages");
    const headers = seen[0]!.init!.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("test-key");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(JSON.parse(String(seen[0]!.init!.body))).toEqual({ model: "claude-sonnet-5-5", max_tokens: 100, system: "sys", messages: [{ role: "user", content: "hi" }] });
  });

  it("speaks OpenAI-compatible chat completions with the system prompt first", async () => {
    const seen: { url?: string; init?: RequestInit }[] = [];
    const res = await complete(openai, req, fakeFetch(200, { model: "gpt-test", choices: [{ message: { content: "Yo" }, finish_reason: "length" }], usage: { prompt_tokens: 5, completion_tokens: 1 } }, seen));
    expect(res).toMatchObject({ text: "Yo", inputTokens: 5, outputTokens: 1, truncated: true });
    expect(seen[0]!.url).toBe("http://fake.local/v1/chat/completions");
    expect((seen[0]!.init!.headers as Record<string, string>).authorization).toBe("Bearer test-key");
    expect(JSON.parse(String(seen[0]!.init!.body)).messages[0]).toEqual({ role: "system", content: "sys" });
  });

  it("maps refusals, empty answers and HTTP failures to error kinds", async () => {
    await expect(complete(anthropic, req, fakeFetch(200, { content: [], stop_reason: "refusal" }))).rejects.toMatchObject({ kind: "refused" });
    await expect(complete(anthropic, req, fakeFetch(200, { content: [{ type: "text", text: "" }] }))).rejects.toMatchObject({ kind: "bad_response" });
    await expect(complete(openai, req, fakeFetch(200, { choices: [{ message: { content: null, refusal: "no" } }] }))).rejects.toMatchObject({ kind: "refused" });
    await expect(complete(anthropic, req, fakeFetch(200, "<html>"))).rejects.toMatchObject({ kind: "bad_response" });
    await expect(complete(anthropic, req, fakeFetch(401, { error: { type: "authentication_error", message: "invalid x-api-key" } }))).rejects.toMatchObject({ kind: "auth" });

    expect(errorFor(429, null)).toMatchObject({ kind: "rate_limited", retryable: true });
    expect(errorFor(529, null)).toMatchObject({ kind: "unavailable", retryable: true });
    expect(errorFor(500, null).retryable).toBe(true);
    const rejected = errorFor(400, { error: { message: "model: not found" } });
    expect(rejected).toMatchObject({ kind: "rejected", retryable: false });
    expect(rejected.message).toContain("model: not found");
  });

  it("times out and reports network failures as retryable", async () => {
    const hang = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as unknown as typeof fetch;
    const err = await complete({ ...anthropic, timeoutMs: 50 }, req, hang).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiProviderError);
    expect(err).toMatchObject({ kind: "unavailable", retryable: true });
    expect((err as Error).message).toMatch(/did not answer/);

    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(complete(openai, req, down)).rejects.toMatchObject({ kind: "unavailable" });
  });
});
