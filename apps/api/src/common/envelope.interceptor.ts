import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Response } from "express";
import { map, type Observable } from "rxjs";
import { IS_RAW } from "./decorators.js";

/*
 * Every successful JSON answer is `{ data }` — ported from LinkDesk's
 * EnvelopeInterceptor. Handlers marked @Raw() (tracking pixels, redirects,
 * CSV downloads, provider webhook handshakes) write their own response.
 */
@Injectable()
export class EnvelopeInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== "http") return next.handle();
    const response = context.switchToHttp().getResponse<Response>();
    const raw = this.reflector.getAllAndOverride<boolean>(IS_RAW, [context.getHandler(), context.getClass()]);
    if (!raw) {
      response.setHeader("x-content-type-options", "nosniff");
      response.setHeader("cache-control", "no-store");
    }
    return next.handle().pipe(
      map((data) => {
        if (raw) return data;
        if (response.statusCode === 204 || data === undefined) return undefined;
        return { data };
      }),
    );
  }
}
