import { z } from "zod";

/*
 * The public unsubscribe flow (no sign-in): what the page at
 * /unsubscribe/:token shows, and the body of POST /t/u/:token.
 *
 * The same POST serves RFC 8058 one-click unsubscribe, where the mail
 * provider sends `List-Unsubscribe=One-Click` (form-encoded or multipart, so
 * the body may arrive empty), and the page's confirm button, which says
 * `{ via: "page" }` so the contact's timeline can tell the two apart.
 */
export const UnsubscribeInput = z.object({
  via: z.enum(["page"]).optional(),
  "List-Unsubscribe": z.string().max(100).optional(),
});

/** What the unsubscribe page shows before the person confirms. */
export type UnsubscribeDetails = {
  /** The address the email was sent to — the one that will stop receiving mail. */
  email: string;
  senderName: string;
  senderEmail: string;
  workspaceName: string;
  /** The address (or its domain) is already on the workspace's do-not-contact list. */
  suppressed: boolean;
};

export type UnsubscribeResult = {
  email: string;
  workspaceName: string;
  /** False when the address was already unsubscribed before this request. */
  changed: boolean;
};
