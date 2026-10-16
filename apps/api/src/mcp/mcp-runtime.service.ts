import { readFileSync } from "node:fs";
import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { AuditService } from "../core/audit.service.js";
import { PlatformSettingsService } from "../core/platform-settings.service.js";
import { RedisThrottlerStorage } from "../common/throttle.js";
import { parseWith } from "../common/decorators.js";
import { ApiError, conflict, forbidden, isApiError, tooMany, unavailable } from "../common/errors.js";
import { fromPrisma, fromUpstream } from "../common/exception.filter.js";
import { TenantScopeError } from "../prisma/tenant-guard.js";
import { reportError } from "../common/sentry.js";
import { annotationsFor, confirmRefusal, toolRefusal, toolVisible } from "./access.js";
import { McpConfirmationsService } from "./confirmations.service.js";
import { serverInstructions } from "./instructions.js";
import { defineTool, isReply, reply, type McpCtx, type McpDeps, type McpPrompt, type McpResource, type McpTool } from "./tool.js";
import { MCP_PROMPTS, MCP_RESOURCES, MCP_TOOLS } from "./tools/index.js";

/** Extra tools from outside src/mcp/tools (tests provide a fake important tool through a global module). */
export const MCP_EXTRA_TOOLS = "MCP_EXTRA_TOOLS";

/** The most text one result carries; longer output is cut with a note (the model pays for every character). */
const MAX_TEXT = 24_000;

const TOOL_NAME = /^[a-z][a-z0-9_]{1,63}$/;

function readVersion(): string {
  try {
    // src/mcp and dist/mcp are both two levels below apps/api.
    return (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const VERSION = readVersion();

const json = (value: unknown) => JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2) ?? "null";

const clip = (text: string) => (text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT)}\n… (cut at ${MAX_TEXT} characters — ask for less: a smaller page, a filter, or one record)`);

/** A result as kept on the pending action: small results whole, large ones cut to a readable preview. */
function storable(value: unknown): unknown {
  const text = json(value ?? null);
  return text.length <= 20_000 ? (JSON.parse(text) as unknown) : { truncated: true, preview: text.slice(0, 2000) };
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

/** Anything a tool threw, as the ApiError the HTTP API would have answered with. Unknown errors become a generic 500. */
function asApiError(e: unknown): ApiError {
  if (isApiError(e)) return e;
  if (e instanceof McpError) return new ApiError(400, "bad_request", e.message);
  if (e instanceof TenantScopeError) return new ApiError(500, "server_error", "Something went wrong");
  return fromPrisma(e) ?? fromUpstream(e) ?? new ApiError(500, "server_error", "Something went wrong");
}

function errorText(err: ApiError): string {
  const fields = err.fields ? Object.entries(err.fields).filter(([k]) => k !== "_") : [];
  const lines = [`Error (${err.code}): ${err.message}`];
  if (fields.length) lines.push(...fields.map(([k, v]) => `- ${k}: ${v}`));
  if (err.status === 402) lines.push("This is a plan limit: the workspace owner can upgrade under Settings → Plan & billing.");
  return lines.join("\n");
}

/*
 * The MCP server behind POST /mcp (mcp.controller.ts). Stateless: the
 * controller asks for a new Server per request, bound to that request's
 * context (McpAuthService), and throws it away afterwards.
 *
 * Every tools/call goes through call(): per-token rate limit, access checks
 * (access.ts), maintenance mode for anything that is not a read, argument
 * validation, then either the handler or — for an important tool — its
 * preview stored as a pending action. Each call is logged in McpCall.
 */
@Injectable()
export class McpRuntime {
  private readonly log = new Logger("mcp");
  readonly tools: ReadonlyMap<string, McpTool>;
  private readonly prompts: ReadonlyMap<string, McpPrompt>;
  private readonly resources: ReadonlyMap<string, McpResource>;
  /** JSON Schemas, converted once from each tool's Zod input/output. */
  private readonly schemas = new Map<string, { input: Tool["inputSchema"]; output?: Tool["outputSchema"] }>();
  private readonly deps: McpDeps;

  constructor(
    moduleRef: ModuleRef,
    private readonly prisma: PrismaService,
    private readonly confirmations: McpConfirmationsService,
    private readonly audit: AuditService,
    private readonly platform: PlatformSettingsService,
    private readonly throttle: RedisThrottlerStorage,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Optional() @Inject(MCP_EXTRA_TOOLS) extra: McpTool[] | null,
  ) {
    this.deps = { get: (type) => moduleRef.get(type, { strict: false }), prisma };
    const all = [...this.builtinTools(), ...MCP_TOOLS, ...(extra ?? [])];
    const tools = new Map<string, McpTool>();
    for (const t of all) {
      const trouble = toolDefinitionTrouble(t);
      if (trouble) throw new Error(`MCP tool "${t.name}": ${trouble}`);
      if (tools.has(t.name)) throw new Error(`MCP tool "${t.name}" is defined twice`);
      tools.set(t.name, t);
      this.schemas.set(t.name, {
        input: jsonSchemaOf(t.input) as Tool["inputSchema"],
        output: t.output && t.risk !== "important" ? (jsonSchemaOf(t.output) as Tool["outputSchema"]) : undefined,
      });
    }
    this.tools = tools;
    this.prompts = new Map(MCP_PROMPTS.map((p) => [p.name, p]));
    this.resources = new Map(MCP_RESOURCES.map((r) => [r.uri, r]));
  }

  /** A fresh MCP server for one request, acting as `ctx`. */
  server(ctx: McpCtx): Server {
    const server = new Server(
      { name: "growthdesk", title: "Growthdesk", version: VERSION },
      { capabilities: { tools: {}, prompts: {}, resources: {} }, instructions: serverInstructions(ctx) },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: this.listFor(ctx) }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => this.call(ctx, req.params.name, req.params.arguments ?? {}));
    server.setRequestHandler(ListPromptsRequestSchema, async () => ({
      prompts: [...this.prompts.values()].map((p) => ({ name: p.name, title: p.title, description: p.description, arguments: p.arguments ?? [] })),
    }));
    server.setRequestHandler(GetPromptRequestSchema, async (req) => {
      const prompt = this.prompts.get(req.params.name);
      if (!prompt) throw new McpError(ErrorCode.InvalidParams, `Unknown prompt "${req.params.name}"`);
      const args = req.params.arguments ?? {};
      for (const a of prompt.arguments ?? []) {
        if (a.required && !args[a.name]) throw new McpError(ErrorCode.InvalidParams, `The prompt needs "${a.name}"`);
      }
      return { description: prompt.description, messages: [{ role: "user", content: { type: "text", text: await prompt.render(args, ctx) } }] };
    });
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: [...this.resources.values()].map((r) => ({ uri: r.uri, name: r.name, title: r.title, description: r.description, mimeType: r.mimeType })),
    }));
    server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
      const resource = this.resources.get(req.params.uri);
      if (!resource) throw new McpError(ErrorCode.InvalidParams, `Unknown resource "${req.params.uri}"`);
      return { contents: [{ uri: resource.uri, mimeType: resource.mimeType, text: await resource.read(ctx, this.deps) }] };
    });
    return server;
  }

  /** The tools this token could call (or prepare), as MCP tool descriptions. */
  listFor(ctx: McpCtx): Tool[] {
    return [...this.tools.values()]
      .filter((t) => toolVisible(t, ctx))
      .map((t) => {
        const schema = this.schemas.get(t.name)!;
        const description =
          t.risk === "important"
            ? `${t.description}\n\nIMPORTANT ACTION: calling this only prepares it and returns a confirmationId — nothing happens yet. Show the summary to the user, get their explicit approval, then call confirm_action.`
            : t.description;
        return {
          name: t.name,
          title: t.title,
          description,
          inputSchema: schema.input,
          ...(schema.output ? { outputSchema: schema.output } : {}),
          annotations: annotationsFor(t),
        };
      });
  }

  /** One tools/call. Never throws for a tool's own failure: the model gets an error result it can read and act on. */
  async call(ctx: McpCtx, name: string, rawArgs: unknown): Promise<CallToolResult> {
    const tool = this.tools.get(name);
    if (!tool) throw new McpError(ErrorCode.InvalidParams, `Unknown tool "${name.slice(0, 100)}"`);
    const started = Date.now();
    try {
      await this.rateLimit(ctx);
      const refusal = toolRefusal(tool, ctx);
      if (refusal) throw forbidden(refusal);
      if (tool.risk !== "read") await this.assertNotInMaintenance(ctx);
      const args = parseWith(tool.input, rawArgs ?? {});
      const out = tool.risk === "important" ? await this.prepare(ctx, tool, args) : await tool.handler(ctx, args, this.deps);
      this.record(ctx, tool.name, started, null);
      return this.render(tool, out);
    } catch (e) {
      const err = asApiError(e);
      if (!isApiError(e)) {
        this.log.error(`tool ${tool.name} failed [request ${ctx.requestId}]`, e instanceof Error ? e.stack : String(e));
        reportError(e, { requestId: ctx.requestId, tags: { mcpTool: tool.name } });
      }
      this.record(ctx, tool.name, started, err.message);
      return { isError: true, content: [{ type: "text", text: errorText(err) }] };
    }
  }

  private render(tool: McpTool, out: unknown): CallToolResult {
    if (isReply(out)) {
      return { content: [{ type: "text", text: clip(out.text) }], ...(out.data ? { structuredContent: out.data } : {}) };
    }
    const value = out === undefined ? { ok: true } : out;
    const text = typeof value === "string" ? value : json(value);
    const structured = tool.output && tool.risk !== "important" && isPlainObject(value) ? { structuredContent: JSON.parse(json(value)) as Record<string, unknown> } : {};
    return { content: [{ type: "text", text: clip(text) }], ...structured };
  }

  /** An important tool: validate and describe, store it for confirm_action, change nothing else. */
  private async prepare(ctx: McpCtx, tool: McpTool, args: unknown) {
    const preview = await tool.preview!(ctx, args, this.deps);
    const stored = preview.args === undefined ? args : parseWith(tool.input, preview.args);
    const row = await this.confirmations.create(ctx, tool.name, stored, preview);
    const minutes = Math.round((row.expiresAt.getTime() - Date.now()) / 60_000);
    const lines = [
      "CONFIRMATION NEEDED — nothing has happened yet.",
      "",
      preview.summary,
      ...(preview.details && Object.keys(preview.details).length ? ["", `Details: ${json(preview.details)}`] : []),
      "",
      `confirmationId: ${row.id} (expires in ${minutes} minutes)`,
      "",
      "Show this to the user and ask for approval; then call confirm_action with this confirmationId. If they decline, call cancel_action.",
      ...(ctx.mcp.access === "send" ? [] : ["", `Note: ${confirmRefusal(ctx.mcp.access)}`]),
    ];
    return reply(lines.join("\n"), {
      status: "confirmation_required",
      confirmationId: row.id,
      tool: tool.name,
      summary: preview.summary,
      details: preview.details ?? {},
      expiresAt: row.expiresAt.toISOString(),
      canConfirm: ctx.mcp.access === "send",
    });
  }

  /** confirm_action: run a prepared important action, once, if this token may. */
  async confirm(ctx: McpCtx, confirmationId: string) {
    const refusal = confirmRefusal(ctx.mcp.access);
    if (refusal) throw forbidden(refusal);
    const row = await this.confirmations.open(ctx, confirmationId);
    const tool = this.tools.get(row.tool);
    if (!tool || tool.risk !== "important") throw conflict("That action can no longer be carried out here. Prepare it again.");
    // The role may have changed since it was prepared; the token itself was re-checked for this request.
    const toolTrouble = toolRefusal(tool, ctx);
    if (toolTrouble) throw forbidden(toolTrouble);
    const args = parseWith(tool.input, row.args);
    await this.confirmations.claim(ctx, row.id);
    try {
      const out = await tool.handler(ctx, args, this.deps);
      await this.confirmations.finish(ctx, row.id, { ok: true, result: storable(isReply(out) ? (out.data ?? { text: out.text }) : out) });
      await this.audit.record(ctx, { action: "mcp.action_confirmed", targetType: "mcp_action", targetId: row.id, metadata: { tool: row.tool, summary: row.summary } });
      if (isReply(out)) return reply(`Done — confirmed and carried out.\n\n${out.text}`, out.data);
      return { done: true, tool: row.tool, result: out ?? null };
    } catch (e) {
      const err = asApiError(e);
      await this.confirmations.finish(ctx, row.id, { ok: false, error: err.message });
      await this.audit.record(ctx, { action: "mcp.action_failed", targetType: "mcp_action", targetId: row.id, metadata: { tool: row.tool, summary: row.summary, error: err.message } });
      throw e;
    }
  }

  /** The framework's own tools: the confirmation step. */
  private builtinTools(): McpTool[] {
    const id = z.object({ confirmationId: z.string().trim().min(1).max(64).describe("The confirmationId an important tool returned.") });
    return [
      defineTool({
        name: "confirm_action",
        title: "Confirm an important action — ask the user first",
        description:
          "Carries out an important action prepared earlier (its tool returned a confirmationId). Call this ONLY after showing the user that action's summary and getting their explicit yes in this conversation. Each confirmation works once, within 10 minutes, through the connection that prepared it, and only with a Send token.",
        input: id,
        permission: null,
        risk: "write",
        idempotent: false,
        annotations: { destructiveHint: true, openWorldHint: true },
        handler: (ctx, args) => this.confirm(ctx, args.confirmationId),
      }),
      defineTool({
        name: "cancel_action",
        title: "Cancel a prepared action",
        description: "Drops an important action prepared earlier, when the user declines it or wants to change it. Nothing was done, and nothing will be.",
        input: id,
        permission: null,
        risk: "write",
        idempotent: true,
        handler: async (ctx, args) => {
          const row = await this.confirmations.cancel(ctx, args.confirmationId);
          return { canceled: true, confirmationId: row.id, tool: row.tool, summary: row.summary };
        },
      }),
      defineTool({
        name: "list_pending_actions",
        title: "List actions awaiting confirmation",
        description: "Important actions this connection has prepared that are still waiting for the user's approval (they lapse after 10 minutes).",
        input: z.object({}),
        permission: null,
        risk: "read",
        handler: async (ctx) => {
          const rows = await this.confirmations.pending(ctx);
          return {
            items: rows.map((r) => ({ confirmationId: r.id, tool: r.tool, summary: r.summary, details: r.preview, expiresAt: r.expiresAt })),
            canConfirm: ctx.mcp.access === "send",
          };
        },
      }),
    ];
  }

  private async rateLimit(ctx: McpCtx) {
    const limit = this.config.MCP_CALLS_PER_MINUTE;
    const r = await this.throttle.increment(`mcp:${ctx.mcp.tokenId}`, 60_000, limit, 0, "mcp");
    if (r.isBlocked) throw tooMany(`Too many tool calls: a token may make ${limit} a minute. Wait ${Math.max(1, Math.ceil(r.timeToBlockExpire))} seconds and try again.`);
  }

  private async assertNotInMaintenance(ctx: McpCtx) {
    if (ctx.identity.platformRole !== "none") return;
    const settings = await this.platform.get();
    if (settings.maintenanceMode) throw unavailable(settings.maintenanceMessage || "Growthdesk is in maintenance for a few minutes — nothing can be changed until it is back.");
  }

  /** The call log. Never fails the call it describes. */
  private record(ctx: McpCtx, tool: string, started: number, error: string | null) {
    void this.prisma.db.mcpCall
      .create({
        data: {
          workspaceId: ctx.workspace.id,
          tokenId: ctx.mcp.tokenId,
          userId: ctx.identity.userId,
          tool,
          ok: error === null,
          error: error?.slice(0, 500) ?? null,
          durationMs: Date.now() - started,
        },
      })
      .catch((e: unknown) => this.log.warn(`could not log MCP call ${tool}: ${e instanceof Error ? e.message : String(e)}`));
  }
}

/** JSON Schema for a tool's arguments or result, as MCP wants it (an object schema, no $schema key). */
export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const out = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  delete out.$schema;
  return out;
}

/** What is wrong with a tool definition, or null. The registry refuses to start with a broken one. */
export function toolDefinitionTrouble(t: McpTool): string | null {
  if (!TOOL_NAME.test(t.name)) return "names are snake_case: lowercase letters, digits and _, 2–64 characters";
  if (!t.title?.trim() || !t.description?.trim()) return "needs a title and a description";
  if (!(t.input instanceof z.ZodObject)) return "input must be a z.object(...)";
  if (t.risk === "important" && typeof t.preview !== "function") return "an important tool needs a preview()";
  if (t.risk !== "important" && t.preview) return "only important tools have a preview()";
  if (t.output && !(t.output instanceof z.ZodObject)) return "output must be a z.object(...)";
  return null;
}
