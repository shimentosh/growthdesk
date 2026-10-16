import { Controller, Delete, Get, Post, Req, Res } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import type { Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Public, Raw } from "../common/decorators.js";
import { isApiError } from "../common/errors.js";
import type { Req as AppReq } from "../common/context.js";
import { McpAuthService } from "./mcp-auth.service.js";
import { McpRuntime } from "./mcp-runtime.service.js";

/*
 * The MCP endpoint: POST /mcp, outside the /v1 prefix (app.setup.ts), and
 * /api/mcp through the web app's proxy. Streamable HTTP in stateless mode: a
 * new server and transport per POST, no session id, JSON responses — so any
 * API instance can answer any request, and nothing is kept between them.
 *
 * @Public() to the global AccessGuard, which then only sets req.ctx;
 * McpAuthService does bearer authentication itself. @Raw(): the transport
 * writes the response.
 */
@ApiExcludeController()
@Public()
@Raw()
@Controller("mcp")
export class McpController {
  constructor(
    private readonly auth: McpAuthService,
    private readonly runtime: McpRuntime,
  ) {}

  @Post()
  async post(@Req() req: AppReq, @Res() res: Response) {
    let ctx;
    try {
      ctx = await this.auth.authenticate(req);
    } catch (e) {
      if (isApiError(e) && e.status === 401) res.setHeader("WWW-Authenticate", this.auth.challenge(req, Boolean(req.headers.authorization)));
      throw e;
    }
    const server = this.runtime.server(ctx);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }

  /** Stateless: no SSE stream to open (GET) and no session to end (DELETE). The spec's answer is 405. */
  @Get()
  get(@Res() res: Response) {
    methodNotAllowed(res);
  }

  @Delete()
  delete(@Res() res: Response) {
    methodNotAllowed(res);
  }
}

function methodNotAllowed(res: Response) {
  res
    .status(405)
    .setHeader("Allow", "POST, OPTIONS")
    .json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: this MCP server is stateless — send JSON-RPC requests with POST." }, id: null });
}
