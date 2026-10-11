/*
 * Shapes of the API responses the console's foundation reads (a subset of
 * apps/web/src/lib/types.ts). Platform-admin shapes are in
 * src/features/common/types.ts.
 */
import type { PlatformRole, WorkspaceRole } from "@growthdesk/shared";

/** GET /auth/me — apps/api/src/auth/auth.service.ts `me()` */
export type Me = {
  user: {
    id: string;
    email: string;
    name: string;
    timezone: string | null;
    emailVerified: boolean;
    platformRole: PlatformRole;
    hasPassword: boolean;
    googleLinked: boolean;
    twoFactorEnabled: boolean;
  };
  workspaces: MeWorkspace[];
  lastWorkspaceId: string | null;
};

/** GET /auth/2fa — apps/api/src/auth/two-factor.service.ts `status()` */
export type TwoFactorStatus = {
  enabled: boolean;
  enabledAt: string | null;
  recoveryCodesRemaining: number;
  /** Workspaces the person belongs to that require two-factor. */
  requiredBy: { id: string; name: string }[];
};

/** POST /auth/2fa/setup */
export type TwoFactorSetup = { secret: string; otpauthUri: string; qrSvg: string };

export type MeWorkspace = {
  id: string;
  name: string;
  slug: string;
  status: string;
  timezone: string;
  billingAccountId: string;
  role: WorkspaceRole;
};

/** A page of rows — the list endpoints' common shape (ListQuery: page, pageSize, sort, dir). */
export type Paged<T> = { items: T[]; total: number; page: number; pageSize: number };
