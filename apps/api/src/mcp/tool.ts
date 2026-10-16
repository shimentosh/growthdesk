import type { Type } from "@nestjs/common";
import { z } from "zod";
import type { Identity, McpTokenContext, RequestContext, WorkspaceContext } from "../common/context.js";
import type { PrismaService } from "../prisma/prisma.service.js";

/*
 * The MCP tool framework (docs/MCP.md → "Adding tools").
 *
 * A tool is a plain object made with defineTool() in a domain file under
 * src/mcp/tools/ (contacts.tools.ts, marketing.tools.ts, …) that exports an
 * array; src/mcp/tools/index.ts concatenates the arrays. Handlers call the
 * existing Nest services through `deps.get(SomeService)` — never HTTP — with
 * the MCP context, which is an ordinary RequestContext acting as the token's
 * person, so services apply their own permission, ownership, plan and audit
 * rules exactly as for a browser request.
 *
 * risk:
 *   read       — looks only. The only kind a Read token may call.
 *   write      — creates or edits (drafts, records). Build and Send tokens.
 *   important  — sends, launches, deletes, spends. Calling it never acts: the
 *                framework runs `preview`, stores the arguments as a pending
 *                action and answers with a confirmationId. The person approves
 *                in the chat and the client calls confirm_action, which runs
 *                `handler` once — and only for a Send token.
 */

export type McpRisk = "read" | "write" | "important";

/** What a tool runs as: the token's person in the token's workspace, with permissions narrowed by its access level. */
export type McpCtx = RequestContext & { identity: Identity; workspace: WorkspaceContext; mcp: McpTokenContext };

export type McpDeps = {
  /** Any provider in the app, e.g. `deps.get(ContactsService)`. Resolved once per process by Nest. */
  get<T>(type: Type<T>): T;
  prisma: PrismaService;
};

/** What the person sees before they approve an important action. */
export type McpPreview = {
  /** Plain words: what will happen, to whom, how many, what it costs. Shown to the person verbatim. */
  summary: string;
  /** The facts behind the summary (counts, names, ids). */
  details?: Record<string, unknown>;
  /** Arguments to store instead of the ones given (e.g. names resolved to ids); validated by `input` again. */
  args?: unknown;
};

export type McpAnnotations = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

type ToolBase<S extends z.ZodObject> = {
  /** snake_case, unique across every tool file. */
  name: string;
  /** Short human title (shown by clients). */
  title: string;
  /** What it does and when to use it, written for the model. Mention units, limits and what ids come from. */
  description: string;
  /** The arguments, as a Zod object. Converted to JSON Schema for the client and enforced before the handler runs. */
  input: S;
  /** Optional result schema: the handler then returns an object of that shape, sent as structuredContent too. Ignored for important tools. */
  output?: z.ZodObject;
  /** Workspace permission(s) needed — any one of them, like @Permission(). null = any member. */
  permission: string | readonly string[] | null;
  /** True when calling twice with the same arguments changes nothing more. Defaults to true for reads. */
  idempotent?: boolean;
  /** Overrides for the MCP tool annotations the framework derives from `risk`. */
  annotations?: McpAnnotations;
};

export type McpToolDef<S extends z.ZodObject> =
  | (ToolBase<S> & {
      risk: "read" | "write";
      handler: (ctx: McpCtx, args: z.output<S>, deps: McpDeps) => Promise<unknown>;
    })
  | (ToolBase<S> & {
      risk: "important";
      /** Validates and describes the action without doing it. Throw an ApiError when it could not go ahead. */
      preview: (ctx: McpCtx, args: z.output<S>, deps: McpDeps) => Promise<McpPreview>;
      /** Does it — only ever from confirm_action, with the stored arguments, re-validated. */
      handler: (ctx: McpCtx, args: z.output<S>, deps: McpDeps) => Promise<unknown>;
    });

/** A registered tool, its argument types erased (the framework parses `input` before every call). */
export type McpTool = ToolBase<z.ZodObject> & {
  risk: McpRisk;
  handler: (ctx: McpCtx, args: unknown, deps: McpDeps) => Promise<unknown>;
  preview?: (ctx: McpCtx, args: unknown, deps: McpDeps) => Promise<McpPreview>;
};

export function defineTool<S extends z.ZodObject>(def: McpToolDef<S>): McpTool {
  return def as unknown as McpTool;
}

/* ─── Results ─────────────────────────────────────────────────────────────── */

const REPLY = Symbol("mcp.reply");

/** An explicit tool result: the text the model reads, and optional structured data. */
export type McpReply = { [REPLY]: true; text: string; data?: Record<string, unknown> };

/**
 * Handlers may return any JSON-able value (sent as pretty-printed JSON) or
 * reply(text, data) to choose the words. Keep results small: the model pays
 * for every character. Lists go through pageInput/paged.
 */
export const reply = (text: string, data?: Record<string, unknown>): McpReply => ({ [REPLY]: true, text, data });
export const isReply = (v: unknown): v is McpReply => typeof v === "object" && v !== null && REPLY in v;

/* ─── Pagination ──────────────────────────────────────────────────────────── */

/** The largest page any tool returns. */
export const MCP_MAX_PAGE = 50;

/** Spread into a tool's input: `input: z.object({ search: z.string().optional(), ...pageInput })`. */
export const pageInput = {
  page: z.number().int().min(1).default(1).describe("Page number, from 1."),
  limit: z.number().int().min(1).max(MCP_MAX_PAGE).default(20).describe(`Items per page (at most ${MCP_MAX_PAGE}).`),
};

/** A page of results with what the model needs to ask for the next one. */
export function paged<T>(items: T[], total: number, page: number, limit: number) {
  const hasMore = page * limit < total;
  return { items, total, page, limit, hasMore, ...(hasMore ? { nextPage: page + 1 } : {}) };
}

/* ─── Prompts and resources ───────────────────────────────────────────────── */

/** A reusable prompt the client can offer (e.g. a slash command in Claude Code). */
export type McpPrompt = {
  name: string;
  title: string;
  description: string;
  arguments?: { name: string; description: string; required?: boolean }[];
  /** The user message the prompt expands to. */
  render: (args: Record<string, string>, ctx: McpCtx) => string | Promise<string>;
};

export const definePrompt = (p: McpPrompt): McpPrompt => p;

/** A read-only document the client can attach (`growthdesk://…`). */
export type McpResource = {
  uri: string;
  name: string;
  title?: string;
  description: string;
  mimeType: string;
  read: (ctx: McpCtx, deps: McpDeps) => string | Promise<string>;
};

export const defineResource = (r: McpResource): McpResource => r;
