import { QUEUES, type Queues } from "../queues/queues.js";

/*
 * Double opt-in, the parts with no Nest dependencies: the CRM import and the
 * workflow engine queue confirmations from here without importing the
 * marketing services (DoubleOptInService does the sending).
 */

/** A pending member gets at most one confirmation email in this window, however often they are re-added. */
export const CONFIRM_RESEND_MS = 24 * 60 * 60_000;

/**
 * Queues one confirmation email per pending membership. Call it after the
 * memberships are committed; `delayMs` covers callers still inside a
 * transaction (the worker skips a membership it cannot see yet). The job id
 * collapses repeats while one is waiting; the worker enforces the 24 h rule.
 */
export async function queueConfirmations(queues: Queues, workspaceId: string, membershipIds: string[], delayMs = 0) {
  for (const membershipId of membershipIds) {
    await queues.add(QUEUES.marketing, "confirm", { workspaceId, membershipId }, { jobId: `mk-confirm-${membershipId}`, attempts: 4, removeOnComplete: true, removeOnFail: 100, ...(delayMs ? { delay: delayMs } : {}) });
  }
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export type ConfirmationEmailInput = {
  workspaceName: string;
  listName: string;
  email: string;
  confirmUrl: string;
  legalName: string;
  postalAddress: string;
};

/** The confirmation email: who is asking, for which list, one button, and what to do if it was not them. */
export function confirmationEmail(i: ConfirmationEmailInput): { subject: string; html: string; text: string } {
  const sender = i.workspaceName || i.legalName;
  const subject = `Confirm your subscription to ${i.listName}`.replace(/[\r\n]+/g, " ").slice(0, 200);
  const footer = [i.legalName || i.workspaceName, i.postalAddress].filter((s) => s.trim()).join(" · ");
  const font = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f4f5">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f4f5"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background:#ffffff;border-radius:12px">
<tr><td style="padding:32px 32px 8px;font-family:${font};color:#18181b">
<p style="margin:0 0 8px;font-size:13px;color:#71717a">${esc(sender)}</p>
<h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;font-weight:700">Confirm your subscription</h1>
<p style="margin:0 0 16px;font-size:16px;line-height:1.5">Please confirm that <strong>${esc(i.email)}</strong> should receive <strong>${esc(i.listName)}</strong> from ${esc(sender)}.</p>
</td></tr>
<tr><td align="center" style="padding:8px 32px 24px">
<a href="${esc(i.confirmUrl)}" style="display:inline-block;background:#18181b;color:#ffffff;font-family:${font};font-size:16px;font-weight:600;line-height:1;text-decoration:none;padding:14px 28px;border-radius:8px">Confirm subscription</a>
</td></tr>
<tr><td style="padding:0 32px 32px;font-family:${font};font-size:14px;line-height:1.5;color:#52525b">
<p style="margin:0">If you didn't ask to join this list, ignore this email — you won't be subscribed and won't hear from us again about it.</p>
</td></tr>
</table>
${footer ? `<p style="margin:16px 0 0;font-family:${font};font-size:12px;line-height:1.5;color:#a1a1aa">${esc(footer)}</p>` : ""}
</td></tr></table>
</body></html>`;
  const text = [
    sender,
    "",
    `Please confirm that ${i.email} should receive ${i.listName} from ${sender}:`,
    i.confirmUrl,
    "",
    "If you didn't ask to join this list, ignore this email — you won't be subscribed and won't hear from us again about it.",
    ...(footer ? ["", footer] : []),
  ].join("\n");
  return { subject, html, text };
}
