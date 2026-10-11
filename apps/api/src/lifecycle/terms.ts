import type { PrismaService } from "../prisma/prisma.service.js";

/**
 * The version of the Terms of Service and Privacy Policy a person agrees to:
 * when the newer of the two was last published from platform admin → Website,
 * as an ISO timestamp, or "default" while both still show the built-in text.
 * Stored on the user with the acceptance time (User.termsVersion), so it is
 * always possible to say which published text someone accepted.
 */
export async function currentTermsVersion(prisma: PrismaService): Promise<string> {
  const rows = await prisma.db.platformSiteContent.findMany({
    where: { key: { in: ["legal.terms", "legal.privacy"] }, publishedAt: { not: null } },
    select: { publishedAt: true },
  });
  const latest = rows.reduce<Date | null>((max, r) => (r.publishedAt && (!max || r.publishedAt > max) ? r.publishedAt : max), null);
  return latest ? latest.toISOString() : "default";
}
