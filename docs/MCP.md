# Growthdesk — MCP (Claude and other AI clients)

Growthdesk is an MCP server (Model Context Protocol), so Claude — Claude Code, Claude Desktop,
claude.ai — and other MCP clients (Cursor, …) can work in a workspace: look up contacts, build
lists, draft campaigns, read the inbox, and, with the person's approval in the chat, send and
launch. Everything lives in `apps/api/src/mcp`; the settings page is
`apps/web/src/app/w/[workspaceId]/settings/mcp/page.tsx` (Settings → Developers → **MCP / Claude**).

## The endpoint

```
POST {PUBLIC_API_URL}/mcp          when the API has its own public URL (e.g. https://api-growthdesk.sentosh.com/mcp)
POST {PUBLIC_APP_URL}/api/mcp      otherwise, through the web app's proxy
```

The settings page shows the right one (the API computes it: `McpAuthService.endpointUrl()`).

- Streamable HTTP, **stateless**: a new server and transport per POST, no `Mcp-Session-Id`, JSON
  responses. Any API instance answers any request. `GET` and `DELETE` answer **405**.
- `/mcp` is outside the `/v1` prefix (`app.setup.ts`); the web proxy maps `/api/mcp` to it.
- CORS: any origin, `Authorization` allowed, no credentials (`mcp-cors.ts`). Cookies never
  authenticate MCP.
- Authentication: `Authorization: Bearer gdm_…` (a personal token, or an OAuth access token). A
  refusal is **401** with `WWW-Authenticate: Bearer realm="growthdesk", resource_metadata="…"`
  (where OAuth discovery starts); a plan without API access is **402**, a suspended workspace **423**.

## Connecting a client

Create a token under Settings → MCP / Claude. The token is shown once, together with these
snippets filled in:

**Claude Code**

```sh
claude mcp add --transport http growthdesk <URL> --header "Authorization: Bearer <token>"
```

**Claude Desktop** (its config starts local stdio servers; `mcp-remote` bridges to HTTP). Settings →
Developer → Edit Config, then restart:

```json
{
  "mcpServers": {
    "growthdesk": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "<URL>", "--header", "Authorization:${GROWTHDESK_AUTH}"],
      "env": { "GROWTHDESK_AUTH": "Bearer <token>" }
    }
  }
}
```

(The header goes through an env var because Desktop splits arguments on spaces on some systems.)

**Cursor** — `~/.cursor/mcp.json`:

```json
{ "mcpServers": { "growthdesk": { "url": "<URL>", "headers": { "Authorization": "Bearer <token>" } } } }
```

**claude.ai** — Settings → Connectors → Add custom connector, paste the URL, and sign in to
Growthdesk ("Connect with your Growthdesk login"). No token: OAuth 2.1, see
[OAuth / claude.ai](#oauth--claudeai) below. Claude Code can sign in the same way
(`claude mcp add --transport http growthdesk <URL>`, no header).

## Tokens and access levels

A token is **personal**: it acts as the person who created it, in one workspace. Every request
re-checks that the token is not revoked or expired, the person is not suspended or closed and is
still a member, the workspace is active, its two-factor and email-verification requirements are
met, and the plan includes **API access** (Starter, Growth, Agency by default).

What the token may do is the person's role, narrowed by the token's access level
(`mcpPermissions` in `packages/shared/src/mcp.ts`):

| Access level | Permissions held | Tools it can call |
| --- | --- | --- |
| **Read only** | the role's `*.read` permissions and `records.view_all` | read tools |
| **Build** (drafts, no sending) | the role's permissions except `MCP_SEND_PERMISSIONS` | read and write tools; can *prepare* important actions |
| **Build + Send** | all of the role's permissions | everything; confirms important actions |

`MCP_SEND_PERMISSIONS`: `campaigns.launch`, `marketing.send`, `marketing.manage`, `inbox.reply`,
`calls.make`, `contacts.delete`, `contacts.erase`, `contacts.export`, `deals.delete`, `data.export`,
`integrations.manage`, `members.manage`, `settings.manage`, `billing.manage`, `apikeys.manage`,
`webhooks.manage`.

Ownership scopes still apply: without `records.view_all` a person sees their own (and unowned)
records through MCP exactly as in the app. Audit events written through MCP are recorded as the
person, with `metadata.via = "MCP: <token name>"` and `metadata.mcpTokenId`.

Anyone in the workspace may create tokens for themselves (up to 20 active) and revoke their own.
Holders of `apikeys.manage` (owners, admins) see and revoke everyone's and see everyone's activity.
Only a SHA-256 digest is stored. Revoking is immediate and cancels what the token had prepared.

Each token may make **120 tool calls a minute** (`MCP_CALLS_PER_MINUTE`).

## The confirmation rule

"Take permission from me at important places": a tool marked `risk: "important"` (sending,
scheduling, launching, pausing, stopping, deleting, spending allowances) **never acts when called**.

1. The tool validates its arguments and runs its `preview()` — who, what, how many, what it costs.
2. The arguments and preview are stored as a `McpPendingAction`; the result says
   `CONFIRMATION NEEDED — nothing has happened yet`, with the summary and a `confirmationId`.
3. The model shows the summary to the person and asks. The server instructions and the tool
   descriptions tell it never to confirm on the person's behalf.
4. On a yes, the client calls **`confirm_action { confirmationId }`**, which:
   - refuses unless the token is **Build + Send** ("this token can't send — create a Send token…");
   - refuses unless it is the token that prepared the action, within **10 minutes**, not canceled;
   - re-checks the tool's permission against the person's current role and re-validates the stored
     arguments;
   - claims the action atomically (it runs **exactly once**), runs the tool's `handler`, stores the
     result, and writes an `mcp.action_confirmed` audit event.

`cancel_action` drops a prepared action; `list_pending_actions` lists this token's open ones. The
settings page shows actions waiting for confirmation and can cancel them.

A Build token can prepare important actions (so Claude can line up a campaign for review) but never
carry them out.

## Built-in tools

| Tool | Risk | What it does |
| --- | --- | --- |
| `whoami` | read | person, workspace, role, token access, plan, permissions |
| `workspace_overview` | read | counts: contacts/leads, open deals, lists, marketing campaigns by status, outreach campaigns by status, open/overdue tasks, unread inbox |
| `list_workspaces` | read | the person's workspaces (informational — a token stays in its own) |
| `confirm_action` | (special) | carries out a prepared important action — Send tokens only |
| `cancel_action` | write | drops a prepared action |
| `list_pending_actions` | read | prepared actions awaiting confirmation |

Also a prompt (`growthdesk_status`) and a resource (`growthdesk://guide`).

## Adding tools (for developers)

One file per domain in `apps/api/src/mcp/tools/`, exporting an array; add **one import line** and
one spread to `tools/index.ts`. Nothing else in the framework changes.

```ts
// apps/api/src/mcp/tools/contacts.tools.ts
import { z } from "zod";
import { ContactsService } from "../../crm/contacts.service.js";
import { defineTool, pageInput, paged } from "../tool.js";

export const CONTACT_TOOLS = [
  defineTool({
    name: "search_contacts",
    title: "Search contacts",
    description: "Find contacts by name, email or company. Returns ids for the other contact tools.",
    input: z.object({ search: z.string().trim().max(200).optional(), ...pageInput }),
    permission: "contacts.read",
    risk: "read",
    handler: async (ctx, args, deps) => {
      const r = await deps.get(ContactsService).list(ctx, { q: args.search, page: args.page, pageSize: args.limit });
      return paged(r.items.map((c) => ({ id: c.id, name: c.fullName, email: c.email })), r.total, args.page, args.limit);
    },
  }),
  defineTool({
    name: "delete_contact",
    title: "Delete a contact",
    description: "Deletes one contact.",
    input: z.object({ contactId: z.string().uuid() }),
    permission: "contacts.delete",
    risk: "important",
    preview: async (ctx, args, deps) => {
      const c = await deps.get(ContactsService).find(ctx, args.contactId); // throws 404 → error result
      return { summary: `Delete ${c.fullName} <${c.email}> and their timeline.`, details: { contactId: c.id } };
    },
    handler: async (ctx, args, deps) => deps.get(ContactsService).remove(ctx, args.contactId),
  }),
];
```

```ts
// apps/api/src/mcp/tools/index.ts
import { CONTACT_TOOLS } from "./contacts.tools.js";
export const MCP_TOOLS: McpTool[] = [...CORE_TOOLS, ...CONTACT_TOOLS];
```

(The service method names above are illustrative — use the real ones.)

The contract (`apps/api/src/mcp/tool.ts`):

- `defineTool({ name, title, description, input, output?, permission, risk, idempotent?, annotations?, handler, preview? })`.
  `handler(ctx, args, deps)` gets `args` already parsed by `input`.
- `ctx` is an ordinary `RequestContext` acting as the person (`identity`, `workspace` with the
  narrowed permissions, plus `ctx.mcp`) — pass it straight to services, which keep applying their own
  permission, ownership, plan-limit and audit rules.
- `deps.get(SomeService)` resolves any Nest provider (ModuleRef, `strict: false`) — **call services,
  never HTTP**. `deps.prisma` is there for simple counts.
- `permission`: any one of the listed permissions, like `@Permission()`; `null` for any member.
  Use the same permission the matching HTTP route uses.
- `risk`: `read` (no changes), `write` (creates/edits — drafts, records), `important` (sends,
  launches, deletes, spends — needs `preview`). When unsure, choose `important`. `preview` may
  return `args` to store resolved arguments (e.g. names → ids).
- Results: return any JSON-able value (sent as pretty JSON, cut at 24,000 characters) or
  `reply(text, data?)`. Keep them small — pick the fields the model needs. Declare `output` (a
  `z.object`) only if the result always has that shape; it is then sent as `structuredContent`.
- Lists: spread `pageInput` (`page`, `limit` ≤ 50) into the input and return `paged(items, total, page, limit)`.
- Errors: throw `ApiError`s (`badRequest`, `notFound`, `forbidden`, `limitReached`, …) as the
  services already do; they become `isError` results with the message and field errors. Anything
  else is logged (and sent to Sentry) and the model sees only "Something went wrong".
- Annotations are derived from `risk` (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `title`);
  override with `annotations`.
- Prompts and resources: `definePrompt` / `defineResource`, listed in `MCP_PROMPTS` / `MCP_RESOURCES`.
- `src/mcp/registry.spec.ts` checks every tool (snake_case unique names, object input, important
  tools have a preview); the API also refuses to start with a broken or duplicate tool.

Zod: the repo's zod 4 is converted with `z.toJSONSchema` (`io: "input"`) and the low-level SDK
`Server` is used, so no SDK/zod version coupling. Avoid `z.transform`/`z.preprocess` at the top of
an input where the JSON Schema matters; `.default()` and `.describe()` carry through.

## Data and retention

| Table | What | Kept |
| --- | --- | --- |
| `McpToken` | personal tokens (and OAuth-issued ones) | until the workspace or person goes |
| `McpPendingAction` | prepared important actions | 30 days past expiry (worker `cleanup`) |
| `McpCall` | one row per tool call: tool, ok, error, duration — never arguments or results | 90 days (`cleanup`) |
| `McpOAuthClient` / `McpOAuthCode` | OAuth clients and single-use codes | codes: a day past expiry |

`McpPendingAction` and `McpCall` are tenant-guarded and in the workspace purge order.

## Security notes

- A token is as powerful as its person's role (narrowed by its level). Treat it like a password;
  give each app its own token so one can be revoked alone. Set an expiry for experiments.
- Prompt injection: content Claude reads (emails, replies, contact notes) can contain instructions.
  The confirmation rule is the backstop — nothing that reaches people outside the workspace,
  deletes, or spends happens without the person's explicit yes in their own chat, and Build tokens
  cannot confirm at all. Prefer Build tokens for day-to-day drafting.
- Tokens cannot mint tokens: the token routes are session-only.
- Maintenance mode refuses everything but reads for non-staff, as in the app.

## Outreach tools

Cold email sequences and multichannel campaigns (`apps/api/src/mcp/tools/outreach/`), calling
`CampaignsService`, `SequencesService`, `TemplatesService`, `EnrollmentService`, `MailboxesService`
and `ChannelsService` with the controllers' permissions and shared schemas. Prompts:
`build_cold_sequence` (mailboxes → draft with `{{first_name|there}}` fallbacks → campaign, Always on
for inbound leads → readiness → test → launch with confirmation) and `outreach_report`.

| Tool | Risk | Permission |
| --- | --- | --- |
| `list_mailboxes` (status, daily limit, sent today, reply tracking, SPF/DKIM/DMARC/MX unless `checkDns: false`), `channel_status` | read | `integrations.read` |
| `list_templates`, `get_template` | read | `templates.read` |
| `create_template`, `update_template` | write | `templates.write` |
| `delete_template` (archives when steps use it) | important | `templates.write` |
| `get_step_reference` (step kinds, config, variables) | read | `campaigns.read` or `templates.read` |
| `list_sequences`, `get_sequence` | read | `campaigns.read` |
| `create_sequence`, `update_sequence`, `duplicate_sequence` | write | `campaigns.write` |
| `delete_sequence` | important | `campaigns.write` |
| `list_campaigns`, `get_campaign`, `campaign_readiness`, `campaign_health` | read | `campaigns.read` |
| `create_campaign`, `update_campaign_steps` / `_audience` / `_schedule` / `_settings`, `set_campaign_mailboxes`, `duplicate_campaign`, `send_test_step` | write | `campaigns.write` |
| `delete_campaign` | important | `campaigns.write` |
| `launch_campaign`, `resume_campaign`, `stop_campaign` | important | `campaigns.launch` |
| `pause_campaign` | write | `campaigns.launch` |
| `list_enrollments` | read | `campaigns.read` |
| `enroll_contacts` (ids or emails), `retry_enrollment`, `retry_failed_enrollments`, `stop_enrollment` | important | `campaigns.launch` |
| `pause_enrollment`, `resume_enrollment` | write | `campaigns.launch` |

Notes:

- `campaigns.launch` is a Send permission, so pausing (a plain write, it acts at once) needs a Send
  token; a Build token can still *prepare* launch/resume/stop/enroll for review.
- Previews state what the person needs to decide: for a launch, the eligible count and skip reasons,
  the sending mailboxes (or "any connected mailbox"), the step outline, the daily limit, gap, window and
  stop rules, Always on, the first send time and roughly how many sending days the starts take.
  `launch_campaign` refuses to prepare a campaign readiness says is not ready. `enroll_contacts`
  resolves emails with `ContactsService.resolve` in its preview and stores the resolved ids, so the
  confirmation enrolls exactly the people previewed.
- `send_test_step` (a write, as in the app) goes to the token's person by default, at most 5
  addresses, and only to workspace members' or the workspace's mailbox addresses — so content a
  model was tricked into writing cannot reach outsiders without a confirmation. Outside addresses:
  the campaign page.
- Nothing takes mailbox or channel credentials: connecting is in Settings → Mailboxes / Channels.
- Tested end to end in `apps/api/test/mcp-outreach.e2e-spec.ts`.

## CRM / sales / inbox / automation tools

Files: `apps/api/src/mcp/tools/{crm,sales,inbox,automation,reports}.tools.ts`. Each calls the same
service and needs the same permission as the matching HTTP route, so ownership scopes, plan limits,
dedupe and audit behave as in the app.

| Area | Read | Write | Important (confirmation) |
| --- | --- | --- | --- |
| Contacts / leads | `search_contacts` (q, stage lead/sales/contact, status, tag, owner, company, list, campaign…), `get_contact` (identifiers, company, deals, tasks, enrollments, lists, consent, recent timeline), `get_timeline` | `create_contact`, `update_contact`, `add_tags`, `remove_tags`, `assign_owner`, `set_lifecycle_stage` (optionally "hand to sales"), `archive_contact`, `add_note`, `import_leads` (≤ 200 rows, no campaign) | `delete_contact`, `bulk_update_contacts` (ids or a filter, ≤ 5000; the preview fixes the exact people), `import_leads_bulk` (≤ 2000 rows, optional enroll in a launched campaign) |
| Companies | `search_companies`, `get_company` | `create_company`, `update_company` | — |
| Deals | `list_pipelines`, `search_deals` (incl. `stuckDays`), `get_deal` | `create_deal`, `update_deal`, `move_deal_stage` (stage id or name), `mark_deal_won`, `mark_deal_lost` | `delete_deal` |
| Tasks, meetings, calls | `list_tasks` (today / overdue / upcoming / mine / team / completed / all), `sales_work_queue`, `list_meetings`, `list_calls` | `create_task`, `update_task`, `complete_task`, `create_meeting`, `update_meeting` | — |
| Inbox | `list_conversations` (unread, channel, status, assignee, campaign), `get_conversation` (plain text, quoted history trimmed) | `mark_read`, `assign_conversation`, `set_conversation_status` | `reply_to_conversation` (preview: channel, recipient, mailbox/sender, subject, the exact text) |
| Automation | `list_workflow_templates` (sales + marketing, from `packages/shared/src/workflows.ts`), `list_workflows`, `get_workflow` (with a plain-words explanation), `list_workflow_runs` | `create_workflow` (from a template with blanks filled, or a full definition — always created **off**), `update_workflow`, `disable_workflow`, `reject_workflow_run` | `enable_workflow` (preview: trigger, conditions, each action), `delete_workflow`, `approve_workflow_run` |
| Reports | `dashboard_summary`, `pipeline_report`, `outreach_performance`, `marketing_performance`, `team_report` (needs `analytics.team`) | — | — |

Prompts: `daily_sales_review` (overdue tasks, hot replies, stuck deals → a plan) and
`setup_new_lead_automation` (always-on campaign + lead workflows from templates, enabling only after
confirmation).

Notes:

- Inbox message text and contact notes come from outside the workspace; list and read results carry
  a note telling the model to treat them as data, never instructions.
- `import_leads*` go through `LeadIngestService` (100 leads per chunk), so they appear under
  Contacts → Imports with per-row results; a list by `listId` needs `marketing.write`, enrolling
  needs `campaigns.launch`.
- Enabling a workflow is important because it then acts automatically (it may enroll people in
  sequences that email them). A Build token can create and prepare; only a Send token confirms.
- Tested end to end in `apps/api/test/mcp-crm.e2e-spec.ts`.

## Marketing tools

Email marketing (newsletters) — `apps/api/src/mcp/tools/marketing.tools.ts`, split under
`tools/marketing/` (`setup`, `lists`, `designs`, `campaigns`). Each tool calls the service behind the
matching HTTP route with that route's permission (`marketing.controller.ts`, `design-library.controller.ts`,
the suppression routes in `crm.controller.ts`), and validates with the same shared schemas.

| Tool | Risk | Permission | Notes |
| --- | --- | --- | --- |
| `marketing_setup_status` | read | marketing.read | email service, sending domains + DNS checks, company address, double opt-in readiness, allowances, what is missing |
| `list_lists`, `get_list`, `list_list_members` | read | marketing.read / contacts.read | counts by status; members paged, status filter |
| `create_list`, `update_list`, `restore_list` | write | marketing.write / contacts.write | |
| `archive_list` | important | marketing.write / contacts.write | |
| `add_to_list` | write | marketing.write / contacts.write | contactIds / emails / contact filter (`ContactsService.resolve`), **≤ 200 people**; optional `consent { confirmed, source }` |
| `bulk_add_to_list` | important | marketing.write / contacts.write | up to 5,000; preview: count, already subscribed, without consent, double opt-in emails, plan usage; stores the resolved ids |
| `remove_from_list` | important | marketing.write / contacts.write | self-unsubscribed rows are kept |
| `get_design_block_reference`, `list_designs`, `get_design`, `list_design_templates`, `preview_design` | read | marketing.read | preview: plain text, block outline, HTML size, `designProblems`; HTML only on request (cut at 20k) |
| `create_design`, `update_design`, `duplicate_design` | write | marketing.write | from a library template or theme/blocks; `update_design` takes `blockOps` (update / replace / insert / remove / move by block id) |
| `delete_design` | important | marketing.write | |
| `upload_image_from_url` | write | marketing.write | see below |
| `list_marketing_campaigns`, `get_marketing_campaign`, `marketing_campaign_readiness`, `marketing_campaign_report`, `list_campaign_recipients` | read | marketing.read | report: numbers, rates, top links (first click per recipient, from `marketing.clicked` events), recipients by status |
| `create_marketing_campaign`, `update_marketing_campaign`, `duplicate_marketing_campaign` | write | marketing.write | `fromEmail` must be on one of the workspace's sending domains |
| `send_test_email` | write | marketing.send | defaults to the connected user; ≤ 5 addresses; counts against the monthly marketing email allowance |
| `unschedule_marketing_campaign`, `pause_marketing_campaign` | write | marketing.send | both stop mail going out |
| `schedule_marketing_campaign`, `send_marketing_campaign_now` | important | marketing.send | preview: readiness, eligible recipients now, lists, sender, subject, time in the workspace timezone, allowance |
| `resume_marketing_campaign`, `cancel_marketing_campaign` | important | marketing.send | |
| `delete_marketing_campaign` | important | marketing.write | not while scheduled / sending / paused |
| `list_suppressions` | read | contacts.read | |
| `add_suppression` | write | contacts.write | |
| `remove_suppression` | important | contacts.delete | |

Prompts: `plan_newsletter` (setup → list → design from a template → preview → test → schedule with
approval) and `campaign_report_summary`.

- `marketing.send` is a Send-token permission, so test sends, pausing and unscheduling are offered to
  Send tokens only — as in the app, where the same permission guards those routes.
- Scheduling and sending pin the draft's version (`campaignVersion`, filled in by the preview): if the
  campaign is edited after the user saw the summary, `confirm_action` refuses and it must be prepared
  again. A schedule must be at least 2 minutes ahead when prepared; at confirmation, a time less than a
  minute away is refused (the service would otherwise send at once).
- `add_to_list` refuses when, on a double opt-in list, anyone would be emailed a confirmation link;
  `bulk_add_to_list` sends those emails only after the user approves its preview.
- `upload_image_from_url` (`tools/marketing/image-fetch.ts`): https only, port 443, no credentials;
  the host is resolved and every address must be public (`net-guard.isPrivateAddress`, plus
  hex-mapped IPv6 forms); the socket connects to the vetted IP (SNI/certificate on the name), so DNS
  rebinding cannot redirect it; redirects are followed by hand (≤ 3, each re-vetted); ≤ 1 MB, 10 s.
  The bytes then go through `MarketingAssetsService.upload` (magic-byte sniffing, never SVG, 100 MB per
  workspace).
- Connecting an email service and adding or verifying sending domains stay in the app (credentials,
  DNS); `marketing_setup_status` says what is missing.
- Tested in `src/mcp/tools/marketing/*.spec.ts` and end to end in `apps/api/test/mcp-marketing.e2e-spec.ts`.

## OAuth / claude.ai

"Add custom connector" with just the URL: Growthdesk is its own OAuth 2.1 authorization server,
following the MCP Authorization spec (2025-06-18). Code: `apps/api/src/mcp/oauth/`
(`mcp-oauth.service.ts`, `mcp-oauth.controller.ts`, pure rules in `oauth.util.ts`); consent page:
`apps/web/src/app/oauth/consent/`.

### Endpoints

The **issuer** is the API's public base — `PUBLIC_API_URL` (prod: `https://api-growthdesk.sentosh.com`),
else `PUBLIC_APP_URL/api` through the web proxy. All are outside `/v1`, CORS `*` without credentials.

| Endpoint | What |
| --- | --- |
| `GET /.well-known/oauth-protected-resource[/mcp]` | RFC 9728: `resource` (the MCP URL), `authorization_servers: [issuer]`, `bearer_methods_supported`, `scopes_supported` |
| `GET /.well-known/oauth-authorization-server[/…]` | RFC 8414 metadata (any path suffix, for an issuer with a path) |
| `POST /oauth/register` | RFC 7591 dynamic registration — public clients (`token_endpoint_auth_method: none`), 30/min per IP |
| `GET /oauth/authorize` | validates the request, then 302 → `PUBLIC_APP_URL/oauth/consent?request=…` |
| `POST /oauth/token` | `authorization_code` (PKCE) and `refresh_token`; form or JSON; `Cache-Control: no-store`; 300/min per IP |
| `POST /oauth/revoke` | RFC 7009 — access or refresh token; unknown tokens answer 200 |
| `GET/POST /v1/mcp/oauth/consent` | the consent page's API: signed-in session, same-origin writes (the app's usual guard) |

A 401 from `/mcp` carries `WWW-Authenticate: Bearer realm="growthdesk", resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp"`.
When the API has its own URL, `<web>/api/mcp` also works as a resource: the web proxy forwards
`/api/.well-known/*` and `/api/oauth/*` unversioned, and `next.config.ts` rewrites the root
`/.well-known/oauth-protected-resource/*` and `/.well-known/oauth-authorization-server/*` (where
clients look for an issuer or resource with a path) to the API.

### The flow

1. The client gets a 401, reads the resource metadata, then the server metadata, and registers
   (`client_name`, `redirect_uris`). Redirect URIs: `https://…` (claude.ai uses
   `https://claude.ai/api/mcp/auth_callback`, or `claude.com`), or `http://localhost` /
   `127.0.0.1` / `[::1]` for desktop and CLI clients. Nothing is hard-coded: every authorize
   request must name a registered URI exactly — except the port of a loopback URI (RFC 8252 §7.3).
2. `GET /oauth/authorize` checks `client_id`, `redirect_uri`, `response_type=code`, a S256
   `code_challenge` (PKCE is required; `plain` is refused), `state` (echoed back), `resource`
   (must be the MCP URL) and `scope`. An unknown client or redirect URI is shown on the consent page,
   never redirected to; other errors go back to the client with `error` and `state`. The request is
   then HMAC-signed (a key derived from `ENCRYPTION_KEY`) for ten minutes and handed to the consent page.
3. **Consent** (`/oauth/consent`, signed in — otherwise `/login?next=…` and back): the app's name
   and redirect host, the **workspace** (the person's memberships; ones that are suspended, lack API
   access on their plan, or need two-factor the person hasn't set up are shown but can't be picked)
   and the **access level** — Read only / Build / Build + Send, default Build, never above what the
   scope asked for — with the confirmation rule spelled out. Approve → `POST /v1/mcp/oauth/consent`
   creates a code (SHA-256 digest stored, five minutes, single use, bound to client, redirect URI,
   PKCE challenge, person, workspace, access) and answers `redirect_uri?code=…&state=…`; Deny →
   `error=access_denied`. The approval is audited as `mcp.app_connected`.
4. `POST /oauth/token` (`authorization_code`): the code is claimed atomically on first
   presentation (spent even if the rest fails), then must be unexpired, for this `client_id`, with
   the same `redirect_uri`, and `SHA256(code_verifier)` must equal the challenge. The person must
   still be an active member. Answer: `{ access_token: "gdm_…", token_type: "Bearer", expires_in:
   3600, refresh_token: "gdr_…", scope }`. Errors are RFC 6749 JSON (`invalid_grant`, …).

### Tokens and connections

Scopes ↔ access: `mcp:read` (Read only), `mcp:read mcp:build` (Build), `mcp:read mcp:build
mcp:send` (Build + Send). A request with no recognised scope may be granted any level.

**One connection = one `McpToken` row** (`oauthClientId`, `clientName`, name `"<client name>
(OAuth)"`). The access token is its `tokenHash` (one hour, `expiresAt`); the refresh token its
`refreshTokenHash` (60 days, `refreshExpiresAt`). **A refresh rotates both digests on the same row**
(the old pair stops working at once; replaying an old refresh token is `invalid_grant`) and renews
the 60 days. Keeping the row means the connection's pending confirmations, activity and Settings
entry survive refreshes. The same app authorizing again for the same person and workspace replaces
its earlier row. Up to 20 live connections per person per workspace (personal tokens have their own 20).

Because OAuth connections are `McpToken` rows, `McpAuthService` authenticates them exactly like
personal tokens: role ∩ access level, membership, plan, two-factor, suspension — re-checked on every
request. Settings → MCP / Claude lists them under **Connected apps** (app, workspace, access, last
used, Disconnect); an OAuth row counts as active until its refresh token lapses. Disconnecting
(Settings, or the app calling `/oauth/revoke`) revokes the row, drops what it prepared, and is
audited as `mcp.app_disconnected`.

Known limits: a replayed (already rotated) refresh token cannot be told apart from a wrong one, so
it does not revoke the connection; a replayed code does not revoke the tokens it produced; unused
`McpOAuthClient` registrations are not cleaned up (registration is rate-limited).

### Connecting (once deployed)

claude.ai can only reach a public https URL — a local copy (`localhost`) can be connected from
Claude Code or Claude Desktop's config, not from claude.ai.

- **claude.ai** (and Claude Desktop, which shares the account's connectors): Settings → Connectors
  → Add custom connector → name "Growthdesk", URL `https://api-growthdesk.sentosh.com/mcp` (the URL
  shown in Settings → MCP / Claude) → Add → Connect → sign in to Growthdesk → choose the workspace
  and access → Approve.
- **Claude Code**: `claude mcp add --transport http growthdesk <URL>`, then `/mcp` → growthdesk →
  Authenticate. The token method (`--header "Authorization: Bearer gdm_…"`) remains for clients that
  cannot sign in.

Tests: `src/mcp/oauth/*.spec.ts` (PKCE, redirect URIs, scopes, signed requests, code single use and
expiry, refresh rotation) and `apps/api/test/mcp-oauth.e2e-spec.ts` (metadata, the 401 challenge,
the whole flow through the SDK's `auth()` client, refresh, revoke, Settings disconnect).
