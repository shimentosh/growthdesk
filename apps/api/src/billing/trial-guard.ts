/*
 * Free-trial abuse checks (docs/GAP_PLAN.md §3.1.9). A trial is granted once
 * per person, and only TRIALS_PER_IP_PER_DAY times a day from one IP address
 * (WorkspacesService.create applies both).
 *
 * "Once per person" compares a normalised key, never the stored address:
 * login keeps using the email exactly as the user typed it. The key is
 * lower-case with any +tag removed, and for Gmail (whose mailboxes ignore
 * dots, and where googlemail.com is the same mailbox) the dots are removed
 * and the domain unified. Other providers are left alone, since dots can be
 * significant there. The same rule backfills existing accounts in migration
 * 20261012160000_billing_correctness.
 */

const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

export function trialEmailKey(email: string): string {
  const lower = email.trim().toLowerCase();
  const at = lower.lastIndexOf("@");
  if (at < 1) return lower;
  let local = lower.slice(0, at).split("+")[0]!;
  let domain = lower.slice(at + 1);
  if (GMAIL_DOMAINS.has(domain)) {
    local = local.replace(/\./g, "");
    domain = "gmail.com";
  }
  return `${local}@${domain}`;
}
