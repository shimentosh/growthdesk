import { readFile } from "node:fs/promises";
import { Controller, Get, Logger, Module, Post } from "@nestjs/common";
import { Processor, WorkerHost } from "@nestjs/bullmq";
import type { Job } from "bullmq";
import { vi } from "vitest";
import { bootApp, wait, type TestApp } from "./helpers.js";
import { Public } from "../src/common/decorators.js";
import { currentRequestId } from "../src/common/logger.js";
import { Queues, QUEUES } from "../src/queues/queues.js";
import { WorkerOpsModule } from "../src/worker/worker-ops.module.js";
import { HEARTBEAT_FILE, WorkerHeartbeat } from "../src/worker/heartbeat.js";

/*
 * Production operations (docs/GAP_PLAN.md 6.1, 6.9): the x-request-id header
 * and its log scope, /health with the worker heartbeat, its rate limit, and
 * the generic failed-job listener running against real BullMQ workers.
 */

/** Test-only routes: what the log scope says the request id is, inside a handler. */
@Controller("ops-test")
class ProbeController {
  @Public()
  @Get("request-id")
  get() {
    return { requestId: currentRequestId() ?? null };
  }

  /** After the JSON body parser: the scope must survive its socket callbacks. */
  @Public()
  @Post("request-id")
  async post() {
    await wait(5);
    return { requestId: currentRequestId() ?? null };
  }
}

/** A processor that always fails, on a queue no other processor in this suite serves. */
@Processor(QUEUES.ai)
class ExplodingProcessor extends WorkerHost {
  override async process(job: Job): Promise<unknown> {
    throw new Error(`kaboom ${job.name}`);
  }
}

@Module({ controllers: [ProbeController], providers: [ExplodingProcessor] })
class ProbeModule {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("Production operations", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await bootApp([ProbeModule, WorkerOpsModule]);
  });
  afterAll(async () => t.close());

  describe("x-request-id", () => {
    it("generates an id when the caller sends none, echoes it, and handlers log under it", async () => {
      const res = await t.http().get("/v1/ops-test/request-id").expect(200);
      expect(res.headers["x-request-id"]).toMatch(UUID);
      expect(res.body.data.requestId).toBe(res.headers["x-request-id"]);
    });

    it("propagates a well-formed id from the caller, through the JSON body parser too", async () => {
      const res = await t.http().post("/v1/ops-test/request-id").set("x-request-id", "proxy-abc.123").send({ any: "body" }).expect(201);
      expect(res.headers["x-request-id"]).toBe("proxy-abc.123");
      expect(res.body.data.requestId).toBe("proxy-abc.123");
    });

    it("replaces an id that is too long or has unsafe characters", async () => {
      const res = await t.http().get("/v1/ops-test/request-id").set("x-request-id", "bad id\twith spaces").expect(200);
      expect(res.headers["x-request-id"]).toMatch(UUID);
      const long = await t.http().get("/v1/ops-test/request-id").set("x-request-id", "a".repeat(200)).expect(200);
      expect(long.headers["x-request-id"]).toMatch(UUID);
    });

    it("is on error answers as well: 404s and bodies the parser rejects", async () => {
      const missing = await t.http().get("/v1/no-such-route").set("x-request-id", "req-404").expect(404);
      expect(missing.headers["x-request-id"]).toBe("req-404");
      const bad = await t.http().post("/v1/ops-test/request-id").set("content-type", "application/json").set("x-request-id", "req-400").send("{not json").expect(400);
      expect(bad.headers["x-request-id"]).toBe("req-400");
      expect(bad.body.error.code).toBe("bad_request");
    });
  });

  describe("health", () => {
    it("reports database and Redis, and the worker heartbeat without failing on it", async () => {
      const res = await t.http().get("/v1/health").expect(200);
      expect(res.body.data).toMatchObject({ ok: true, checks: { database: true, redis: true }, worker: { alive: false, workers: 0, lastBeatAt: null } });
      const worker = await t.http().get("/v1/health/worker").expect(503);
      expect(worker.body.error.code).toBe("unavailable");
    });

    it("sees a worker once it beats, and the beat is mirrored to the container healthcheck file", async () => {
      const beatAt = Date.now();
      expect(await t.app.get(WorkerHeartbeat).beat(beatAt)).toBe(true);
      expect(new Date(await readFile(HEARTBEAT_FILE, "utf8")).getTime()).toBe(beatAt);
      await wait(1100); // /health shares one result per second.
      const res = await t.http().get("/v1/health/worker").expect(200);
      expect(res.body.data).toMatchObject({ alive: true, workers: 1, lastBeatAt: new Date(beatAt).toISOString() });
      expect((await t.http().get("/v1/health").expect(200)).body.data.worker.alive).toBe(true);
    });

    it("forgets a worker whose last beat is older than 90 seconds", async () => {
      await t.app.get(WorkerHeartbeat).beat(Date.now() - 120_000);
      await wait(1100);
      await t.http().get("/v1/health/worker").expect(503);
    });
  });

  describe("failed jobs", () => {
    it("logs every failed attempt with queue, job, workspace and error: a warning while it will retry, an error when it gives up", async () => {
      const warn = vi.spyOn(Logger.prototype, "warn");
      const error = vi.spyOn(Logger.prototype, "error");
      try {
        const workspaceId = crypto.randomUUID();
        const job = await t.app.get(Queues).add(QUEUES.ai, "explode", { workspaceId }, { attempts: 2, backoff: { type: "fixed", delay: 50 } });
        const q = t.app.get(Queues).queue(QUEUES.ai);
        const end = Date.now() + 15_000;
        while ((await q.getJob(job.id!).then((j) => j?.getState())) !== "failed") {
          if (Date.now() > end) throw new Error("the job never failed for good");
          await wait(100);
        }
        await wait(100);
        const warned = warn.mock.calls.find((c) => String(c[0]).includes(`ai/explode job ${job.id}`));
        expect(warned?.[0]).toContain("attempt 1/2, will retry");
        expect(warned?.[0]).toContain("kaboom explode");
        expect(warned?.[1]).toMatchObject({ queue: "ai", job: "explode", jobId: job.id, workspaceId, attempt: 1, attempts: 2, error: "kaboom explode" });
        const failed = error.mock.calls.find((c) => String(c[0]).includes(`ai/explode job ${job.id}`));
        expect(failed?.[0]).toContain(`workspace ${workspaceId} failed (attempt 2/2, giving up)`);
        expect(failed?.[1]).toMatchObject({ queue: "ai", workspaceId, attempt: 2, attempts: 2 });
        expect(String(failed?.[2])).toContain("kaboom explode"); // the stack
      } finally {
        warn.mockRestore();
        error.mockRestore();
      }
    });
  });

  describe("health rate limit", () => {
    it("answers 429 past the per-address limit (cached, so the flood never reaches the database)", async () => {
      let limited = 0;
      for (let i = 0; i < 125 && !limited; i++) {
        const res = await t.http().get("/v1/health");
        if (res.status === 429) limited = i + 1;
      }
      // Earlier tests in this file used some of the 120 a minute.
      expect(limited).toBeGreaterThan(100);
      expect(limited).toBeLessThanOrEqual(121);
    });
  });
});
