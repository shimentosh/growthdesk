import { EventEmitter } from "node:events";
import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import type { DiscoveryService } from "@nestjs/core";
import type { Job, Worker } from "bullmq";
import { afterEach, describe, expect, it, vi } from "vitest";
import { describeFailure, FailedJobsListener } from "./failed-jobs.js";

const job = (over: Partial<Job> = {}) => ({ id: "42", name: "send", data: { workspaceId: "ws-1", other: 1 }, attemptsMade: 1, opts: { attempts: 3 }, ...over }) as unknown as Job;

afterEach(() => vi.restoreAllMocks());

describe("describeFailure", () => {
  it("names the queue, job, id, workspace and error, and says a retry follows", () => {
    const line = describeFailure("mail", job(), new Error("SMTP 421"));
    expect(line.final).toBe(false);
    expect(line.message).toBe("mail/send job 42 workspace ws-1 failed (attempt 1/3, will retry): SMTP 421");
    expect(line.fields).toEqual({ queue: "mail", job: "send", jobId: "42", workspaceId: "ws-1", attempt: 1, attempts: 3, error: "SMTP 421" });
  });

  it("is final on the last attempt, and for jobs without retries", () => {
    expect(describeFailure("mail", job({ attemptsMade: 3 }), new Error("x")).final).toBe(true);
    expect(describeFailure("maintenance", job({ attemptsMade: 1, opts: {} }), new Error("x")).final).toBe(true);
  });

  it("copes with platform jobs (no workspace), a missing job and a missing error", () => {
    expect(describeFailure("platform-mail", job({ data: { logId: "l" } }), new Error("x")).fields.workspaceId).toBeNull();
    const line = describeFailure("events", undefined, undefined);
    expect(line.message).toContain("events/? job ?");
    expect(line.fields.error).toBe("unknown error");
  });
});

describe("FailedJobsListener", () => {
  class FakeHost extends WorkerHost {
    constructor(private readonly w: Worker) {
      super();
    }
    override get worker() {
      return this.w;
    }
    override async process() {
      return null;
    }
  }

  it("attaches to every WorkerHost once and logs warn (retry) then error (final)", () => {
    const emitter = Object.assign(new EventEmitter(), { name: "mail" }) as unknown as Worker;
    const discovery = { getProviders: () => [{ instance: new FakeHost(emitter) }, { instance: {} }, { instance: null }] } as unknown as DiscoveryService;
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const listener = new FailedJobsListener(discovery);
    listener.onApplicationBootstrap();
    listener.onApplicationBootstrap(); // idempotent: still one listener
    (emitter as unknown as EventEmitter).emit("failed", job(), new Error("SMTP 421"));
    (emitter as unknown as EventEmitter).emit("failed", job({ attemptsMade: 3 }), new Error("SMTP 550"));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![1]).toMatchObject({ queue: "mail", workspaceId: "ws-1", attempt: 1 });
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]![0])).toContain("giving up");
    expect(String(error.mock.calls[0]![2])).toContain("SMTP 550");
  });
});
