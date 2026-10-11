import type { Job } from "bullmq";
import { EngineProcessor } from "./campaigns.processors.js";
import type { EngineService } from "./engine.service.js";

describe("EngineProcessor failed jobs", () => {
  const setup = (recordJobFailure = vi.fn(async () => "retry" as const)) => {
    const engine = { recordJobFailure } as unknown as EngineService;
    const processor = new EngineProcessor(engine);
    const job = (attemptsMade: number, name = "step") =>
      ({ id: "e1-4-0", name, attemptsMade, opts: { attempts: 3 }, data: { workspaceId: "w1", enrollmentId: "e1", stepRun: 4 }, remove: vi.fn(async () => undefined) }) as unknown as Job & { remove: ReturnType<typeof vi.fn> };
    return { processor, recordJobFailure, job };
  };

  it("counts a step job's final failure on its enrollment", async () => {
    const { processor, recordJobFailure, job } = setup();
    await processor.onFailed(job(3), new Error("db down"));
    expect(recordJobFailure).toHaveBeenCalledWith("w1", "e1", 4, "db down");
  });

  it("only logs an attempt BullMQ will retry, and never counts other jobs", async () => {
    const { processor, recordJobFailure, job } = setup();
    await processor.onFailed(job(1), new Error("blip"));
    await processor.onFailed(job(3, "tick"), new Error("tick broke"));
    await processor.onFailed(undefined, new Error("no job"));
    expect(recordJobFailure).not.toHaveBeenCalled();
  });

  it("frees the job id when the failure cannot be recorded, so the step is not stranded", async () => {
    const { processor, job } = setup(vi.fn(async () => {
      throw new Error("still down");
    }));
    const j = job(3);
    await processor.onFailed(j, new Error("db down"));
    expect(j.remove).toHaveBeenCalled();
  });
});
