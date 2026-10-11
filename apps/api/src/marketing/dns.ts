import { Injectable } from "@nestjs/common";
import { promises as dns } from "node:dns";

/**
 * DNS lookups for sending-domain checks. A class so tests can swap the
 * functions for fakes (`app.get(DnsResolver).txt = …`).
 */
@Injectable()
export class DnsResolver {
  /** TXT records, each joined from its chunks; [] when the name has none. */
  txt = async (name: string): Promise<string[]> => {
    try {
      return (await dns.resolveTxt(name)).map((chunks) => chunks.join(""));
    } catch {
      return [];
    }
  };

  cname = async (name: string): Promise<string[]> => {
    try {
      return await dns.resolveCname(name);
    } catch {
      return [];
    }
  };
}

export type RecordCheck = { ok: boolean; found: string[]; expected: string; required: boolean };
export type DomainChecks = { ownership: RecordCheck; dkim: RecordCheck; dmarc: RecordCheck; spf: RecordCheck };

/** The organisational domain DMARC falls back to: the last two labels (a simplification that misses co.uk-style suffixes). */
export const orgDomain = (domain: string) => domain.split(".").slice(-2).join(".");

export async function checkDomain(r: DnsResolver, domain: string, token: string, selectors: string[]): Promise<DomainChecks> {
  const ownershipName = `_growthdesk.${domain}`;
  const ownershipFound = await r.txt(ownershipName);
  const expectedOwnership = `growthdesk-verification=${token}`;

  const dkimFound: string[] = [];
  for (const sel of selectors) {
    const name = `${sel}._domainkey.${domain}`;
    const [c, t] = await Promise.all([r.cname(name), r.txt(name)]);
    if (c.length || t.some((v) => /v=DKIM1|k=rsa|p=/i.test(v))) dkimFound.push(`${name} → ${c[0] ?? "TXT key"}`);
  }

  let dmarcFound = (await r.txt(`_dmarc.${domain}`)).filter((v) => /^v=DMARC1/i.test(v));
  if (!dmarcFound.length && orgDomain(domain) !== domain) dmarcFound = (await r.txt(`_dmarc.${orgDomain(domain)}`)).filter((v) => /^v=DMARC1/i.test(v));

  const spfFound = (await r.txt(domain)).filter((v) => /^v=spf1/i.test(v));

  return {
    ownership: { ok: ownershipFound.includes(expectedOwnership), found: ownershipFound, expected: `TXT ${ownershipName} = ${expectedOwnership}`, required: true },
    dkim: {
      ok: selectors.length > 0 && dkimFound.length === selectors.length,
      found: dkimFound,
      expected: selectors.length ? `CNAME or TXT at ${selectors.map((s) => `${s}._domainkey.${domain}`).join(", ")} (from your email service)` : "Add the DKIM selectors your email service gave you",
      required: true,
    },
    dmarc: { ok: dmarcFound.length > 0, found: dmarcFound, expected: `TXT _dmarc.${domain} = v=DMARC1; p=none; rua=mailto:dmarc@${orgDomain(domain)}`, required: true },
    // SPF on the From domain is not needed for DMARC when DKIM aligns (ESPs use their own Return-Path); shown as advice.
    spf: { ok: spfFound.length > 0, found: spfFound, expected: `TXT ${domain} = v=spf1 include:<your email service> ~all`, required: false },
  };
}

export const domainVerified = (c: DomainChecks) => c.ownership.ok && c.dkim.ok && c.dmarc.ok;
