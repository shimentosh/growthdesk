import { AsyncLocalStorage } from "node:async_hooks";
import type { NextFunction, Request, Response } from "express";
import type { RequestContext } from "./context.js";

/*
 * Who is acting — on every timeline entry and audit record, so a team can
 * always tell a person's work from an AI agent's, a workflow's, an
 * integration's or the system's.
 *
 *   user         a teammate, signed in
 *   ai_agent     an AI acting for a teammate (an MCP client such as Claude, a voice agent)
 *   workflow     an automation workflow run
 *   integration  an API key (e.g. "Clientdesk", "Business OS")
 *   system       Growthdesk itself: sequences, syncs, webhooks, scheduled jobs
 *
 * The actor is read from an AsyncLocalStorage scope rather than passed
 * around: a request opens the scope (actorScope middleware) and the actor is
 * worked out from its RequestContext when first needed — the guard (session,
 * API key) or MCP authentication fills req.ctx before any handler runs. Code
 * outside a request (the workflow executor, voice agents, jobs) declares
 * itself with runAs(). With no scope at all, the actor is "system".
 */

export const ACTOR_TYPES = ["user", "ai_agent", "workflow", "integration", "system"] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export type Actor = {
  type: ActorType;
  /** The user id (user), token/agent id (ai_agent), workflow id, API key id; null for system. */
  id?: string | null;
  /** A display name kept with the record, so it still reads right after a rename or removal. */
  name?: string;
  /** Extra provenance, e.g. "workflow:<id>:run:<runId>", "mcp:<tokenId>". */
  ref?: string;
  /** The teammate an AI agent (or an approved workflow run) acted for. */
  onBehalfOf?: { id: string; name?: string } | null;
};

type Holder = { actor: Actor | null; req: Request | null };
const store = new AsyncLocalStorage<Holder>();

/** From a request's context: MCP → ai_agent, API key → integration, signed in → user. */
export function actorFromContext(ctx: RequestContext | null | undefined): Actor | null {
  if (!ctx) return null;
  const mcp = (ctx as RequestContext & { mcp?: { tokenId: string; tokenName: string; clientName: string | null } }).mcp;
  if (mcp) {
    return {
      type: "ai_agent",
      id: mcp.tokenId,
      name: mcp.clientName || mcp.tokenName || "AI agent",
      ref: `mcp:${mcp.tokenId}`,
      onBehalfOf: ctx.identity ? { id: ctx.identity.userId, name: ctx.identity.name } : null,
    };
  }
  if (ctx.apiKey) return { type: "integration", id: ctx.apiKey.id, name: ctx.apiKey.name, ref: `api_key:${ctx.apiKey.id}` };
  if (ctx.identity) return { type: "user", id: ctx.identity.userId, name: ctx.identity.name };
  return null;
}

/** The actor for the current async scope, or null outside any (callers treat that as system). */
export function currentActor(): Actor | null {
  const h = store.getStore();
  if (!h) return null;
  if (h.actor) return h.actor;
  return actorFromContext((h.req as (Request & { ctx?: RequestContext }) | null)?.ctx);
}

/** Runs `fn` as `actor` (and everything it awaits). */
export function runAs<T>(actor: Actor, fn: () => T): T {
  return store.run({ actor, req: null }, fn);
}

/** Pins the actor for the rest of the current scope (e.g. once a request learns who it is acting for). */
export function setActor(actor: Actor): void {
  const h = store.getStore();
  if (h) h.actor = actor;
}

/** Express middleware: one actor scope per request, resolved lazily from req.ctx. */
export function actorScope(req: Request, _res: Response, next: NextFunction) {
  store.run({ actor: null, req }, next);
}
