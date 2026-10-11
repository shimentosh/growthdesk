import { DATA_RETENTION, IMPORT_STALL_MS, RETENTION, dataRetentionCutoffs, isFinalAttempt, retentionCutoffs, stalledImports } from "./maintenance-policy.js";
import { loadConfig } from "../config/config.js";

describe("dataRetentionCutoffs", () => {
  const now = new Date("2026-10-10T12:00:00.000Z");
  const config = loadConfig({ DATABASE_URL: "postgresql://x", ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64") } as NodeJS.ProcessEnv);

  it("has defaults for every table, long enough to cover reports and retries", () => {
    const c = dataRetentionCutoffs(config, now);
    const days = (d: Date | null) => (d ? (now.getTime() - d.getTime()) / 86_400_000 : null);
    expect(days(c.domainEvents)).toBe(30);
    expect(days(c.messageEvents)).toBe(365);
    expect(days(c.workflowRuns)).toBe(90);
    expect(days(c.activityNoise)).toBe(365);
    expect(days(c.aiUsage)).toBeGreaterThan(366); // a full year of monthly AI reports
    expect(days(c.billingEvents)).toBeGreaterThan(366);
    expect(days(c.marketingSends)).toBe(730);
    // The per-step campaign report reads step executions, so they are kept unless an operator opts in.
    expect(c.stepExecutions).toBeNull();
  });

  it("reads each setting, and 0 keeps rows forever", () => {
    const c = dataRetentionCutoffs({ ...config, RETENTION_DOMAIN_EVENT_DAYS: 7, RETENTION_MESSAGE_EVENT_DAYS: 0 }, now);
    expect(c.domainEvents?.toISOString()).toBe("2026-10-03T12:00:00.000Z");
    expect(c.messageEvents).toBeNull();
    expect(Object.keys(c).sort()).toEqual(Object.keys(DATA_RETENTION).sort());
  });

  it("reads a blank setting (compose passes `${VAR:-}`) as the default, not as 0", () => {
    const blank = loadConfig({ DATABASE_URL: "postgresql://x", ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"), RETENTION_DOMAIN_EVENT_DAYS: "" } as NodeJS.ProcessEnv);
    expect(blank.RETENTION_DOMAIN_EVENT_DAYS).toBe(30);
  });

  it("refuses a negative setting at boot", () => {
    expect(() => loadConfig({ DATABASE_URL: "postgresql://x", ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"), RETENTION_AI_USAGE_DAYS: "-1" } as NodeJS.ProcessEnv)).toThrow(/RETENTION_AI_USAGE_DAYS/);
  });
});

describe("retentionCutoffs", () => {
  const now = new Date("2026-10-10T12:00:00.000Z");

  it("puts every cut-off its retention period before now", () => {
    const c = retentionCutoffs(now);
    for (const [k, ms] of Object.entries(RETENTION)) {
      expect(c[k as keyof typeof RETENTION].getTime()).toBe(now.getTime() - ms);
    }
  });

  it("gives the mailbox counter cut-off as a UTC day key that compares as a string", () => {
    const c = retentionCutoffs(now);
    expect(c.mailboxDay).toBe("2026-07-12");
    expect("2026-07-11" < c.mailboxDay).toBe(true);
    expect("2026-07-12" < c.mailboxDay).toBe(false);
  });

  it("never keeps an idempotency key or session shorter than a day", () => {
    expect(RETENTION.idempotencyKeys).toBeGreaterThanOrEqual(86_400_000);
    expect(RETENTION.sessions).toBeGreaterThanOrEqual(86_400_000);
  });
});

describe("isFinalAttempt", () => {
  it("is true only on the last configured attempt", () => {
    expect(isFinalAttempt({ attemptsMade: 0, opts: { attempts: 5 } })).toBe(false);
    expect(isFinalAttempt({ attemptsMade: 3, opts: { attempts: 5 } })).toBe(false);
    expect(isFinalAttempt({ attemptsMade: 4, opts: { attempts: 5 } })).toBe(true);
  });

  it("treats a job without attempts (or with 0) as single-shot", () => {
    expect(isFinalAttempt({ attemptsMade: 0, opts: {} })).toBe(true);
    expect(isFinalAttempt({ attemptsMade: 0, opts: { attempts: 0 } })).toBe(true);
  });
});

describe("stalledImports", () => {
  const now = new Date("2026-10-10T12:00:00.000Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);

  it("picks idle imports that have no live job", () => {
    const rows = [
      { id: "idle", updatedAt: ago(IMPORT_STALL_MS + 1) },
      { id: "fresh", updatedAt: ago(IMPORT_STALL_MS - 1000) },
      { id: "queued", updatedAt: ago(IMPORT_STALL_MS * 3) },
    ];
    expect(stalledImports(rows, new Set(["queued"]), now).map((r) => r.id)).toEqual(["idle"]);
  });
});
