import { lookup } from "node:dns/promises";
import net from "node:net";
import { badRequest } from "../common/errors.js";

/*
 * Ported from LinkDesk apps/api/src/modules/mailboxes/mailboxes.service.ts
 * (assertReachableTarget / isPrivateAddress).
 *
 * Connecting a mailbox opens a connection to a host and port the caller
 * names and reports what happened — refused, timed out, "something answered"
 * are all distinguishable — which is a port scanner run from inside the API
 * host unless the target is checked first. The name is *resolved* rather than
 * pattern-matched (`internal.example.com → 10.0.0.5` is the interesting case),
 * and every address it resolves to is checked, so a name answering with one
 * public and one private address does not get through on the public one.
 *
 * Change from LinkDesk: instead of a fixed list of "mail catcher" ports on
 * loopback, private targets are allowed only when ALLOW_PRIVATE_MAIL_HOSTS is
 * set (local test servers; never in production). The port check applies to
 * public targets only.
 *
 * DNS rebinding: assertReachableTarget only checks, and nodemailer/imapflow
 * resolve the name again when they connect, so an answer that changes between
 * the two is not caught. resolvePinnedTarget closes that gap by returning the
 * vetted address to connect to: the SMTP send path (OutboundEmailService ->
 * messaging/smtp.ts) and the SMTP sign-in checks connect to it. The sync
 * worker re-runs the check before every pass.
 */

/** Ports a mail server legitimately listens on (SMTP, submission, alt-submission, IMAP, POP). */
const MAIL_PORTS = new Set([25, 465, 587, 2465, 2525, 2587, 143, 993, 110, 995]);

/** Address ranges that are not somebody's mail provider. */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a = 0, b = 0, c = 0] = ip.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  const v6 = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (v6 === "::" || v6 === "::1") return true;
  if (/^fe[89ab]/.test(v6) || v6.startsWith("fc") || v6.startsWith("fd")) return true;
  // ::ffff:10.0.0.1 and friends are the v4 ranges wearing a v6 hat.
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateAddress(mapped[1]!);
  // NAT64 (64:ff9b::/96) embeds a v4 address in the last 32 bits.
  const nat64 = v6.match(/^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/);
  return nat64 ? isPrivateAddress(nat64[1]!) : false;
}

export type Lookup = (host: string) => Promise<string[]>;

const systemLookup: Lookup = (host) => lookup(host, { all: true, verbatim: true }).then((rows) => rows.map((r) => r.address));

/**
 * Refuses a target that is not plausibly a mail server on the internet.
 * `allowPrivate` (ALLOW_PRIVATE_MAIL_HOSTS) lets local test servers through.
 */
export async function assertReachableTarget(host: string, port: number, label: "SMTP" | "IMAP", allowPrivate: boolean, resolve: Lookup = systemLookup): Promise<void> {
  await vetTarget(host, port, label, allowPrivate, resolve);
}

/** Where to open the socket, and the name the TLS certificate must match. */
export type PinnedTarget = { address: string; servername: string };

/**
 * The same checks as assertReachableTarget, returning the vetted address so
 * the caller connects to exactly that IP (with `servername` for TLS/SNI)
 * instead of letting the mail library resolve the name a second time — which
 * is what a DNS-rebinding answer would exploit. With `allowPrivate` the name
 * is returned unresolved (local test servers).
 */
export async function resolvePinnedTarget(host: string, port: number, label: "SMTP" | "IMAP", allowPrivate: boolean, resolve: Lookup = systemLookup): Promise<PinnedTarget> {
  const name = (host ?? "").trim().toLowerCase();
  const addresses = await vetTarget(host, port, label, allowPrivate, resolve);
  // IPv4 first, as nodemailer itself resolves: a host without an IPv6 route still reaches a dual-stack server.
  return { address: addresses.find((a) => net.isIPv4(a)) ?? addresses[0] ?? name, servername: name };
}

/** Every address the name resolves to, after checking them all (empty with allowPrivate: nothing was resolved). */
async function vetTarget(host: string, port: number, label: "SMTP" | "IMAP", allowPrivate: boolean, resolve: Lookup): Promise<string[]> {
  const name = (host ?? "").trim().toLowerCase();
  if (!name) throw badRequest(`Name the ${label} server`, { [label === "SMTP" ? "smtpHost" : "imapHost"]: "Required" });
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw badRequest(`${port} is not a valid ${label} port`);
  if (allowPrivate) return [];

  if (!MAIL_PORTS.has(port)) {
    throw badRequest(`${port} is not a mail port — ${label} servers listen on 25, 465, 587, 143, 993 and the like`);
  }
  if (name === "localhost" || name.endsWith(".localhost") || name.endsWith(".local") || name.endsWith(".internal")) {
    throw badRequest(`${name} is on a private network. A mailbox has to be reachable from the internet.`);
  }

  let addresses: string[];
  if (net.isIP(name)) addresses = [name];
  else {
    try {
      addresses = await resolve(name);
    } catch {
      throw badRequest(`No such ${label} server: ${name}`);
    }
  }
  if (!addresses.length) throw badRequest(`No such ${label} server: ${name}`);
  if (addresses.some(isPrivateAddress)) {
    throw badRequest(`${name} is on a private network. A mailbox has to be reachable from the internet.`);
  }
  return addresses;
}

/** Hosts for which a self-signed certificate is tolerated — and only with ALLOW_PRIVATE_MAIL_HOSTS. */
export const isLocalHost = (host: string) => ["localhost", "127.0.0.1", "::1"].includes(host.trim().toLowerCase());
