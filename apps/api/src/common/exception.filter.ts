import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { ApiError, isApiError } from "./errors.js";
import { TenantScopeError } from "../prisma/tenant-guard.js";
import { reportError } from "./sentry.js";

/*
 * Turns anything a handler threw into `{ error: { code, message, fields?, details? } }`.
 * Ported from LinkDesk's ApiExceptionFilter: an ApiError is something we
 * meant; everything else is a bug, logged in full on the server while the
 * client is told only that it failed — no stack traces or constraint names.
 */

const CODES: Record<number, string> = {
  400: "bad_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  405: "method_not_allowed",
  409: "conflict",
  413: "payload_too_large",
  415: "unsupported_media_type",
  422: "unprocessable",
  429: "too_many_requests",
};

/** body-parser's error types look like "entity.parse.failed"; other libraries' `type` (Stripe's "StripeAuthenticationError") must not match. */
const BODY_PARSER_TYPE = /^[a-z]+(\.[a-z]+)+$/;

function fromBodyParser(thrown: unknown): ApiError | null {
  const err = thrown as { type?: string; status?: number; statusCode?: number };
  if (!err || typeof err !== "object" || typeof err.type !== "string" || !BODY_PARSER_TYPE.test(err.type)) return null;
  if (err.type === "entity.too.large") return new ApiError(413, "payload_too_large", "That request is too large");
  if (err.type === "entity.parse.failed") return new ApiError(400, "bad_request", "The request body is not valid JSON");
  const status = err.status ?? err.statusCode;
  if (status && status >= 400 && status < 500) {
    return new ApiError(status, CODES[status] ?? "bad_request", "That request could not be read");
  }
  return null;
}

function fromHttpException(thrown: HttpException): ApiError {
  const status = thrown.getStatus();
  const payload = thrown.getResponse();
  const raw = typeof payload === "string" ? payload : ((payload as { message?: unknown }).message ?? thrown.message);
  const message = Array.isArray(raw) ? raw.join(", ") : String(raw);
  return new ApiError(status, CODES[status] ?? "error", message);
}

/**
 * An error from a payment provider's API (Stripe's errors carry type "Stripe…Error").
 * Whatever its own status, it is our upstream failing, never the caller's request:
 * a provider 401 (rotated key) must not tell the browser it is signed out, and a
 * webhook that could not re-read the subscription must answer 5xx so the provider retries.
 */
function fromUpstream(thrown: unknown): ApiError | null {
  const err = thrown as { type?: string };
  if (!err || typeof err !== "object" || typeof err.type !== "string" || !/^Stripe[A-Za-z]*Error$/.test(err.type)) return null;
  return new ApiError(502, "upstream_error", "The payment provider could not complete that request. Try again in a few minutes.");
}

/** Prisma's known request errors, by code, without leaking table or constraint names. */
function fromPrisma(thrown: unknown): ApiError | null {
  const err = thrown as { code?: string; name?: string };
  if (!err || typeof err.code !== "string" || !/^P\d{4}$/.test(err.code)) return null;
  switch (err.code) {
    case "P2002":
      return new ApiError(409, "conflict", "A record with those details already exists");
    case "P2025":
    case "P2001":
      return new ApiError(404, "not_found", "That record does not exist, or is not in this workspace");
    case "P2003":
      return new ApiError(409, "conflict", "That record is still referenced by something else");
    default:
      return null;
  }
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly log = new Logger("api");

  catch(thrown: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const error = this.translate(thrown, request);

    if (!isApiError(thrown) && !(thrown instanceof HttpException) && error.status >= 500) {
      // Includes upstream (payment provider) failures: logged in full here, generic for the client.
      // The request id is on the line (and echoed to the client), so a support report finds it.
      const requestId = String(request.headers?.["x-request-id"] ?? "");
      this.log.error(`unhandled on ${request.method} ${request.path} [request ${requestId}]`, thrown instanceof Error ? thrown.stack : String(thrown));
      reportError(thrown, { requestId, tags: { method: request.method, route: request.route?.path ?? request.path } });
    }

    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("cache-control", "no-store");
    response.status(error.status).json({
      error: {
        code: error.code,
        message: error.message,
        ...(error.fields ? { fields: error.fields } : {}),
        ...(error.details ? { details: error.details } : {}),
      },
    });
  }

  private translate(thrown: unknown, request: Request): ApiError {
    if (isApiError(thrown)) return thrown;
    const parsed = fromBodyParser(thrown);
    if (parsed) return parsed;
    const upstream = fromUpstream(thrown);
    if (upstream) return upstream;
    if (thrown instanceof NotFoundException) {
      return new ApiError(404, "not_found", `Nothing answers ${request.method} ${request.path}`);
    }
    if (thrown instanceof HttpException) return fromHttpException(thrown);
    if (thrown instanceof TenantScopeError) return new ApiError(500, "server_error", "Something went wrong");
    const prisma = fromPrisma(thrown);
    if (prisma) return prisma;
    return new ApiError(500, "server_error", "Something went wrong");
  }
}
