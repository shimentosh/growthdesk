import { Controller, Delete, Get, HttpCode, Param, Patch, Post, Req as R, Res } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import type { z } from "zod";
import {
  CallListQuery,
  CallLogInput,
  CallQueueAddInput,
  CallQueueQuery,
  CallScriptInput,
  CallUpdateInput,
  ClickToCallInput,
  TwilioConnectInput,
  patchOf,
} from "@growthdesk/shared";
import { Body, Ctx, Permission, Public, Query, Raw } from "../common/decorators.js";
import type { Req, RequestContext } from "../common/context.js";
import { CallsService } from "./calls.service.js";
import { TwilioCallsService } from "./twilio-calls.service.js";

@ApiTags("calls")
@Controller("workspaces/:workspaceId/calls")
export class CallsController {
  constructor(
    private readonly calls: CallsService,
    private readonly twilio: TwilioCallsService,
  ) {}

  /** Call history, newest first. Without records.view_all: the caller's own calls. */
  @Permission("calls.read")
  @Get()
  list(@Ctx() ctx: RequestContext, @Query(CallListQuery) q: z.infer<typeof CallListQuery>) {
    return this.calls.list(ctx, q);
  }

  /** Connected Twilio accounts and whether click-to-call can work here (else the UI offers manual logging only). */
  @Permission("calls.read")
  @Get("setup")
  setup(@Ctx() ctx: RequestContext) {
    return this.twilio.setup(ctx);
  }

  /** Log a call made outside Growthdesk (from the rep's own phone). */
  @Permission("calls.make")
  @Post()
  log(@Ctx() ctx: RequestContext, @Body(CallLogInput) body: z.infer<typeof CallLogInput>) {
    return this.calls.log(ctx, body);
  }

  /** Connect a Twilio account (checked with Twilio before it is stored). Verify / disconnect: POST /channels/:id/verify, DELETE /channels/:id. */
  @Permission("integrations.manage")
  @Post("twilio")
  connectTwilio(@Ctx() ctx: RequestContext, @Body(TwilioConnectInput) body: z.infer<typeof TwilioConnectInput>) {
    return this.twilio.connect(ctx, body);
  }

  /** Click-to-call: Twilio rings the caller's phone, then connects them to the contact. */
  @Permission("calls.make")
  @Post("dial")
  dial(@Ctx() ctx: RequestContext, @Body(ClickToCallInput) body: z.infer<typeof ClickToCallInput>) {
    return this.twilio.dial(ctx, body);
  }

  /** The call list: open call tasks, with whether each contact can be called now. */
  @Permission("calls.read")
  @Get("queue")
  queue(@Ctx() ctx: RequestContext, @Query(CallQueueQuery) q: z.infer<typeof CallQueueQuery>) {
    return this.calls.queue(ctx, q);
  }

  @Permission("calls.make")
  @Post("queue")
  addToQueue(@Ctx() ctx: RequestContext, @Body(CallQueueAddInput) body: z.infer<typeof CallQueueAddInput>) {
    return this.calls.addToQueue(ctx, body);
  }

  @Permission("calls.make")
  @Delete("queue/:taskId")
  removeFromQueue(@Ctx() ctx: RequestContext, @Param("taskId") taskId: string) {
    return this.calls.removeFromQueue(ctx, taskId);
  }

  @Permission("calls.read")
  @Get(":id")
  get(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.calls.get(ctx, id);
  }

  @Permission("calls.make")
  @Patch(":id")
  update(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(CallUpdateInput) body: z.infer<typeof CallUpdateInput>) {
    return this.calls.update(ctx, id, body);
  }
}

@ApiTags("calls")
@Controller("workspaces/:workspaceId/call-scripts")
export class CallScriptsController {
  constructor(private readonly calls: CallsService) {}

  @Permission("calls.read")
  @Get()
  list(@Ctx() ctx: RequestContext) {
    return this.calls.listScripts(ctx);
  }

  @Permission("calls.make")
  @Post()
  create(@Ctx() ctx: RequestContext, @Body(CallScriptInput) body: z.infer<typeof CallScriptInput>) {
    return this.calls.createScript(ctx, body);
  }

  @Permission("calls.make")
  @Patch(":id")
  update(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(patchOf(CallScriptInput)) body: Partial<z.infer<typeof CallScriptInput>>) {
    return this.calls.updateScript(ctx, id, body);
  }

  @Permission("calls.make")
  @Delete(":id")
  remove(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.calls.removeScript(ctx, id);
  }
}

/*
 * Twilio's callbacks. Public (no session): each request is authenticated by
 * X-Twilio-Signature with the account's auth token and routed by the
 * integration's random webhook key. Twilio posts form-encoded parameters,
 * which the API's urlencoded body parser turns into req.body. Reached as
 * ${PUBLIC_APP_URL}/api/webhooks/twilio/... through the web app's /api → /v1 proxy.
 */
@ApiTags("webhooks")
@Controller("webhooks/twilio/:webhookKey")
export class TwilioWebhooksController {
  constructor(private readonly twilio: TwilioCallsService) {}

  private static parts(req: Req) {
    const sig = req.headers["x-twilio-signature"];
    const call = req.query.call;
    return {
      callId: typeof call === "string" ? call : "",
      params: (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>,
      signature: Array.isArray(sig) ? sig[0] : sig,
    };
  }

  @Public()
  @Raw()
  @Post("twiml")
  async twiml(@Param("webhookKey") key: string, @R() req: Req, @Res() res: Response) {
    const p = TwilioWebhooksController.parts(req);
    res.status(200).type("text/xml").send(await this.twilio.twiml(key, p.callId, p.params, p.signature));
  }

  @Public()
  @Raw()
  @Post("dial")
  async dial(@Param("webhookKey") key: string, @R() req: Req, @Res() res: Response) {
    const p = TwilioWebhooksController.parts(req);
    res.status(200).type("text/xml").send(await this.twilio.dialEnded(key, p.callId, p.params, p.signature));
  }

  @Public()
  @HttpCode(200)
  @Post("status")
  status(@Param("webhookKey") key: string, @R() req: Req) {
    const p = TwilioWebhooksController.parts(req);
    return this.twilio.statusChanged(key, p.callId, p.params, p.signature);
  }
}
