import https from "node:https";
import net from "node:net";
import { lookup } from "node:dns/promises";
import type { IncomingHttpHeaders } from "node:http";
import { MARKETING_ASSET_MAX_BYTES } from "@growthdesk/shared";
import { isPrivateAddress, type Lookup } from "../../../mailboxes/net-guard.js";
import { badRequest, isApiError } from "../../../common/errors.js";

/*
 * Fetching an image from a URL the model names, for upload_image_from_url.
 * The URL comes from a conversation, so it is untrusted: without checks this
 * is a request forgery primitive into the API's network (metadata endpoints,
 * internal services). The guard, reusing net-guard's private-range check:
 *
 *   - https only, port 443, no user:password@;
 *   - the host is *resolved* and every address must be public (a name that
 *     answers with one public and one private address is refused);
 *   - the socket opens to exactly the vetted address (servername set for SNI
 *     and certificate checks), so DNS rebinding between check and connect
 *     cannot redirect it;
 *   - redirects are followed by hand, at most 3, each target vetted again;
 *   - at most MARKETING_ASSET_MAX_BYTES are read, with a 10 s deadline.
 *
 * The bytes then go through MarketingAssetsService.upload, which sniffs the
 * real type (PNG/JPEG/GIF/WebP; never SVG) like a browser upload.
 */

export type VettedTarget = { url: URL; host: string; address: string };

const systemLookup: Lookup = (host) => lookup(host, { all: true, verbatim: true }).then((rows) => rows.map((r) => r.address));

const bad = (message: string) => badRequest(message, { url: message });

/** An IPv6 literal in a form isPrivateAddress does not read (hex-mapped v4 and the like) is treated as private. */
const privateish = (ip: string) => {
  if (isPrivateAddress(ip)) return true;
  if (!net.isIPv6(ip)) return false;
  const v6 = ip.toLowerCase();
  return v6.startsWith("::ffff:") || v6.startsWith("::") || v6.startsWith("64:ff9b:") || v6.startsWith("2001:db8:");
};

/** Checks a URL and resolves its host to one public address to connect to. Throws a 400 naming the problem. */
export async function vetImageUrl(raw: string, resolve: Lookup = systemLookup): Promise<VettedTarget> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw bad("That is not a valid link. Use a full https:// address of an image.");
  }
  if (url.protocol !== "https:") throw bad("Only https:// image links can be fetched.");
  if (url.username || url.password) throw bad("Links with a username or password are not accepted.");
  if (url.port && url.port !== "443") throw bad("Only the standard https port (443) is allowed.");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const isIp = net.isIP(host) !== 0;
  if (!host || host === "localhost" || /\.(localhost|local|internal|lan|home|corp|intranet)$/.test(host) || (!isIp && !host.includes("."))) {
    throw bad(`${host || "That host"} is on a private network. Use a public image link.`);
  }
  let addresses: string[];
  if (isIp) addresses = [host];
  else {
    try {
      addresses = await resolve(host);
    } catch {
      throw bad(`No such host: ${host}`);
    }
  }
  if (!addresses.length) throw bad(`No such host: ${host}`);
  if (addresses.some(privateish)) throw bad(`${host} is on a private network. Use a public image link.`);
  return { url, host, address: addresses.find((a) => net.isIPv4(a)) ?? addresses[0]! };
}

export type RawResponse = { status: number; headers: IncomingHttpHeaders; body: AsyncIterable<Buffer>; abort: () => void };

/** One GET to the vetted address. Replaceable in tests. */
export type Opener = (target: VettedTarget, timeoutMs: number) => Promise<RawResponse>;

const httpsOpen: Opener = (target, timeoutMs) =>
  new Promise((resolve, reject) => {
    const req = https.request({
      host: target.address,
      servername: net.isIP(target.host) ? undefined : target.host,
      port: 443,
      method: "GET",
      path: `${target.url.pathname}${target.url.search}`,
      headers: { host: target.url.host, accept: "image/png,image/jpeg,image/gif,image/webp;q=0.9,*/*;q=0.1", "user-agent": "Growthdesk-ImageFetch/1.0" },
      agent: false,
      timeout: timeoutMs,
    });
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
    req.on("response", (res) => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: res, abort: () => req.destroy() }));
    req.end();
  });

export type FetchedImage = { bytes: Buffer; contentType: string | undefined; finalUrl: string };

export type FetchImageOptions = { resolve?: Lookup; open?: Opener; maxBytes?: number; timeoutMs?: number; maxRedirects?: number };

/** Downloads an image from a public https URL under the guard above. */
export async function fetchImage(raw: string, opts: FetchImageOptions = {}): Promise<FetchedImage> {
  const maxBytes = opts.maxBytes ?? MARKETING_ASSET_MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const maxRedirects = opts.maxRedirects ?? 3;
  const open = opts.open ?? httpsOpen;
  const deadline = Date.now() + timeoutMs;
  let next = raw;
  for (let hop = 0; ; hop++) {
    const target = await vetImageUrl(next, opts.resolve);
    const left = deadline - Date.now();
    if (left <= 0) throw bad("The image took too long to download.");
    let res: RawResponse;
    try {
      res = await open(target, left);
    } catch (e) {
      throw bad(`Could not download the image from ${target.host}: ${e instanceof Error ? e.message : "connection failed"}`);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      res.abort();
      if (hop >= maxRedirects) throw bad("The image link redirects too many times.");
      next = new URL(String(res.headers.location), target.url).toString();
      continue;
    }
    if (res.status !== 200) {
      res.abort();
      throw bad(`The image link answered ${res.status}. Check that it opens in a browser without signing in.`);
    }
    const declared = Number(res.headers["content-length"] ?? NaN);
    if (Number.isFinite(declared) && declared > maxBytes) {
      res.abort();
      throw bad(`The image is larger than ${Math.round(maxBytes / 1024)} KB. Use a smaller one.`);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of res.body) {
        size += chunk.length;
        if (size > maxBytes) {
          res.abort();
          throw bad(`The image is larger than ${Math.round(maxBytes / 1024)} KB. Use a smaller one.`);
        }
        if (Date.now() > deadline) {
          res.abort();
          throw bad("The image took too long to download.");
        }
        chunks.push(chunk);
      }
    } catch (e) {
      if (isApiError(e)) throw e;
      throw bad(`The download from ${target.host} broke off. Try again.`);
    }
    if (!size) throw bad("The image link returned nothing.");
    const type = String(res.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    return { bytes: Buffer.concat(chunks), contentType: type.startsWith("image/") ? type : undefined, finalUrl: target.url.toString() };
  }
}

/** A file name for the upload, from the URL's last path segment. */
export function fileNameFrom(url: string): string {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
    return last.replace(/[^\w.\- ]+/g, "").slice(0, 200) || "image";
  } catch {
    return "image";
  }
}
