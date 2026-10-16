/*
 * Cartesia Managed Agents over plain HTTP (no SDK): the voice agent behind
 * AI calling. Docs: https://docs.cartesia.ai/agents/introduction and the API
 * reference (Cartesia-Version 2026-08-14).
 *
 *   GET    /agents/phone-numbers         numbers on the account (the caller ids)
 *   GET    /voices                       voices to choose from
 *   POST   /v1/agents                    create an agent (config: instructions, voice…)
 *   PATCH  /v1/agents/{id}               update it (a new version; calls in flight keep theirs)
 *   DELETE /v1/agents/{id}
 *   POST   /agents/webhooks              register our webhook URL + shared secret
 *   PATCH  /agents/{id} {webhook_id}     attach the webhook to an agent
 *   POST   /agents/calls                 place an outbound call (per-call dynamic variables)
 *   GET    /agents/calls/{id}            a call: status, end reason, transcript, summary
 *
 * Base URL overridable for tests: CARTESIA_API_URL (default
 * https://api.cartesia.ai), read on every call. Never set it in production.
 */

export const CARTESIA_VERSION = "2026-08-14";
const TIMEOUT_MS = 20_000;
export const cartesiaBase = () => (process.env.CARTESIA_API_URL?.trim() || "https://api.cartesia.ai").replace(/\/+$/, "");

export class CartesiaError extends Error {
  constructor(
    message: string,
    /** HTTP status; 0 when Cartesia could not be reached (the request may or may not have arrived). */
    readonly status: number,
  ) {
    super(message);
    this.name = "CartesiaError";
  }
}

async function call<T>(apiKey: string, method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown, query?: Record<string, string | undefined>): Promise<T> {
  const url = new URL(`${cartesiaBase()}${path}`);
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== "") url.searchParams.set(k, v);
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${apiKey}`,
        "x-api-key": apiKey,
        "cartesia-version": CARTESIA_VERSION,
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "error",
    });
  } catch (e) {
    const err = e as { name?: string; cause?: { code?: string } };
    throw new CartesiaError(err.name === "TimeoutError" ? "Cartesia did not answer in time" : `Cartesia could not be reached${err.cause?.code ? ` (${err.cause.code})` : ""}`, 0);
  }
  const raw = await res.text().catch(() => "");
  let json: unknown = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    json = null;
  }
  if (!res.ok) throw new CartesiaError(messageOf(json) || `Cartesia answered HTTP ${res.status}`, res.status);
  return json as T;
}

function messageOf(json: unknown): string {
  if (!json || typeof json !== "object") return "";
  const o = json as Record<string, unknown>;
  const pick = (v: unknown): string => (typeof v === "string" ? v : v && typeof v === "object" && typeof (v as { message?: unknown }).message === "string" ? (v as { message: string }).message : "");
  const msg = pick(o.message) || pick(o.error) || pick(o.detail) || (Array.isArray(o.detail) ? pick(o.detail[0]) || (o.detail[0] as { msg?: string })?.msg || "" : "");
  return msg.replace(/\s+/g, " ").trim().slice(0, 300);
}

export type CartesiaPhoneNumber = {
  id: string;
  number: string;
  label: string | null;
  agent: { id: string; name: string } | null;
  provider: string;
};

export type CartesiaVoice = {
  id: string;
  name: string;
  description: string;
  language: string;
  gender: string | null;
};

export type CartesiaTurn = {
  role?: string;
  text?: string | null;
  start_timestamp?: number;
  end_timestamp?: number;
};

export type CartesiaCall = {
  id: string;
  agent_id?: string;
  status?: "created" | "started" | "completed" | "failed" | string;
  start_time?: string | null;
  end_time?: string | null;
  end_reason?: string | null;
  error_message?: string | null;
  summary?: string | null;
  transcript?: CartesiaTurn[] | null;
  telephony_params?: {
    to?: string;
    from?: string;
    call_sid?: string;
    direction?: string;
  } | null;
  dynamic_variables?: Record<string, unknown> | null;
};

/** The managed-agent config we send (a subset of Cartesia's; omitted fields keep Cartesia's defaults). */
export type CartesiaAgentConfig = {
  instructions: string;
  initial_message: string | null;
  language: { primary: string };
  audio: { output: { voice_id: string } };
  dynamic_variable_placeholders: Record<string, string>;
  system_tools: {
    end_call: {
      description: string | null;
      pre_tool_speech: "auto" | "force" | "off";
    } | null;
    transfer_to_number: {
      description: null;
      pre_tool_speech: "auto";
      transfers: {
        destination: { type: "phone"; phone_number: string };
        condition: string;
      }[];
    } | null;
  };
};

type Page<T> = { data?: T[]; has_more?: boolean };

export const cartesiaApi = {
  /** Proves the key and lists the account's numbers. */
  async phoneNumbers(apiKey: string): Promise<CartesiaPhoneNumber[]> {
    const r = await call<Page<Record<string, unknown>> | Record<string, unknown>[]>(apiKey, "GET", "/agents/phone-numbers", undefined, { limit: "100" });
    const rows = Array.isArray(r) ? r : (r?.data ?? []);
    return rows
      .map((p) => ({
        id: String(p.id ?? ""),
        number: String(p.number ?? ""),
        label: typeof p.label === "string" ? p.label : null,
        agent:
          p.agent && typeof p.agent === "object"
            ? {
                id: String((p.agent as { id?: unknown }).id ?? ""),
                name: String((p.agent as { name?: unknown }).name ?? ""),
              }
            : null,
        provider: typeof (p.provider as { type?: unknown } | undefined)?.type === "string" ? String((p.provider as { type: string }).type) : "",
      }))
      .filter((p) => p.id && p.number);
  },

  async voices(apiKey: string, q: { q?: string; language?: string; gender?: string }): Promise<CartesiaVoice[]> {
    const r = await call<Page<Record<string, unknown>> | Record<string, unknown>[]>(apiKey, "GET", "/voices", undefined, {
      q: q.q,
      language: q.language,
      gender: q.gender,
      limit: "100",
    });
    const rows = Array.isArray(r) ? r : (r?.data ?? []);
    return rows
      .map((v) => ({
        id: String(v.id ?? ""),
        name: String(v.name ?? ""),
        description: typeof v.description === "string" ? v.description : "",
        language: typeof v.language === "string" ? v.language : "",
        gender: typeof v.gender === "string" ? v.gender : null,
      }))
      .filter((v) => v.id);
  },

  async createAgent(apiKey: string, input: { name: string; description: string; config: CartesiaAgentConfig }): Promise<{ id: string }> {
    const r = await call<{ id?: string }>(apiKey, "POST", "/v1/agents", input);
    if (!r?.id) throw new CartesiaError("Cartesia created the agent but returned no id", 502);
    return { id: r.id };
  },

  async updateAgent(apiKey: string, agentId: string, input: { name: string; description: string; config: CartesiaAgentConfig }): Promise<void> {
    await call(apiKey, "PATCH", `/v1/agents/${encodeURIComponent(agentId)}`, input);
  },

  async deleteAgent(apiKey: string, agentId: string): Promise<void> {
    await call(apiKey, "DELETE", `/v1/agents/${encodeURIComponent(agentId)}`);
  },

  async createWebhook(apiKey: string, input: { url: string; secret: string; display_name: string }): Promise<{ id: string }> {
    const r = await call<{ id?: string }>(apiKey, "POST", "/agents/webhooks", input);
    if (!r?.id) throw new CartesiaError("Cartesia created the webhook but returned no id", 502);
    return { id: r.id };
  },

  async deleteWebhook(apiKey: string, webhookId: string): Promise<void> {
    await call(apiKey, "DELETE", `/agents/webhooks/${encodeURIComponent(webhookId)}`);
  },

  /** Turns on webhook delivery for one agent's calls. */
  async attachWebhook(apiKey: string, agentId: string, webhookId: string): Promise<void> {
    await call(apiKey, "PATCH", `/agents/${encodeURIComponent(agentId)}`, {
      webhook_id: webhookId,
    });
  },

  /** One destination per request, so one result: the call id, or Cartesia's reason for refusing that number. */
  async placeCall(
    apiKey: string,
    input: {
      agentId: string;
      fromNumberId: string;
      to: string;
      variables: Record<string, string>;
      maxMinutes: number;
    },
  ): Promise<{ callId: string } | { error: string }> {
    const r = await call<{
      calls?: { number?: string; agent_call_id?: string; error?: unknown }[];
    }>(apiKey, "POST", "/agents/calls", {
      agent_id: input.agentId,
      from_number_id: input.fromNumberId,
      ringing_timeout_seconds: 40,
      max_call_duration_minutes: input.maxMinutes,
      outbound_calls: [{ to_number: input.to, dynamic_variables: input.variables }],
    });
    const one = r?.calls?.[0];
    if (one?.agent_call_id) return { callId: one.agent_call_id };
    if (one?.error)
      return {
        error: messageOf({ error: one.error }) || JSON.stringify(one.error).slice(0, 300),
      };
    throw new CartesiaError("Cartesia accepted the request but returned no call", 502);
  },

  async getCall(apiKey: string, callId: string): Promise<CartesiaCall> {
    return call<CartesiaCall>(apiKey, "GET", `/agents/calls/${encodeURIComponent(callId)}`);
  },
};
