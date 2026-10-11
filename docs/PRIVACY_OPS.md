# Privacy operations

How Growthdesk handles account deletion, data exports and data-subject requests, and what an operator does
when something goes wrong. This is an operations document, not legal text: the Terms of Service and Privacy
Policy are written and published from platform admin → Website, and a DPA or records of processing are the
operator's own documents.

Code: `apps/api/src/lifecycle/` (services, controller, the `lifecycle` queue processor).
Tests: `apps/api/test/lifecycle.e2e-spec.ts`.

## Consent at sign-up

- Every form that creates an account (register, accepting a workspace invitation) has a required
  "I agree to the Terms of Service and Privacy Policy" box. The API refuses the sign-up without
  `acceptTerms: true`.
- `User.termsAcceptedAt` and `User.termsVersion` record when, and which published text. The version is the
  publish time of the newer of the two legal pages (`publishedAt` of `legal.terms` / `legal.privacy`), or
  `default` while both still show the built-in text (`apps/api/src/lifecycle/terms.ts`).
- Google sign-ups skip the form, so the app asks once on first use (`TermsGate`, `POST /v1/account/terms`).
  Accounts created before this existed are asked the same way.
- Publishing new legal text does not ask people again. If a change needs fresh consent, plan that separately.

## Retention

| Data | Kept until |
|---|---|
| Workspace records (contacts, deals, messages, …) | The workspace is deleted and purged, or a member deletes them. A lapsed subscription never deletes data (docs/BILLING.md). |
| Deleted workspace | `WORKSPACE_PURGE_DAYS` (default 30) after deletion, then hard-deleted by the purge job. |
| Erased contact | Deleted at once. Only a keyed hash of each address and number stays on the suppression list. |
| Workspace export file | `DATA_EXPORT_DAYS` (default 7), then deleted by the daily cleanup. The row stays as `expired`. |
| Closed account | The `User` row stays (invoices and audit rows point at it) with name, email, password, Google link and avatar wiped. |
| Audit log | Kept. Rows hold actions, ids and IP addresses, not customer records. A workspace's audit rows outlive its purge. |
| Billing account, subscription, invoices | Kept for accounting, also after every workspace is purged. |
| Database backups | `BACKUP_RETAIN_DAYS` (default 14). Purged or erased data stays in older dumps until they rotate out, and a restore brings it back: after a restore, re-run any deletion and erasure done since that dump (see the audit log). |

Operational tables (sessions, tokens, finished webhook deliveries, read notifications) are pruned by the
daily `cleanup` job (`apps/api/src/worker/maintenance-policy.ts`).

## Deleting a workspace

1. The owner opens Settings → Data & privacy → Delete workspace and types the name
   (`POST /v1/workspaces/:id/delete`). Only the `owner` role can, whatever the role permissions say.
   Platform admin can do it for a customer with a reason (`POST /v1/admin/workspaces/:id/delete`).
2. At once: `deletedAt` and `purgeAfter` are set, and the workspace is marked suspended. Every request for
   it answers 404, API keys stop working, it leaves the workspace switcher and stops counting against the plan.
   Running and scheduled campaigns (outreach and marketing) pause; every sending path already refuses a
   suspended workspace. Pending invitations are revoked. Members are emailed with the purge date.
3. If it was the billing account's last workspace, the subscription is cancelled through
   `BillingService.cancelAccount`: at period end for Stripe (no renewal), immediately for trials and manual
   plans. If Stripe refuses, the deletion stops with a 503 so a deleted customer is never charged again.
4. Platform admin → Workspaces → (filter Deleted) → Restore brings it back until `purgeAfter`
   (`POST /v1/admin/workspaces/:id/restore`). Campaigns stay paused. A cancelled subscription is not
   resumed automatically.
5. The `lifecycle/purge-sweep` job (hourly at :20 UTC) purges workspaces past `purgeAfter`: every tenant
   table in `PURGE_ORDER` (`apps/api/src/lifecycle/purge.ts`), 2,000 rows per statement, then the export
   files, then the workspace row (which cascades memberships, invitations, usage counters, API keys and
   support grants). Each batch commits on its own, so a stopped purge resumes on the next run. A unit test
   keeps `PURGE_ORDER` equal to the tenant guard's model list. A `workspace.purged` audit row records it.

## Transferring ownership

Settings → Data & privacy → Transfer ownership (`POST /v1/workspaces/:id/transfer-ownership`, owner only).
The new owner must be a verified, enabled member; the old owner becomes an admin. When the billing account
holds no other workspace, it moves to the new owner too (and its billing email, if it was the old owner's).
The Stripe customer and card stay as they are; the new owner changes them in Plan & billing. A billing
account with several workspaces stays with its owner; support moves it if needed.

## Closing an account

Account → Close account (`POST /v1/account/close`, typed email plus password when the account has one).
Refused while the person owns a workspace that is not deleted, or a billing account that still pays for one.
Otherwise: they leave every workspace (records stay, unassigned), their identity is erased
(`eraseUserIdentity`, shared with platform admin's "Delete & anonymise"), all sessions end, the API keys
they created are revoked, and a confirmation goes to the old address first. Platform staff accounts are
closed by a platform owner instead. Account → Your data downloads a JSON copy of what the platform holds
about the person themselves (`GET /v1/account/export`).

Platform admin: Users → Delete & anonymise (owner rank) does the same erasure for someone else;
Disable / Enable suspends and restores sign-in without erasing anything. An anonymised account cannot be
restored.

## Data exports

- Settings → Data & privacy → Request export (`POST /v1/workspaces/:id/exports`, permission `data.export`).
- The worker writes one gzipped JSON document, `DATA_EXPORT_DIR/<workspaceId>/<exportId>.json.gz`, streaming
  each section page by page. Sections: members, companies, contacts (with identifiers, sources, tags, custom
  fields), notes, activities, consent history, suppressions, pipelines, deals, meetings, tasks, calls, call
  scripts, conversations, message metadata (no bodies), templates, sequences, campaigns, enrollments,
  marketing lists, designs and campaigns, workflows, imports. Mailboxes, channel connections, sending
  domains, the email service and webhooks are left out: they hold sealed credentials.
- The requester gets a bell notification and an email linking to the settings page. The file is served only
  by `GET /v1/workspaces/:id/exports/:exportId/download` (signed-in member with `data.export`), until
  `expiresAt`. The daily `lifecycle/export-cleanup` job (04:00 UTC) deletes expired files.
- No S3 or other object store is needed. In the compose stack, `exports-data` is mounted at
  `/app/.data/exports` in both `api` and `worker`; if you run them on different hosts, they need a shared
  filesystem at `DATA_EXPORT_DIR`.

## Data-subject requests for one person

On the contact's page → Privacy:

- **Export their data (JSON)** (`GET /v1/workspaces/:id/contacts/:contactId/privacy-export`, permission
  `contacts.export`): the contact, records merged into it, identifiers, sources, tags, notes, activity,
  consent history, suppression entries, deals, tasks, meetings, calls, enrollments, list memberships,
  marketing sends, and conversations with full message bodies.
- **Erase their data** (`POST /v1/workspaces/:id/contacts/:contactId/erase`, permission `contacts.erase`,
  `ERASE` typed out): hard-deletes the contact and the contacts merged into it, their conversations and
  messages (also threads held with one of their addresses), calls, contact events and duplicate
  suggestions; everything else hanging off the contact cascades. Deals, tasks and meetings stay, unlinked.
  Plain suppression rows for their addresses are replaced by `erased:<hmac>` rows: an HMAC-SHA-256 of the
  workspace id and the normalised address or number, under a key derived from `ENCRYPTION_KEY`. The
  outreach send paths check it (`SuppressionService.check`), and every contact create refuses it
  (`ContactsService.upsert` → 409 `erased_contact`, so imports, the API, forms and inbound mail cannot
  re-create them). The audit row (`contact.erased`) holds counts and the reason, no personal data.
- Requests from someone who is a Growthdesk user (not a contact) are handled with Close account or platform
  admin's Delete & anonymise.

`contacts.erase` is held by owners and admins by default; it can be granted to other roles in Roles &
permissions.

## Incident runbook (outline)

For a suspected personal-data breach. Fill in names, contacts and the regulator for your installation.

1. **Detect and record.** Open an incident record: who noticed what, when, and how. Keep a timeline from the
   first minute.
2. **Contain.** Depending on the cause: turn on maintenance mode (platform admin → Settings), disable the
   affected users or suspend workspaces, revoke sessions (platform admin → user → Sign out), revoke API
   keys, rotate leaked provider secrets (Stripe, SMTP, OAuth clients). `ENCRYPTION_KEY` cannot be rotated
   yet (GAP_PLAN 2.11): if it leaked, every sealed mailbox credential must be treated as exposed and
   reconnected.
3. **Preserve evidence.** Take a database dump before changing data. Export the audit log
   (`AuditEvent`) and container logs for the window.
4. **Assess.** Which workspaces and people, which data categories, how many records, and the likely
   consequences. The audit log shows who did what from which IP address.
5. **Notify.** The supervisory authority within 72 hours of becoming aware, where the law requires it.
   Workspace owners (our customers, who are the controllers for their contacts) without undue delay, with
   what they need to inform their own contacts.
6. **Recover and fix.** Restore from backup if data was destroyed (then re-run deletions and erasures done
   since the dump), fix the cause, and add a test.
7. **Review.** A written post-incident review within two weeks: timeline, impact, root cause, and actions
   with owners.
