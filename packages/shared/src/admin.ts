import { z } from "zod";
import { PLATFORM_ROLES, SUBSCRIPTION_STATUSES } from "./enums.js";
import { PlanAdminInput, requiredText, uuid } from "./schemas.js";
import { PLATFORM_EMAIL_STATUSES, PLATFORM_EMAIL_STREAMS, PLATFORM_MAIL_PROVIDERS } from "./platform-email-admin.js";

/*
 * Platform super-admin inputs (apps/api/src/admin). The older platform-admin
 * schemas — PlanAdminInput, AdminAssignPlanInput, SuspendInput,
 * SupportCaseInput, PlatformSettingsInput — live in schemas.ts and are reused
 * as they are.
 */

const page = z.coerce.number().int().min(1).default(1);
const pageSize = z.coerce.number().int().min(1).max(200).default(50);
const search = z.string().trim().max(200).optional();

export const SUPPORT_CASE_STATUSES = ["open", "pending", "closed"] as const;
export type SupportCaseStatus = (typeof SUPPORT_CASE_STATUSES)[number];
export const SUPPORT_CASE_PRIORITIES = ["low", "normal", "high"] as const;
export type SupportCasePriority = (typeof SUPPORT_CASE_PRIORITIES)[number];

export const AdminUsersQuery = z.object({
  page,
  pageSize,
  q: search,
  role: z.enum(PLATFORM_ROLES).optional(),
  /** "staff" = any platform role above none. */
  scope: z.enum(["all", "staff", "disabled"]).default("all"),
});

export const AdminDisableUserInput = z.object({ reason: requiredText(500) });

export const AdminSetPlatformRoleInput = z.object({ role: z.enum(PLATFORM_ROLES) });

export const AdminWorkspacesQuery = z.object({
  page,
  pageSize,
  q: search,
  status: z.enum(["active", "suspended"]).optional(),
});

export const AdminBillingAccountsQuery = z.object({
  page,
  pageSize,
  q: search,
  /** A subscription status, or "none" for accounts without one. */
  status: z.enum([...SUBSCRIPTION_STATUSES, "none"]).optional(),
});

/** Editing an existing plan: everything PlanAdminInput holds except its key, which subscriptions refer to. */
export const AdminPlanUpdateInput = PlanAdminInput.omit({ key: true });

export const AdminAuditQuery = z.object({
  page,
  pageSize,
  workspaceId: uuid.optional(),
  actorUserId: uuid.optional(),
  /** Matches the start of the action ("platform." finds every platform-admin action). */
  action: z.string().trim().max(100).optional(),
  actorType: z.enum(["user", "platform_admin", "api_key", "system"]).optional(),
});

export const AdminSupportCasesQuery = z.object({
  page,
  pageSize,
  q: search,
  status: z.enum(SUPPORT_CASE_STATUSES).optional(),
  workspaceId: uuid.optional(),
});

/** A case staff open on a customer's behalf (from an email, a call, a chat). */
export const AdminSupportCaseCreateInput = z.object({
  subject: requiredText(200),
  body: requiredText(10000),
  priority: z.enum(SUPPORT_CASE_PRIORITIES).default("normal"),
  workspaceId: uuid.nullable().optional(),
  /** The customer's account email; must belong to an existing user when given. */
  userEmail: z.union([z.string().trim().toLowerCase().email("Enter a valid email address").max(254), z.literal("")]).optional(),
});

export const AdminSupportCaseUpdateInput = z
  .object({
    status: z.enum(SUPPORT_CASE_STATUSES).optional(),
    priority: z.enum(SUPPORT_CASE_PRIORITIES).optional(),
    assigneeId: uuid.nullable().optional(),
  })
  .refine((v) => v.status !== undefined || v.priority !== undefined || v.assigneeId !== undefined, "Nothing to change");

export const AdminSupportNoteInput = z.object({ body: requiredText(10000) });

export const AdminEmailLogQuery = z.object({
  page,
  pageSize,
  q: search,
  /** Any EmailLog status (platform-email-admin.ts); "sent"/"failed" as before. */
  status: z.enum(PLATFORM_EMAIL_STATUSES).optional(),
  template: z.string().trim().max(60).optional(),
  stream: z.enum(PLATFORM_EMAIL_STREAMS).optional(),
  provider: z.enum(PLATFORM_MAIL_PROVIDERS).optional(),
  userId: uuid.optional(),
});

/** Reading a workspace's records under a support access grant. */
export const AdminSupportViewQuery = z.object({
  page,
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  q: search,
});
