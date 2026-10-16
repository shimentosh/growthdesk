/*
 * Shapes of the workspace-administration, billing and account endpoints.
 * Keep these in step with the API services named in each comment. The
 * foundation's shared shapes (Member, MembersResponse, SessionRow,
 * InvitationInfo, WorkspaceDetail) live in src/lib/types.ts.
 */
import type { BillingInterval, LimitKey, PlanFeatures, SubscriptionStatus, WorkspaceRole } from "@growthdesk/shared";

export type InvitationRow = { id: string; email: string; role: WorkspaceRole; expiresAt: string; expired: boolean; createdAt: string };

/** POST /workspaces/:id/invitations — workspaces.service.ts `invite()` */
export type InviteResult = { id: string; email: string; role: WorkspaceRole; expiresAt: string };

/** POST /workspaces/:id/invitations with `emails` — `inviteMany()` */
export type InviteOutcome = { email: string; status: "invited" | "already_member" | "already_invited" | "no_seat" | "invalid"; invitationId?: string };
export type BulkInviteResult = { results: InviteOutcome[] };

/** PATCH /workspaces/:id/members/:id — `changeRole()` */
export type ChangeRoleResult = { id: string; role: WorkspaceRole; deactivatedAt?: string | null };

export type EditableRole = Exclude<WorkspaceRole, "owner">;

/** PUT /workspaces/:id/role-permissions — `setRolePermissions()` */
export type RolePermissionsResult = { role: EditableRole; permissions: string[]; isDefault: boolean; defaults: string[] };

/** One row of GET /workspaces/:id/audit — `auditLog()` (the AuditEvent row plus its actor). */
export type AuditEventRow = {
  id: string;
  workspaceId: string | null;
  actorUserId: string | null;
  /** user | platform_admin | api_key | system */
  actorType: string;
  action: string;
  targetType: string;
  targetId: string;
  metadata: Record<string, unknown>;
  ip: string;
  createdAt: string;
  actor: { id: string; name: string; email: string } | null;
};

/** GET /workspaces/:id/support-access — the active SupportAccessGrant row, or null. */
export type SupportGrant = {
  id: string;
  workspaceId: string;
  grantedById: string;
  reason: string;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
};

/** GET /plans — billing.service.ts `publicPlans()`. limits/features are the stored JSON (read with readLimits/readFeatures). */
export type PublicPlan = {
  key: string;
  name: string;
  description: string;
  currency: string;
  monthlyPriceCents: number;
  annualPriceCents: number;
  trialDays: number;
  limits: unknown;
  features: unknown;
};

export type BillingInvoice = {
  id: string;
  number: string;
  status: string;
  currency: string;
  amountDueCents: number;
  amountPaidCents: number;
  hostedUrl: string;
  pdfUrl: string;
  issuedAt: string;
  paidAt: string | null;
};

/** GET /workspaces/:id/billing — billing.service.ts `overview()` */
export type BillingOverview = {
  /** account = the billing account owner (invoices, details, usage across workspaces); workspace = this workspace only. */
  scope: "account" | "workspace";
  /** When the monthly allowances next restart (the billing day). */
  meterResetsAt: string;
  account: { id: string; name: string; billingEmail: string; country: string; taxId: string; address: string };
  plan: { key: string; name: string };
  effectivePlan: { key: string; name: string };
  subscription: {
    status: SubscriptionStatus;
    interval: BillingInterval;
    /** none | stripe | manual */
    provider: string;
    currentPeriodEnd: string | null;
    trialEndsAt: string | null;
    cancelAtPeriodEnd: boolean;
    graceUntil: string | null;
    managedByProvider: boolean;
  } | null;
  access: "full" | "restricted";
  reason: string;
  usage: Record<LimitKey, { used: number; limit: number; label: string }>;
  features: PlanFeatures;
  invoices: BillingInvoice[];
  payments: { available: boolean; provider: string | null };
  plans: PublicPlan[];
};

/** POST /workspaces/:id/billing/checkout — a hosted checkout URL, or an in-place price change. */
export type CheckoutResult = { changed: true; url: null } | { changed: false; url: string };

/** POST /workspaces/:id/billing/cancel | resume */
export type CancelResult = { pending: boolean };

/** POST /invitations/:token/accept | register */
export type JoinResult = { workspaceId: string };
