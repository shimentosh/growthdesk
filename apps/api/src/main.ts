import "reflect-metadata";
import "dotenv/config";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module.js";
import { configureApp } from "./app.setup.js";
import { loadConfig } from "./config/config.js";

async function bootstrap() {
  const config = loadConfig();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    logger: config.LOG_LEVEL === "debug" ? ["debug", "log", "warn", "error"] : config.LOG_LEVEL === "log" ? ["log", "warn", "error"] : config.LOG_LEVEL === "warn" ? ["warn", "error"] : ["error"],
  });
  configureApp(app);
  // The API binds to loopback by default: browsers reach it through the web app's /api proxy.
  await app.listen(config.API_PORT, config.API_HOST);
  new Logger("api").log(`listening on http://${config.API_HOST}:${config.API_PORT}/v1 (docs at /v1/docs)`);
}

await bootstrap();
