import "reflect-metadata";
import "dotenv/config";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { WorkerModule } from "./worker/worker.module.js";

/*
 * The background worker process: BullMQ processors and recurring schedules
 * (sequence engine ticks, mailbox sync, event dispatch, reminders, billing
 * upkeep). Run one or more alongside the API. Shutdown waits for in-flight
 * jobs (Nest shutdown hooks close the BullMQ workers gracefully).
 */
async function bootstrap() {
  process.env.RUN_WORKERS = "true";
  const app = await NestFactory.createApplicationContext(WorkerModule, { logger: ["log", "warn", "error"] });
  app.enableShutdownHooks();
  new Logger("worker").log("worker started");
}

await bootstrap();
