import "reflect-metadata";
import "dotenv/config";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { WorkerModule } from "./worker/worker.module.js";
import { loadConfig } from "./config/config.js";
import { createLogger } from "./common/logger.js";
import { flushSentry, initSentry } from "./common/sentry.js";

/*
 * The background worker process: BullMQ processors and recurring schedules
 * (sequence engine ticks, mailbox sync, event dispatch, reminders, billing
 * upkeep). Run one or more alongside the API. Shutdown waits for in-flight
 * jobs (Nest shutdown hooks close the BullMQ workers gracefully).
 */
async function bootstrap() {
  process.env.RUN_WORKERS = "true";
  const config = loadConfig();
  await initSentry(config, "worker");
  const app = await NestFactory.createApplicationContext(WorkerModule, { logger: createLogger(config, "worker") });
  app.enableShutdownHooks();
  process.once("beforeExit", () => void flushSentry());
  new Logger("worker").log("worker started");
}

await bootstrap();
