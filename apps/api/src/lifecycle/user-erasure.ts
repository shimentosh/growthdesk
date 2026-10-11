import type { Tx } from "../prisma/prisma.service.js";

/**
 * GDPR erasure of a person's identity that keeps the User row (billing
 * accounts, audit rows and records still point at it): the address, name
 * and credentials are wiped, sessions end, sign-in links and
 * failures go, the platform email log forgets the address, and the platform
 * profile is marked anonymised. Used by platform admin "Delete & anonymise"
 * and by people closing their own account (AccountService.close).
 *
 * Runs inside the caller's transaction. API keys are revoked by the caller
 * after commit (ApiKey rows span workspaces).
 */
export async function eraseUserIdentity(
  tx: Tx,
  user: { id: string; email: string; suspendedAt: Date | null },
  now: Date,
  opts: { reason: string; closedBySelf?: boolean },
) {
  const original = user.email;
  const anon = `deleted+${user.id}@invalid`;
  await tx.user.update({
    where: { id: user.id },
    data: {
      email: anon,
      name: "",
      passwordHash: null,
      googleSub: null,
      avatarUrl: "",
      emailVerifiedAt: null,
      suspendedAt: user.suspendedAt ?? now,
      suspendedReason: opts.reason,
      ...(opts.closedBySelf ? { closedAt: now } : {}),
    },
  });
  await tx.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: now } });
  await tx.authToken.deleteMany({ where: { userId: user.id } });
  await tx.signInFailure.deleteMany({ where: { OR: [{ userId: user.id }, { email: original }] } });
  await tx.emailLog.updateMany({ where: { OR: [{ userId: user.id }, { to: original }] }, data: { to: anon } });
  await tx.billingAccount.updateMany({ where: { ownerId: user.id, billingEmail: original }, data: { billingEmail: "" } });
  await tx.platformUserNote.deleteMany({ where: { userId: user.id } });
  await tx.platformWaitlistEntry.deleteMany({ where: { email: original } });
  await tx.platformSignupInvite.deleteMany({ where: { email: original } });
  const erased = { utm: {}, referrer: "", landingPath: "", marketingConsent: false, consentAt: null, consentSource: "", tags: [], anonymisedAt: now };
  await tx.platformUserProfile.upsert({ where: { userId: user.id }, create: { userId: user.id, ...erased }, update: erased });
  return { original, anon };
}
