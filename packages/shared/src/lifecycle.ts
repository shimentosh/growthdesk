import { z } from "zod";
import { requiredText, text } from "./schemas.js";

/*
 * Account lifecycle and GDPR requests (docs/PRIVACY_OPS.md): deleting and
 * restoring a workspace, transferring ownership, closing a personal account,
 * full workspace exports and per-contact export and erasure.
 */

/** Deleting a workspace: the owner types its name exactly to confirm. */
export const DeleteWorkspaceInput = z.object({ confirmName: requiredText(200) });

/** The new owner is an existing member, named by membership id. */
export const TransferOwnershipInput = z.object({ membershipId: z.string().uuid() });

/** Closing one's own account: the email address typed out, plus the password when the account has one. */
export const CloseAccountInput = z.object({
  confirmEmail: z.string().trim().toLowerCase().min(1, "Required").max(254),
  password: z.string().max(200).optional(),
});

/** Accepting the Terms and Privacy Policy after the fact (Google sign-ups and older accounts). */
export const AcceptTermsInput = z.object({ accept: z.literal(true, { error: "Tick the box to accept the Terms and Privacy Policy." }) });

/** Erasing a contact: "ERASE" typed out, so it is never a stray click. */
export const EraseContactInput = z.object({
  confirm: z.literal("ERASE", { error: 'Type ERASE to confirm.' }),
  /** Kept in the audit log, e.g. "Email request of 12 Oct". Never personal data. */
  reason: text(300).optional(),
});

/** Platform admin deleting a workspace on a customer's behalf. */
export const AdminDeleteWorkspaceInput = z.object({ reason: requiredText(500) });

export const WORKSPACE_EXPORT_STATUSES = ["pending", "processing", "ready", "failed", "expired"] as const;
export type WorkspaceExportStatus = (typeof WORKSPACE_EXPORT_STATUSES)[number];
