import { Logger, RequestMethod } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { assignRequestId, requestLogScope } from "./common/logger.js";
import { actorScope } from "./common/actor.js";
import { mcpCors } from "./mcp/mcp-cors.js";

/** Shared by main.ts and the e2e tests so both run the same HTTP stack. */
export function configureApp(app: NestExpressApplication) {
  app.disable("x-powered-by");
  // x-request-id first, so every answer carries one (common/logger.ts).
  app.use(assignRequestId);
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false, hsts: process.env.NODE_ENV === "production" }));
  app.use(cookieParser());
  // MCP clients call /mcp from anywhere with a bearer token (src/mcp); only that path answers cross-origin.
  app.use("/mcp", mcpCors);
  // So do the OAuth endpoints MCP clients discover and call (src/mcp/oauth) — never with cookies.
  // /oauth/authorize is a browser navigation and needs no CORS.
  app.use(["/.well-known/oauth-protected-resource", "/.well-known/oauth-authorization-server", "/oauth/register", "/oauth/token", "/oauth/revoke"], mcpCors);
  // CSV imports arrive as JSON text; 20 MB covers the 15 MB file limit.
  app.useBodyParser("json", { limit: "20mb" });
  app.useBodyParser("urlencoded", { extended: false, limit: "1mb" });
  // Amazon SNS posts bounce/complaint notifications as text/plain JSON (marketing webhooks).
  app.useBodyParser("text", { type: "text/plain", limit: "256kb" });
  // After the body parsers: from here on every log line carries the request id.
  app.use(requestLogScope(new Logger("http")));
  // Who is acting (person, AI agent, integration) for every timeline entry and audit record; opened after body parsing for the same reason.
  app.use(actorScope);
  // MCP clients expect the endpoint at a plain /mcp (the web app proxies /api/mcp to it), and OAuth
  // discovery and endpoints at /.well-known/* and /oauth/* on the issuer (src/mcp/oauth).
  app.setGlobalPrefix("v1", {
    exclude: [
      { path: "mcp", method: RequestMethod.ALL },
      { path: ".well-known/{*rest}", method: RequestMethod.ALL },
      { path: "oauth/{*rest}", method: RequestMethod.ALL },
    ],
  });
  app.enableShutdownHooks();

  const doc = new DocumentBuilder()
    .setTitle("Growthdesk API")
    .setDescription(
      "REST API for Growthdesk. Browser sessions use the gd_session cookie; integrations (e.g. Business OS) use `Authorization: Bearer gd_…` API keys created under Workspace Settings → API keys. Every response is `{ data }` or `{ error: { code, message, fields?, details? } }`.",
    )
    .setVersion("1.0")
    .addBearerAuth({ type: "http", scheme: "bearer", description: "Workspace API key (gd_…)" })
    .addCookieAuth("gd_session")
    .build();
  const document = SwaggerModule.createDocument(app, doc);
  // The OpenAPI JSON is the published contract (docs/BUSINESS_OS_API.md); the interactive UI is for development only.
  SwaggerModule.setup("v1/docs", app, document, { jsonDocumentUrl: "v1/docs.json", ui: process.env.NODE_ENV !== "production", raw: ["json"] });
  return app;
}
