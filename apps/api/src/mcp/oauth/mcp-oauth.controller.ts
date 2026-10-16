import { Controller, Get, HttpCode, Logger, Post, Req, Res } from "@nestjs/common";
import { ApiExcludeController, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { Response } from "express";
import { z } from "zod";
import { MCP_ACCESS_LEVELS } from "@growthdesk/shared";
import { Body, Ctx, Public, Query, Raw } from "../../common/decorators.js";
import type { Req as AppReq, RequestContext } from "../../common/context.js";
import { reportError } from "../../common/sentry.js";
import { McpOAuthService } from "./mcp-oauth.service.js";
import { OAuthError } from "./oauth.util.js";

/** Per client address. claude.ai calls from its own servers, so these leave room for many people connecting at once. */
const REGISTER_LIMIT = { default: { limit: Number(process.env.MCP_OAUTH_REGISTER_LIMIT ?? 30), ttl: 60_000 } };
const TOKEN_LIMIT = { default: { limit: Number(process.env.MCP_OAUTH_TOKEN_LIMIT ?? 300), ttl: 60_000 } };

type Params = Record<string, unknown>;
const params = (body: unknown): Params => (body && typeof body === "object" && !Array.isArray(body) ? (body as Params) : {});

/** client_id from HTTP Basic client authentication, should a client use it (the secret is ignored: clients are public). */
function basicClientId(req: AppReq): string | null {
  const h = req.headers.authorization;
  if (!h?.toLowerCase().startsWith("basic ")) return null;
  try {
    const decoded = Buffer.from(h.slice(6).trim(), "base64").toString("utf8");
    const id = decodeURIComponent(decoded.split(":")[0] ?? "");
    return id || null;
  } catch {
    return null;
  }
}

/*
 * The OAuth 2.1 endpoints for MCP clients (docs/MCP.md → "OAuth / claude.ai"),
 * on the API origin and outside the /v1 prefix (app.setup.ts), and reachable
 * as /api/.well-known/* and /api/oauth/* through the web app's proxy:
 *
 *   GET  /.well-known/oauth-protected-resource[/mcp]   RFC 9728
 *   GET  /.well-known/oauth-authorization-server[/…]   RFC 8414
 *   POST /oauth/register                               RFC 7591
 *   GET  /oauth/authorize    → the web app's /oauth/consent
 *   POST /oauth/token        authorization_code (PKCE) | refresh_token
 *   POST /oauth/revoke       RFC 7009
 *
 * @Public() (no session; cookies play no part), @Raw() (OAuth's own JSON
 * shapes, not the { data } envelope). CORS: app.setup.ts.
 */
@ApiExcludeController()
@Public()
@Raw()
@Controller()
export class McpOAuthController {
  private readonly log = new Logger("mcp-oauth");

  constructor(private readonly oauth: McpOAuthService) {}

  @Get([".well-known/oauth-protected-resource", ".well-known/oauth-protected-resource/*rest"])
  resourceMetadata(@Req() req: AppReq, @Res() res: Response) {
    const prefix = "/.well-known/oauth-protected-resource";
    const suffix = req.path.slice(req.path.indexOf(prefix) + prefix.length);
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json(this.oauth.resourceMetadata(suffix));
  }

  @Get([".well-known/oauth-authorization-server", ".well-known/oauth-authorization-server/*rest"])
  serverMetadata(@Res() res: Response) {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json(this.oauth.serverMetadata());
  }

  @Post("oauth/register")
  @Throttle(REGISTER_LIMIT)
  async register(@Req() req: AppReq, @Res() res: Response) {
    await this.answer(res, 201, () => this.oauth.register(params(req.body)));
  }

  @Get("oauth/authorize")
  async authorize(@Req() req: AppReq, @Res() res: Response) {
    const to = await this.oauth.authorize(params(req.query));
    res.setHeader("Cache-Control", "no-store");
    res.redirect(302, to);
  }

  @Post("oauth/token")
  @Throttle(TOKEN_LIMIT)
  async token(@Req() req: AppReq, @Res() res: Response) {
    await this.answer(res, 200, () => this.oauth.token(params(req.body), basicClientId(req)));
  }

  @Post("oauth/revoke")
  @Throttle(TOKEN_LIMIT)
  async revoke(@Req() req: AppReq, @Res() res: Response) {
    await this.answer(res, 200, async () => {
      await this.oauth.revoke(params(req.body), basicClientId(req), req.ctx);
      return {};
    });
  }

  /** Writes the result, or an RFC 6749 §5.2 error body. Never cached. */
  private async answer(res: Response, status: number, run: () => Promise<unknown>) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
    try {
      res.status(status).json(await run());
    } catch (e) {
      if (e instanceof OAuthError) {
        if (e.status === 401) res.setHeader("WWW-Authenticate", 'Basic realm="growthdesk"');
        res.status(e.status).json({ error: e.error, error_description: e.description });
        return;
      }
      this.log.error("OAuth endpoint failed", e instanceof Error ? e.stack : String(e));
      reportError(e);
      res.status(500).json({ error: "server_error", error_description: "Something went wrong" });
    }
  }
}

const ConsentQuery = z.object({ request: z.string().min(1).max(8000) });
const ConsentDecision = z.object({
  request: z.string().min(1).max(8000),
  approve: z.boolean(),
  workspaceId: z.string().uuid().nullable().optional(),
  access: z.enum(MCP_ACCESS_LEVELS).nullable().optional(),
});

/**
 * The consent page's API (apps/web/src/app/oauth/consent): /v1/mcp/oauth/consent,
 * signed-in session only, so the global AccessGuard's session and cross-site
 * write checks apply exactly as for any other form in the app.
 */
@ApiTags("mcp")
@Controller("mcp/oauth")
export class McpOAuthConsentController {
  constructor(private readonly oauth: McpOAuthService) {}

  @Get("consent")
  info(@Ctx() ctx: RequestContext, @Query(ConsentQuery) q: z.infer<typeof ConsentQuery>) {
    return this.oauth.consentInfo(ctx, q.request);
  }

  @Post("consent")
  @HttpCode(200)
  decide(@Ctx() ctx: RequestContext, @Body(ConsentDecision) body: z.infer<typeof ConsentDecision>) {
    return this.oauth.decide(ctx, body);
  }
}
