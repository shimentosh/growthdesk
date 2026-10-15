import { describe, expect, it } from "vitest";

// The token key is derived from ENCRYPTION_KEY on first use; a fixed test-only key.
process.env.ENCRYPTION_KEY ??= "dGVzdC1vbmx5LWtleS0zMi1ieXRlcy1sb25nLW9rISE=";

const { confirmToken, confirmUrl, marketingToken, readConfirmToken, readMarketingToken } = await import("./tokens.js");
const { confirmationEmail } = await import("./double-opt-in.js");

const membership = "0190a3c4-1b2c-7d3e-8f40-0123456789ab";
const other = "0190a3c4-1b2c-7d3e-8f40-ba9876543210";

describe("double opt-in confirmation tokens", () => {
  it("round-trip the membership and are deterministic", () => {
    expect(readConfirmToken(confirmToken(membership))).toBe(membership);
    expect(confirmToken(membership)).toBe(confirmToken(membership));
    expect(confirmUrl("https://app.example.com/", membership)).toBe(`https://app.example.com/confirm/${confirmToken(membership)}`);
  });

  it("refuse tampering and junk", () => {
    const [p, id, sig] = confirmToken(membership).split(".");
    const [, otherId] = confirmToken(other).split(".");
    expect(readConfirmToken([p, otherId, sig].join("."))).toBeNull();
    expect(readConfirmToken([p, id, `${sig}x`].join("."))).toBeNull();
    expect(readConfirmToken([p, id].join("."))).toBeNull();
    expect(readConfirmToken("")).toBeNull();
    expect(readConfirmToken("s.x.y")).toBeNull();
  });

  it("cannot be swapped with a send's tokens", () => {
    const preferences = marketingToken({ kind: "preferences", sendId: membership });
    expect(readConfirmToken(preferences)).toBeNull();
    expect(readMarketingToken(confirmToken(membership))).toBeNull();
    // Same id and signature, different letter: the letter is signed too.
    const [, id, sig] = confirmToken(membership).split(".");
    expect(readMarketingToken(["p", id, sig].join("."))).toBeNull();
  });
});

describe("confirmationEmail", () => {
  const mail = confirmationEmail({
    workspaceName: "Acme <News>",
    listName: "Monthly & more",
    email: "ann@example.com",
    confirmUrl: "https://app.example.com/confirm/s.abc.def",
    legalName: "Acme Ltd",
    postalAddress: "1 Main St, Springfield",
  });

  it("names the list, links the confirmation and escapes what the workspace typed", () => {
    expect(mail.subject).toBe("Confirm your subscription to Monthly & more");
    expect(mail.html).toContain('href="https://app.example.com/confirm/s.abc.def"');
    expect(mail.html).toContain("Acme &lt;News&gt;");
    expect(mail.html).toContain("Monthly &amp; more");
    expect(mail.html).not.toContain("<News>");
    expect(mail.html).toContain("Acme Ltd · 1 Main St, Springfield");
    expect(mail.html).toMatch(/didn't ask to join/);
  });

  it("has a plain-text part with the link", () => {
    expect(mail.text).toContain("https://app.example.com/confirm/s.abc.def");
    expect(mail.text).toContain("ann@example.com");
  });
});
