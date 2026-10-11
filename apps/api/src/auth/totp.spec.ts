import { base32Decode, base32Encode, matchTotp, newTotpSecret, otpauthUri, totpCode } from "./totp.js";

// RFC 6238 appendix B, SHA-1 seed "12345678901234567890" (the last six digits of each 8-digit vector).
const SEED = base32Encode(Buffer.from("12345678901234567890", "ascii"));

describe("totp", () => {
  it("matches the RFC 6238 test vectors", () => {
    expect(totpCode(SEED, Math.floor(59 / 30))).toBe("287082");
    expect(totpCode(SEED, Math.floor(1111111109 / 30))).toBe("081804");
    expect(totpCode(SEED, Math.floor(1234567890 / 30))).toBe("005924");
    expect(totpCode(SEED, Math.floor(2000000000 / 30))).toBe("279037");
  });

  it("round-trips base32", () => {
    const buf = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255, 7]);
    expect(base32Decode(base32Encode(buf))).toEqual(buf);
    expect(newTotpSecret()).toMatch(/^[A-Z2-7]{32}$/);
  });

  it("allows one step of drift and refuses steps already used", () => {
    const now = 1111111109_000;
    const step = Math.floor(now / 30_000);
    expect(matchTotp(SEED, totpCode(SEED, step), null, now)).toBe(step);
    expect(matchTotp(SEED, totpCode(SEED, step - 1), null, now)).toBe(step - 1);
    expect(matchTotp(SEED, totpCode(SEED, step + 1), null, now)).toBe(step + 1);
    expect(matchTotp(SEED, totpCode(SEED, step - 2), null, now)).toBeNull();
    expect(matchTotp(SEED, totpCode(SEED, step), step, now)).toBeNull();
    expect(matchTotp(SEED, "12345", null, now)).toBeNull();
  });

  it("builds an otpauth URI authenticator apps accept", () => {
    expect(otpauthUri("Growthdesk", "a@b.co", "ABC")).toBe("otpauth://totp/Growthdesk%3Aa%40b.co?secret=ABC&issuer=Growthdesk&algorithm=SHA1&digits=6&period=30");
  });
});
