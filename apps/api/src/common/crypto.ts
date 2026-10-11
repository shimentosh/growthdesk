import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

/*
 * Ported from LinkDesk packages/db/src/crypto.ts.
 *
 * Passwords: scrypt (memory-hard, Node stdlib, no native build). Secrets that
 * must be read back (mailbox passwords, OAuth refresh tokens, provider API
 * keys): AES-256-GCM under ENCRYPTION_KEY. Session, invitation, reset and API
 * key tokens: stored only as a SHA-256 digest, so a leaked table cannot be
 * replayed.
 *
 * Change from LinkDesk: `verifyPassword` against a missing hash still spends
 * the scrypt work (DUMMY_HASH), so a sign-in for an unknown email takes as
 * long as one for a real account and cannot be used to enumerate accounts.
 */

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem?: number },
) => Promise<Buffer>;

const N = 16384;
const r = 8;
const p = 1;
const KEY_LEN = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password.normalize("NFKC"), salt, KEY_LEN, { N, r, p });
  return ["scrypt", N, r, p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

const DUMMY_HASH = `scrypt$${N}$${r}$${p}$${Buffer.alloc(16).toString("base64url")}$${Buffer.alloc(KEY_LEN).toString("base64url")}`;

/** Constant-time check. Returns false for anything it cannot parse, never throws. */
export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  const real = Boolean(stored);
  const parts = (stored || DUMMY_HASH).split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, rr, pp, salt, hash] = parts as [string, string, string, string, string, string];
  try {
    const expected = Buffer.from(hash, "base64url");
    const actual = await scryptAsync(password.normalize("NFKC"), Buffer.from(salt, "base64url"), expected.length, {
      N: Number(n),
      r: Number(rr),
      p: Number(pp),
    });
    return real && actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** A URL-safe secret for a cookie or an email link. */
export const newToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

/** What goes in the database for that token. */
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

let cachedKey: Buffer | null = null;
function encryptionKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.ENCRYPTION_KEY ?? "";
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("ENCRYPTION_KEY must be 32 bytes of base64 (openssl rand -base64 32).");
  }
  cachedKey = key;
  return key;
}

/** Seals a secret for storage. The nonce travels with the ciphertext. */
export function seal(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), body.toString("base64")].join(".");
}

/** Opens a sealed secret. Returns null when the key has changed or the value was tampered with. */
export function open(sealed: string | null | undefined): string | null {
  if (!sealed) return null;
  const [iv, tag, body] = sealed.split(".");
  if (!iv || !tag || !body) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

export const sealJson = (value: unknown) => seal(JSON.stringify(value));
export function openJson<T>(sealed: string | null | undefined): T | null {
  const raw = open(sealed);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** A purpose-specific key derived from ENCRYPTION_KEY (tracking links, unsubscribe links, OAuth state). */
export function derivedKey(purpose: string): Buffer {
  return Buffer.from(hkdfSync("sha256", encryptionKey(), "growthdesk", purpose, 32));
}

export function hmac(key: Buffer | string, value: string | Buffer, encoding: "hex" | "base64url" = "hex"): string {
  return createHmac("sha256", key).update(value).digest(encoding);
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
