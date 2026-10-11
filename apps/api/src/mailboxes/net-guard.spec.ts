import { assertReachableTarget, isPrivateAddress, resolvePinnedTarget, type Lookup } from "./net-guard.js";

const answers = (...ips: string[]): Lookup => async () => ips;

describe("isPrivateAddress", () => {
  it.each(["10.0.0.5", "127.0.0.1", "169.254.169.254", "172.20.1.1", "192.168.1.1", "::1", "fd00::1", "::ffff:10.0.0.1", "64:ff9b::127.0.0.1"])(
    "%s is private",
    (ip) => expect(isPrivateAddress(ip)).toBe(true),
  );
  it.each(["203.0.113.10", "8.8.8.8", "2001:4860:4860::8888"])("%s is public", (ip) => expect(isPrivateAddress(ip)).toBe(false));
});

describe("resolvePinnedTarget", () => {
  it("returns the vetted address to connect to, and the name for TLS", async () => {
    const pinned = await resolvePinnedTarget("SMTP.Example.com ", 587, "SMTP", false, answers("203.0.113.10", "203.0.113.11"));
    expect(pinned).toEqual({ address: "203.0.113.10", servername: "smtp.example.com" });
  });

  it("refuses a name that resolves to a private address, even alongside a public one", async () => {
    await expect(resolvePinnedTarget("rebind.example.com", 587, "SMTP", false, answers("203.0.113.10", "10.0.0.5"))).rejects.toThrow(/private network/);
  });

  it("each call resolves afresh, so a changed answer is caught at connect time", async () => {
    let calls = 0;
    const rebinding: Lookup = async () => (calls++ === 0 ? ["203.0.113.10"] : ["127.0.0.1"]);
    await expect(assertReachableTarget("rebind.example.com", 587, "SMTP", false, rebinding)).resolves.toBeUndefined();
    await expect(resolvePinnedTarget("rebind.example.com", 587, "SMTP", false, rebinding)).rejects.toThrow(/private network/);
  });

  it("refuses ports that are not mail ports", async () => {
    await expect(resolvePinnedTarget("smtp.example.com", 6379, "SMTP", false, answers("203.0.113.10"))).rejects.toThrow(/not a mail port/);
  });

  it("passes the name through unresolved when private hosts are allowed (local test servers)", async () => {
    const lookup = vi.fn(answers("127.0.0.1"));
    expect(await resolvePinnedTarget("localhost", 3025, "SMTP", true, lookup)).toEqual({ address: "localhost", servername: "localhost" });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("keeps an IP literal as is", async () => {
    expect(await resolvePinnedTarget("203.0.113.7", 465, "SMTP", false, answers())).toEqual({ address: "203.0.113.7", servername: "203.0.113.7" });
  });
});
