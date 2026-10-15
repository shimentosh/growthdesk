import { Controller, Delete, Get, HttpCode, Param, Patch, Post, Query as Q, Req as R, Res } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { Response } from "express";
import type { z } from "zod";
import { WebWidgetInput, WebWidgetPatch, WidgetMessageInput, WidgetVisitorInput } from "@growthdesk/shared";
import { Body, Ctx, Permission, Public, Raw } from "../common/decorators.js";
import type { Req, RequestContext } from "../common/context.js";
import { RealtimeService } from "../realtime/realtime.service.js";
import { LiveChatService, type WidgetCaller } from "./livechat.service.js";

/** Website chat widgets, under Settings → Live chat. */
@ApiTags("livechat")
@Controller("workspaces/:workspaceId/livechat/widgets")
export class LiveChatWidgetsController {
  constructor(private readonly livechat: LiveChatService) {}

  @Permission("integrations.read")
  @Get()
  list(@Ctx() ctx: RequestContext) {
    return this.livechat.listWidgets(ctx);
  }

  @Permission("integrations.manage")
  @Post()
  create(@Ctx() ctx: RequestContext, @Body(WebWidgetInput) body: z.infer<typeof WebWidgetInput>) {
    return this.livechat.createWidget(ctx, body);
  }

  @Permission("integrations.manage")
  @Patch(":id")
  update(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(WebWidgetPatch) body: z.infer<typeof WebWidgetPatch>) {
    return this.livechat.updateWidget(ctx, id, body);
  }

  @Permission("integrations.manage")
  @Delete(":id")
  remove(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.livechat.removeWidget(ctx, id);
  }
}

/** Per IP: enough for a person typing fast, not for a script flooding an inbox. */
const MESSAGE_LIMIT = { default: { limit: 30, ttl: 60_000 } };
const SESSION_LIMIT = { default: { limit: 20, ttl: 60_000 } };

const header = (req: Req, name: string) => {
  const v = req.headers[name];
  return (Array.isArray(v) ? v[0] : v) ?? null;
};

/*
 * The widget's own API: public, keyed by the widget's public key, the visitor
 * proven by the token the widget holds (X-GD-Visitor; ?token= on the stream,
 * which EventSource cannot set headers for). X-GD-Host is the site the widget
 * is embedded on, checked against the widget's allowed domains.
 * Reached as /api/widget/... from /chat/<key>, a page of this app.
 */
@ApiTags("livechat")
@Public()
@Controller("widget/:key")
export class WidgetPublicController {
  constructor(
    private readonly livechat: LiveChatService,
    private readonly realtime: RealtimeService,
  ) {}

  private caller(key: string, req: Req, query: { token?: unknown; host?: unknown } = {}): WidgetCaller {
    return {
      key,
      token: header(req, "x-gd-visitor") ?? (typeof query.token === "string" ? query.token : null),
      host: header(req, "x-gd-host") ?? (typeof query.host === "string" ? query.host : null),
      ip: req.ctx.ip,
      userAgent: req.ctx.userAgent,
    };
  }

  @Get("config")
  config(@Param("key") key: string, @R() req: Req, @Q("preview") preview?: string) {
    return this.livechat.publicConfig(this.caller(key, req), preview === "1");
  }

  @Throttle(SESSION_LIMIT)
  @HttpCode(200)
  @Post("session")
  session(@Param("key") key: string, @R() req: Req, @Body(WidgetVisitorInput) body: z.infer<typeof WidgetVisitorInput>) {
    return this.livechat.session(this.caller(key, req), body);
  }

  @Throttle(SESSION_LIMIT)
  @Patch("visitor")
  visitor(@Param("key") key: string, @R() req: Req, @Body(WidgetVisitorInput) body: z.infer<typeof WidgetVisitorInput>) {
    return this.livechat.updateVisitor(this.caller(key, req), body);
  }

  @Get("messages")
  messages(@Param("key") key: string, @R() req: Req) {
    return this.livechat.messages(this.caller(key, req));
  }

  @Throttle(MESSAGE_LIMIT)
  @Post("messages")
  send(@Param("key") key: string, @R() req: Req, @Body(WidgetMessageInput) body: z.infer<typeof WidgetMessageInput>) {
    return this.livechat.visitorMessage(this.caller(key, req), body);
  }

  @Raw()
  @Get("stream")
  async stream(@Param("key") key: string, @R() req: Req, @Res() res: Response, @Q("token") token?: string, @Q("host") host?: string) {
    let topics: string[];
    try {
      topics = await this.livechat.streamTopics(this.caller(key, req, { token, host }));
    } catch {
      // EventSource cannot read an error body; a 204 tells it to stop reconnecting.
      res.status(204).end();
      return;
    }
    this.realtime.stream(res, topics);
  }
}
