/*
 * Shapes of the API responses the foundation reads. Feature areas add their
 * own types next to their pages; keep these in step with the API services
 * named in each comment.
 */
import type { PlanFeatures, PlanLimits, PlatformRole, SubscriptionStatus, WorkspaceRole } from "@growthdesk/shared";

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
  /** Platform setting: false = an unconfirmed address can still create and use workspaces. */
  emailVerificationRequired?: boolean;
};

export type MeWorkspace = {
  id: string;
  name: string;
  slug: string;
  status: string;
  timezone: string;
  billingAccountId: string;
  role: WorkspaceRole;
};

export type PlanState = SubscriptionStatus | "none";

/** GET /workspaces/:id — apps/api/src/workspaces/workspaces.service.ts `detail()` */
export type WorkspaceDetail = {
  id: string;
  name: string;
  slug: string;
  businessType: string;
  timezone: string;
  currency: string;
  status: "active" | "suspended" | string;
  suspendedReason: string | null;
  settings: Record<string, unknown>;
  /** Company profile: printed in marketing email footers. */
  profile: { legalName: string; postalAddress: string; marketingFromName: string; marketingReplyTo: string };
  role: WorkspaceRole;
  permissions: string[];
  rolePermissions: Record<string, string[]>;
  plan: {
    key: string;
    name: string;
    state: PlanState;
    access: "full" | "restricted";
    reason: string;
    features: PlanFeatures;
    limits: PlanLimits;
    trialEndsAt: string | null;
  };
  onboarding: {
    dismissed: boolean;
    steps: { mailbox: boolean; contacts: boolean; campaign: boolean; team: boolean };
  };
};

/** GET /workspaces/:id/members */
export type Member = {
  id: string;
  userId: string;
  email: string;
  name: string;
  role: WorkspaceRole;
  lastLoginAt: string | null;
  joinedAt: string;
};
export type MembersResponse = {
  members: Member[];
  invitations: { id: string; email: string; role: WorkspaceRole; expiresAt: string; expired: boolean; createdAt: string }[];
};

/** GET /workspaces/:id/notifications — apps/api/src/notifications/notifications.service.ts */
export type Notification = {
  id: string;
  type: string;
  title: string;
  body: string;
  link: string;
  readAt: string | null;
  createdAt: string;
};
export type NotificationsResponse = { items: Notification[]; unread: number };

/** GET /auth/sessions */
export type SessionRow = {
  id: string;
  ip: string;
  userAgent: string;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
};

/** GET /auth/2fa */
export type TwoFactorStatus = {
  enabled: boolean;
  enabledAt: string | null;
  recoveryCodesRemaining: number;
  /** Workspaces the person belongs to that require two-factor. */
  requiredBy: { id: string; name: string }[];
};

/** POST /auth/2fa/setup */
export type TwoFactorSetup = { secret: string; otpauthUri: string; qrSvg: string };

/** GET/PUT /workspaces/:id/security */
export type WorkspaceSecurity = {
  requireTwoFactor: boolean;
  canChange: boolean;
  membersWithoutTwoFactor: { id: string; name: string; email: string; role: WorkspaceRole }[];
};

/** GET /invitations/:token */
export type InvitationInfo = { email: string; role: WorkspaceRole; workspaceName: string; accountExists: boolean };

/** A page of rows — the list endpoints' common shape (ListQuery: page, pageSize, sort, dir). */
export type Paged<T> = { items: T[]; total: number; page: number; pageSize: number };

/** The minimal contact shape the pickers read from GET /workspaces/:id/contacts. */
export type ContactSummary = {
  id: string;
  fullName: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  company: { id: string; name: string; domain: string | null } | null;
};

/** GET /workspaces/:id/tasks/summary — apps/api/src/tasks/tasks.service.ts `summary()` */
export type TaskSummary = {
  counts: { today: number; overdue: number; upcoming: number };
  unansweredReplies: {
    id: string;
    channel: string;
    subject: string;
    displayName: string;
    handle: string;
    lastInboundAt: string | null;
    contact: { id: string; fullName: string | null } | null;
  }[];
  noNextAction: { id: string; fullName: string | null; email: string | null; status: string }[];
  upcomingMeetings: { id: string; title: string; startsAt: string; contact: { id: string; fullName: string | null } | null }[];
  inactiveDeals: { id: string; name: string; updatedAt: string; value: number; currency: string }[];
};
