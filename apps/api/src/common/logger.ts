import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { ConsoleLogger, type LogLevel } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import type { AppConfig } from "../config/config.js";

/*
 * Process logging for the API and the worker (docs/GAP_PLAN.md 6.1).
 *
 * Production writes one JSON object per line (LOG_FORMAT=json, the default
 * when NODE_ENV=production) so a log shipper can index it; development keeps
 * Nest's coloured lines. Every line written while a request is being handled
 * carries that request's id, read from an AsyncLocalStorage scope that the
 * request-id middleware opens; no call site has to pass it.
 *
 * The request id comes from the caller's `x-request-id` header when it looks
 * like an id (a reverse proxy's $request_id, a client's correlation id), else
 * a fresh UUID. It is echoed on the response, so a user's bug report or a
 * proxy log line leads straight to the API's log lines.
 */

export type LogScope = { requestId?: string };

const scope = new AsyncLocalStorage<LogScope>();

/** The request id of the request being handled, if any. */
export const currentRequestId = (): string | undefined => scope.getStore()?.requestId;

/** Runs `fn` with log lines tagged by `requestId` (also used by tests). */
export const withRequestId = <T>(requestId: string, fn: () => T): T => scope.run({ requestId }, fn);

const REQUEST_ID = /^[A-Za-z0-9._:@-]{1,128}$/;

/** A caller-supplied id when it is safe to log and echo; otherwise a new one. */
export function requestIdFrom(header: string | string[] | undefined): string {
  const v = Array.isArray(header) ? header[0] : header;
  return v && REQUEST_ID.test(v) ? v : randomUUID();
}

/**
 * First middleware: settles the request id, puts it back on the request (the
 * access guard copies it into RequestContext) and on the response. It runs
 * before the body parsers so even a rejected body answers with an id.
 */
export function assignRequestId(req: Request, res: Response, next: NextFunction) {
  const id = requestIdFrom(req.headers["x-request-id"]);
  req.headers["x-request-id"] = id;
  res.setHeader("x-request-id", id);
  next();
}

/**
 * Opens the log scope. Registered after the body parsers: they resume from
 * socket events, which would drop an AsyncLocalStorage scope opened earlier.
 * Also writes one access line per finished request (not for /health, which
 * monitors call every few seconds).
 */
export function requestLogScope(log: { log: (msg: string, params: Record<string, unknown>) => void } | null) {
  return (req: Request, res: Response, next: NextFunction) => {
    const requestId = String(req.headers["x-request-id"] ?? "") || requestIdFrom(undefined);
    const started = process.hrtime.bigint();
    if (log && !/\/health(\/|$)/.test(req.path)) {
      res.on("finish", () => {
        const ms = Number((process.hrtime.bigint() - started) / 1_000_000n);
        withRequestId(requestId, () => log.log(`${req.method} ${req.path} ${res.statusCode} ${ms}ms`, { method: req.method, path: req.path, status: res.statusCode, ms }));
      });
    }
    scope.run({ requestId }, next);
  };
}

/** Nest's level list for LOG_LEVEL (each level includes the ones above it). */
export function logLevels(level: AppConfig["LOG_LEVEL"]): LogLevel[] {
  const order: LogLevel[] = ["fatal", "error", "warn", "log", "debug", "verbose"];
  return order.slice(0, order.indexOf(level === "debug" ? "verbose" : level) + 1);
}

type JsonLogOptions = { context: string; logLevel: LogLevel; writeStreamType?: "stdout" | "stderr"; errorStack?: unknown; params?: Record<string, unknown>; error?: Error };

/**
 * ConsoleLogger with the request id (and the process's service name, in JSON)
 * on every line. Structured params passed after the message
 * (`log.error("job failed", { queue, jobId })`) become top-level JSON fields.
 */
export class AppLogger extends ConsoleLogger {
  constructor(
    private readonly service: "api" | "worker",
    json: boolean,
    levels: LogLevel[],
  ) {
    super({ logLevels: levels, json, colors: !json, flattenParams: true });
  }

  protected override getJsonLogObject(message: unknown, options: JsonLogOptions) {
    const base = super.getJsonLogObject(message, options);
    const requestId = currentRequestId();
    return { time: new Date(base.timestamp).toISOString(), service: this.service, ...(requestId ? { requestId } : {}), ...base };
  }

  protected override formatContext(context: string): string {
    const base = super.formatContext(context);
    const requestId = currentRequestId();
    return requestId ? `${base}(${requestId}) ` : base;
  }
}

/** The process logger for main.ts / worker.ts. */
export function createLogger(config: Pick<AppConfig, "LOG_LEVEL" | "LOG_FORMAT" | "NODE_ENV">, service: "api" | "worker"): AppLogger {
  const json = (config.LOG_FORMAT ?? (config.NODE_ENV === "production" ? "json" : "pretty")) === "json";
  return new AppLogger(service, json, logLevels(config.LOG_LEVEL));
}
