import { createParamDecorator, type ExecutionContext, SetMetadata } from "@nestjs/common";
import type { PlatformRole } from "@growthdesk/shared";
import type { z } from "zod";
import { badRequest } from "./errors.js";
import type { Req, RequestContext } from "./context.js";

export const IS_PUBLIC = "gd:public";
export const IS_RAW = "gd:raw";
export const NEEDS_PERMISSION = "gd:permission";
export const NEEDS_PLATFORM = "gd:platform";
export const API_KEY_SCOPE = "gd:api-key-scope";
export const ALLOW_UNVERIFIED = "gd:allow-unverified";
export const ALLOW_SUSPENDED = "gd:allow-suspended";

/** No sign-in required. The guard still resolves a session if one is present. */
export const Public = () => SetMetadata(IS_PUBLIC, true);
/** The handler writes its own response; no `{ data }` envelope. */
export const Raw = () => SetMetadata(IS_RAW, true);
/** Requires any one of these workspace permissions (route must have :workspaceId). */
export const Permission = (...permissions: string[]) => SetMetadata(NEEDS_PERMISSION, permissions);
/** Platform administration. Ranks: support < admin < owner. */
export const Platform = (min: Exclude<PlatformRole, "none"> = "support") => SetMetadata(NEEDS_PLATFORM, min);
/** May be called with `Authorization: Bearer <api key>` holding this scope. */
export const ApiKeyScope = (scope: string) => SetMetadata(API_KEY_SCOPE, scope);
/** Reachable before the account's email address is verified. */
export const AllowUnverified = () => SetMetadata(ALLOW_UNVERIFIED, true);
/** Reachable while the workspace is suspended (billing, export, workspace profile). */
export const AllowSuspended = () => SetMetadata(ALLOW_SUSPENDED, true);

export const Ctx = createParamDecorator((_: unknown, context: ExecutionContext): RequestContext => {
  return context.switchToHttp().getRequest<Req>().ctx;
});

function parseWith<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const fields: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const key = issue.path.join(".") || "_";
    fields[key] ??= issue.message;
  }
  const first = Object.entries(fields)[0];
  throw badRequest(first ? (first[0] === "_" ? first[1] : `${first[0]}: ${first[1]}`) : "Invalid request", fields);
}

/*
 * The schema is wrapped before it reaches Nest. Passed bare, Nest treats it as
 * a pipe (Zod schemas have a `transform` method); wrapped as `{ schema }`,
 * Nest 12 reads it as its own parameter-options object. `{ zod }` is neither.
 */
const BodyParam = createParamDecorator((data: { zod: z.ZodTypeAny }, context: ExecutionContext) => {
  const req = context.switchToHttp().getRequest<Req>();
  return parseWith(data.zod, req.body ?? {});
});
const QueryParam = createParamDecorator((data: { zod: z.ZodTypeAny }, context: ExecutionContext) => {
  const req = context.switchToHttp().getRequest<Req>();
  return parseWith(data.zod, req.query ?? {});
});

/** A JSON body validated by a Zod schema (one of the shared schemas). */
export const Body = (schema: z.ZodTypeAny) => BodyParam({ zod: schema });

/** Query parameters validated by a Zod schema. */
export const Query = (schema: z.ZodTypeAny) => QueryParam({ zod: schema });

export { parseWith };
