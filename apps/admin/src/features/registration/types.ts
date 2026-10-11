/*
 * Shapes of the registration endpoints (super-admin Phase 3). Keep in step
 * with apps/api/src/admin/admin-users.service.ts and auth.service.ts.
 */
import type { SignupInviteStatus, SignupMode, WaitlistStatus } from "@growthdesk/shared";
import type { AdminSettings, Person } from "@/features/common/types";

/** GET /admin/settings — the registration keys on top of the general ones. */
export type RegistrationSettings = AdminSettings & {
  signupMode: SignupMode;
  blockDisposableDomains: boolean;
  extraBlockedDomains: string[];
  requireEmailVerification: boolean;
  defaultTrialDays: number | null;
  /** Owned by the website settings; shown here for context only. */
  landingEnabled?: boolean;
};

export type RegistrationPatch = Partial<
  Pick<RegistrationSettings, "signupMode" | "signupDomains" | "blockDisposableDomains" | "extraBlockedDomains" | "requireEmailVerification" | "defaultTrialDays">
>;

/** GET /auth/signup-policy (public) */
export type SignupPolicy = { mode: SignupMode; googleEnabled: boolean; requiresInvite: boolean };

export type WaitlistEntry = {
  id: string;
  email: string;
  name: string;
  utm: Record<string, string>;
  status: WaitlistStatus;
  invitedAt: string | null;
  createdAt: string;
};

/** GET /admin/waitlist */
export type WaitlistPage = { items: WaitlistEntry[]; total: number; page: number; pageSize: number; counts: Record<WaitlistStatus, number> };

export type SignupInvite = {
  id: string;
  email: string;
  status: SignupInviteStatus;
  expiresAt: string;
  usedAt: string | null;
  createdAt: string;
  createdBy: Person | null;
};

/** POST /admin/signup-invites and POST /admin/waitlist/:id/invite. `url` is shown once. */
export type CreatedInvite = { invite: SignupInvite; url: string; emailed: boolean; entry?: WaitlistEntry };
