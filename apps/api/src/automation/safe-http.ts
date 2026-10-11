import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

/*
 * Outbound HTTP for customer-supplied URLs (outgoing webhooks), with an SSRF
 * guard: the host is resolved and every address is checked against private,
 * loopback, link-local, carrier-grade NAT, multicast and cloud-metadata
 * ranges before a connection is made.
 *
 * The check runs inside the socket's own `lookup`, so the address that was
 * checked is the address that is connected to — a DNS answer that changes
 * between a check and the request (rebinding) cannot slip past. Redirects
 * are not followed.
 *
 * ALLOW_PRIVATE_WEBHOOKS=true switches the guard off. It exists for local
 * development and the e2e tests (which deliver to 127.0.0.1); never set it in
 * production.
 */

export const allowPrivateWebhooks = () => process.env.ALLOW_PRIVATE_WEBHOOKS === "true";

function ipv4Blocked(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = p as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true; // "this" network, private, loopback
  if (a === 169 && b === 254) return true; // link-local, incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // IETF assignments, TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

/** True for any address an outgoing webhook must not reach. */
export function isBlockedAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, "").split("%")[0]!.toLowerCase();
  if (net.isIPv4(ip)) return ipv4Blocked(ip);
  if (!net.isIPv6(ip)) return true;
  if (ip === "::" || ip === "::1") return true;
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/) ?? ip.match(/^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return ipv4Blocked(mapped[1]!);
  if (/^::ffff:/.test(ip)) return true; // mapped in hex form — refuse rather than decode
  const first = parseInt(ip.split(":")[0] || "0", 16);
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local (incl. fd00:ec2::254 metadata)
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return true; // multicast
  if (ip.startsWith("2001:db8:") || ip.startsWith("2001:0db8:")) return true; // documentation
  return false;
}

export class BlockedAddressError extends Error {
  readonly code = "EBLOCKED";
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address?: string | dns.LookupAddress[], family?: number) => void;

function guardedLookup(hostname: string, options: dns.LookupOptions, callback: LookupCallback) {
  dns.lookup(hostname, { family: options.family ?? 0, hints: options.hints, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = addresses as unknown as dns.LookupAddress[];
    if (!allowPrivateWebhooks()) {
      const bad = list.find((a) => isBlockedAddress(a.address));
      if (bad) return callback(new BlockedAddressError(`${hostname} resolves to a private or reserved address (${bad.address})`));
    }
    if (!list.length) return callback(Object.assign(new Error(`${hostname} did not resolve`), { code: "ENOTFOUND" }));
    if (options.all) return callback(null, list);
    callback(null, list[0]!.address, list[0]!.family);
  });
}

/** Refuses a URL whose host is (or resolves to) a blocked address. Used when an endpoint is saved. */
export async function assertPublicUrl(raw: string): Promise<void> {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new BlockedAddressError("Only http and https URLs are allowed");
  if (url.username || url.password) throw new BlockedAddressError("URLs that carry a username or password are not accepted");
  if (allowPrivateWebhooks()) return;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) throw new BlockedAddressError(`${host} is a private or reserved address`);
    return;
  }
  const addresses = await dns.promises.lookup(host, { all: true }).catch(() => {
    throw new BlockedAddressError(`${host} could not be resolved`);
  });
  const bad = addresses.find((a) => isBlockedAddress(a.address));
  if (bad) throw new BlockedAddressError(`${host} resolves to a private or reserved address (${bad.address})`);
}

export type PostResult = { status: number | null; body: string; error: string | null };

/** POSTs a body with an overall timeout. Never throws: transport failures come back as `error`. */
export function postJson(rawUrl: string, body: string, headers: Record<string, string>, timeoutMs = 10_000): Promise<PostResult> {
  return new Promise((resolve) => {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return resolve({ status: null, body: "", error: "The URL is not valid" });
    }
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (net.isIP(host) && !allowPrivateWebhooks() && isBlockedAddress(host)) {
      return resolve({ status: null, body: "", error: `Refused: ${host} is a private or reserved address` });
    }
    const lib = url.protocol === "https:" ? https : url.protocol === "http:" ? http : null;
    if (!lib) return resolve({ status: null, body: "", error: "Only http and https URLs are allowed" });

    let settled = false;
    const done = (r: PostResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const req = lib.request(
      url,
      {
        method: "POST",
        headers: { ...headers, "content-length": Buffer.byteLength(body).toString() },
        lookup: guardedLookup as never,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          if (size < 4096) chunks.push(c);
          size += c.length;
        });
        res.on("end", () => done({ status: res.statusCode ?? null, body: Buffer.concat(chunks).toString("utf8").slice(0, 2000), error: null }));
        res.on("error", (e) => done({ status: res.statusCode ?? null, body: "", error: e.message }));
      },
    );
    const timer = setTimeout(() => {
      req.destroy(new Error(`No response within ${Math.round(timeoutMs / 1000)} seconds`));
    }, timeoutMs);
    req.on("error", (e: NodeJS.ErrnoException) => {
      const message = e instanceof BlockedAddressError ? `Refused: ${e.message}` : e.message || e.code || "Request failed";
      done({ status: null, body: "", error: message });
    });
    req.end(body);
  });
}
