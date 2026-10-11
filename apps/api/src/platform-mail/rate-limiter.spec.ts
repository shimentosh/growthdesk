import { takeToken } from "./rate-limiter.js";

/* The TypeScript mirror of the Redis token bucket (the Lua script runs the same steps; e2e covers Redis). */
describe("takeToken", () => {
  it("allows a one-second burst, then spaces requests at the configured rate", () => {
    let state = null as ReturnType<typeof takeToken>["state"] | null;
    const waits: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = takeToken(state, 1_000, 2);
      state = r.state;
      waits.push(r.waitMs);
    }
    expect(waits).toEqual([0, 0, 500, 500]);
    // Half a second later one token has refilled.
    expect(takeToken(state, 1_500, 2).waitMs).toBe(0);
  });

  it("never holds more than one second of tokens", () => {
    const first = takeToken(null, 0, 3);
    const later = takeToken(first.state, 60_000, 3);
    expect(later.state.tokens).toBe(2);
  });

  it("a block (429 retry-after) stops every caller until it passes", () => {
    const blocked = { tokens: 5, ts: 0, blockedUntil: 3_000 };
    expect(takeToken(blocked, 1_000, 5).waitMs).toBe(2_000);
    expect(takeToken(blocked, 3_000, 5).waitMs).toBe(0);
  });

  it("rate 1 means one request a second", () => {
    const a = takeToken(null, 0, 1);
    expect(a.waitMs).toBe(0);
    expect(takeToken(a.state, 0, 1).waitMs).toBe(1000);
    expect(takeToken(a.state, 400, 1).waitMs).toBe(600);
  });
});
