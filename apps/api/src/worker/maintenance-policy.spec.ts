import { IMPORT_STALL_MS, RETENTION, isFinalAttempt, retentionCutoffs, stalledImports } from "./maintenance-policy.js";

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
