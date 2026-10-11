import type { NestExpressApplication } from "@nestjs/platform-express";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import cookieParser from "cookie-parser";
import helmet from "helmet";

/** Shared by main.ts and the e2e tests so both run the same HTTP stack. */
export function configureApp(app: NestExpressApplication) {
  app.disable("x-powered-by");
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false, hsts: process.env.NODE_ENV === "production" }));
  app.use(cookieParser());
  // CSV imports arrive as JSON text; 20 MB covers the 15 MB file limit.
  app.useBodyParser("json", { limit: "20mb" });
  app.useBodyParser("urlencoded", { extended: false, limit: "1mb" });
  // Amazon SNS posts bounce/complaint notifications as text/plain JSON (marketing webhooks).
  app.useBodyParser("text", { type: "text/plain", limit: "256kb" });
  app.setGlobalPrefix("v1");
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
  SwaggerModule.setup("v1/docs", app, document, { jsonDocumentUrl: "v1/docs.json" });
  return app;
}
