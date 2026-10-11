import { ERROR_RECHECK_MS, HEALTHY_RECHECK_MS, SYNC_STALE_MS, healthCheckDue, replyTrackingProblem, syncBlockedBySignIn } from "./mailbox-upkeep.js";

describe("syncBlockedBySignIn", () => {
  it("holds back syncing only while the IMAP or OAuth sign-in is known broken", () => {
    expect(syncBlockedBySignIn({ status: "error", lastError: "IMAP sign-in failed: Invalid credentials" })).toBe(true);
    expect(syncBlockedBySignIn({ status: "error", lastError: "IMAP — Connection refused" })).toBe(true);
    expect(syncBlockedBySignIn({ status: "error", lastError: "Sign-in refresh failed: invalid_grant" })).toBe(true);
  });

  it("keeps reply tracking running when only sending is broken", () => {
    expect(syncBlockedBySignIn({ status: "error", lastError: "SMTP — 535 Authentication failed" })).toBe(false);
    expect(syncBlockedBySignIn({ status: "connected", lastError: "" })).toBe(false);
  });
});

describe("healthCheckDue", () => {
  const now = new Date("2026-10-10T12:00:00.000Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);

  it("checks a never-checked mailbox at once", () => {
    expect(healthCheckDue({ status: "connected", lastError: "", lastCheckedAt: null }, now)).toBe(true);
  });

  it("re-checks working mailboxes daily and broken ones hourly", () => {
    expect(healthCheckDue({ status: "connected", lastError: "", lastCheckedAt: ago(ERROR_RECHECK_MS * 2) }, now)).toBe(false);
    expect(healthCheckDue({ status: "connected", lastError: "", lastCheckedAt: ago(HEALTHY_RECHECK_MS) }, now)).toBe(true);
    expect(healthCheckDue({ status: "error", lastError: "SMTP — down", lastCheckedAt: ago(ERROR_RECHECK_MS - 1) }, now)).toBe(false);
    expect(healthCheckDue({ status: "error", lastError: "SMTP — down", lastCheckedAt: ago(ERROR_RECHECK_MS) }, now)).toBe(true);
  });

  it("leaves disconnected mailboxes to a person", () => {
    expect(healthCheckDue({ status: "disconnected", lastError: "", lastCheckedAt: null }, now)).toBe(false);
  });
});

describe("replyTrackingProblem", () => {
  const now = new Date("2026-10-10T12:00:00.000Z");
  const box = { email: "sam@acme.test", imapEnabled: true, imapHost: "imap.acme.test", lastSyncedAt: new Date(now.getTime() - 60_000), syncError: "" };

  it("is quiet while replies are being read", () => {
    expect(replyTrackingProblem(box, now)).toBeNull();
  });

  it("warns when IMAP is off, failing, never synced or stale", () => {
    expect(replyTrackingProblem({ ...box, imapEnabled: false }, now)).toMatch(/IMAP\) is off for sam@acme.test/);
    expect(replyTrackingProblem({ ...box, imapHost: "" }, now)).toMatch(/is off/);
    expect(replyTrackingProblem({ ...box, syncError: "Connection refused" }, now)).toMatch(/failing \(Connection refused\)/);
    expect(replyTrackingProblem({ ...box, lastSyncedAt: null }, now)).toMatch(/not been read yet/);
    expect(replyTrackingProblem({ ...box, lastSyncedAt: new Date(now.getTime() - SYNC_STALE_MS) }, now)).toMatch(/last read 30 minutes ago/);
  });
});
