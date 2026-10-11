/*
 * The failures an API call can have, as one type. Ported from LinkDesk
 * packages/domain/src/errors.ts, plus `limitReached` for plan limits, which
 * carries the numbers the upgrade prompt shows.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields?: Record<string, string>;
  readonly details?: Record<string, unknown>;

  constructor(status: number, code: string, message: string, fields?: Record<string, string>, details?: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.fields = fields;
    this.details = details;
  }
}

export const badRequest = (message: string, fields?: Record<string, string>) =>
  new ApiError(400, "bad_request", message, fields);

export const unauthorized = (message = "Sign in to continue") => new ApiError(401, "unauthorized", message);

export const forbidden = (message = "You do not have permission to do that") => new ApiError(403, "forbidden", message);

export const notFound = (what = "That record") =>
  new ApiError(404, "not_found", `${what} does not exist, or is not in this workspace`);

/** `details` carries ids the client can act on (e.g. the existing record's id) — not field errors. */
export const conflict = (message: string, fields?: Record<string, string>, details?: Record<string, unknown>) =>
  new ApiError(409, "conflict", message, fields, details);

export const locked = (message: string) => new ApiError(423, "locked", message);

export const tooMany = (message = "Too many attempts — wait a minute and try again") =>
  new ApiError(429, "too_many_requests", message);

export const serverError = (message = "Something went wrong") => new ApiError(500, "server_error", message);

export const unavailable = (message: string) => new ApiError(503, "unavailable", message);

/** A plan limit or entitlement refused the request. 402 so the UI can offer an upgrade. */
export const limitReached = (
  message: string,
  details: { limit?: string; feature?: string; used?: number; allowed?: number; plan?: string },
) => new ApiError(402, "plan_limit", message, undefined, details);

export const isApiError = (e: unknown): e is ApiError => e instanceof ApiError;
