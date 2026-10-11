import { Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common";
import { DiscoveryService } from "@nestjs/core";
import { WorkerHost } from "@nestjs/bullmq";
import type { Job, Worker } from "bullmq";
import { reportError } from "../common/sentry.js";

/*
 * One listener for every BullMQ worker in the process (docs/GAP_PLAN.md 6.1):
 * a job that throws used to vanish into Redis' failed set with nothing in the
 * logs. Now each failed attempt is logged with its queue, job name, job id,
 * workspaceId and error; an attempt that will be retried is a warning, the
 * last one an error that also goes to Sentry (when SENTRY_DSN is set).
 *
 * It is generic on purpose: a processor that wants to act on its own failures
 * (mark a row failed, tell the user) still does so itself — this only makes
 * sure nobody has to remember to log.
 */

export type FailureLine = {
  final: boolean;
  message: string;
  fields: { queue: string; job: string; jobId: string | null; workspaceId: string | null; attempt: number; attempts: number; error: string };
};

/** What to log for one failed attempt (pure, for tests). */
export function describeFailure(queue: string, job: Pick<Job, "id" | "name" | "data" | "attemptsMade" | "opts"> | undefined, error: Error | undefined): FailureLine {
  const data = (job?.data ?? {}) as Record<string, unknown>;
  const workspaceId = typeof data.workspaceId === "string" ? data.workspaceId : null;
  const attempts = Math.max(1, job?.opts?.attempts ?? 1);
  // BullMQ increments attemptsMade before emitting "failed".
  const attempt = Math.max(1, job?.attemptsMade ?? 1);
  const final = attempt >= attempts;
  const name = job?.name ?? "?";
  const reason = (error?.message ?? "unknown error").slice(0, 1000);
  const where = workspaceId ? ` workspace ${workspaceId}` : "";
  return {
    final,
    message: `${queue}/${name} job ${job?.id ?? "?"}${where} failed (attempt ${attempt}/${attempts}${final ? ", giving up" : ", will retry"}): ${reason}`,
    fields: { queue, job: name, jobId: job?.id ?? null, workspaceId, attempt, attempts, error: reason },
  };
}

@Injectable()
export class FailedJobsListener implements OnApplicationBootstrap {
  private readonly log = new Logger("jobs");
  private readonly attached = new WeakSet<Worker>();

  constructor(private readonly discovery: DiscoveryService) {}

  /** Workers exist from onModuleInit (the BullMQ explorer creates them), so attach afterwards. */
  onApplicationBootstrap() {
    for (const wrapper of this.discovery.getProviders()) {
      const host = wrapper.instance as unknown;
      if (!(host instanceof WorkerHost)) continue;
      let worker: Worker;
      try {
        worker = host.worker;
      } catch {
        continue; // Not registered (manualRegistration); nothing to listen to.
      }
      this.attach(worker);
    }
  }

  attach(worker: Worker) {
    if (this.attached.has(worker)) return;
    this.attached.add(worker);
    worker.on("failed", (job, error) => this.onFailed(worker.name, job, error));
    worker.on("error", (error) => this.log.error(`${worker.name} worker error: ${error.message}`, { queue: worker.name }));
  }

  onFailed(queue: string, job: Job | undefined, error: Error | undefined) {
    const line = describeFailure(queue, job, error);
    if (!line.final) {
      this.log.warn(line.message, line.fields);
      return;
    }
    this.log.error(line.message, line.fields, error?.stack);
    reportError(error ?? new Error(line.fields.error), {
      tags: { queue, job: line.fields.job, ...(line.fields.workspaceId ? { workspace_id: line.fields.workspaceId } : {}) },
      extra: { jobId: line.fields.jobId, attempts: line.fields.attempts },
    });
  }
}
