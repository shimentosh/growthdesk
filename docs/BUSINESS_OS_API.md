# Growthdesk — Business OS & public API

How Business OS (or any other system) pushes leads into a Growthdesk workspace and reads or
writes CRM records. Everything here is implemented in `apps/api/src/integrations` (keys, lead
ingest, idempotency) and `apps/api/src/common/access.guard.ts` (key verification); the routes that
accept a key are marked `@ApiKeyScope(...)` in their controllers.

## Base URL

Integrations call the API through the web app's origin, which proxies `/api/*` to the API's `/v1/*`
(apps/web/src/app/api/[...path]/route.ts):

```
https://<PUBLIC_APP_URL host>/api/workspaces/<workspaceId>/...
```

Settings → Developers → **API keys** shows the exact base URL and the workspace id, with copy
buttons. (Inside the deployment the API itself answers on `http://api:3601/v1/...`; see
docs/DEPLOYMENT.md.) The OpenAPI document is at `/api/docs.json`.

Every route is workspace-scoped. A key belongs to one workspace; using it under another workspace id
answers **404**, exactly as for a non-member.

## API keys

Created by a workspace member holding **`apikeys.manage`** (owners and admins by default) under
Settings → Developers → API keys, and only while the plan includes **API access** (Starter, Growth,
Agency in the default plans).

- Format: `gd_` + 43 base64url characters (32 random bytes).
- Shown **once**, on creation. Growthdesk stores only its SHA-256 digest and the first 12 characters
  (`gd_` + 8, the "prefix" shown in the list). A lost key is revoked and replaced.
- Optional expiry. An expired or revoked key is refused (**401**) on its next request.
- At most 25 active keys per workspace.
- `lastUsedAt` is refreshed on use, at most once a minute per key.
- Creating and revoking keys is recorded in the workspace audit log (`api_key.created`,
  `api_key.revoked`); key management itself is session-only — a key cannot list, create or revoke keys.

Send the key on every request:

```
Authorization: Bearer gd_XXXXXXXX...
```

### Scopes

A key holds one or more scopes. Each route accepts exactly one scope.

| Scope | Grants |
| --- | --- |
| `leads:write` | `POST /leads` — create/update contacts and companies from leads, and optionally enroll them in a running campaign |
| `contacts:read` | List and fetch contacts, companies and tags (every record in the workspace, whoever owns it) |
| `contacts:write` | Create and edit contacts and companies, add notes. **No deleting.** |
| `campaigns:read` | List campaigns, fetch one, list its enrollments |

A key without the route's scope gets **403** `This API key lacks the "<scope>" scope`. Routes not
listed below do not accept API keys at all (they ignore the header and answer **401**). Deals, tasks
and other areas have no API scope yet.

### Endpoints

All paths are under `/api/workspaces/{workspaceId}`.

| Method & path | Scope | Notes |
| --- | --- | --- |
| `POST /leads` | `leads:write` | Lead ingest, below |
| `GET /contacts` | `contacts:read` | `page`, `pageSize` (≤200), `sort` (`createdAt`, `updatedAt`, `fullName`, `lastContactedAt`, `nextActionAt`, `priority`, `score`), `dir`, `filter` (URL-encoded JSON: `q`, `status[]`, `qualification[]`, `priority[]`, `companyId`, `tag[]`, `leadSource`, `hasEmail`, `hasPhone`, `createdAfter`, `createdBefore`, `campaignId`, …) |
| `GET /contacts/{id}` | `contacts:read` | Includes identifiers, sources, deals, open tasks, enrollments |
| `GET /companies` | `contacts:read` | `q`, `page`, `pageSize`, `sort` (`createdAt`, `name`, `updatedAt`), `dir` |
| `GET /companies/{id}` | `contacts:read` | Includes contacts and deals |
| `GET /tags` | `contacts:read` | |
| `POST /contacts` | `contacts:write` | Refuses a duplicate email/phone with **409** and `details.contactId`; use `/leads` to upsert |
| `PATCH /contacts/{id}` | `contacts:write` | |
| `POST /contacts/{id}/notes` | `contacts:write` | `{ body, pinned? }` |
| `POST /companies` | `contacts:write` | Refuses a duplicate domain with **409** and `details.companyId` |
| `PATCH /companies/{id}` | `contacts:write` | |
| `POST /companies/{id}/notes` | `contacts:write` | |
| `GET /campaigns` | `campaigns:read` | `page`, `pageSize`, `status`, `q`, `ownerId` |
| `GET /campaigns/{id}` | `campaigns:read` | |
| `GET /campaigns/{id}/enrollments` | `campaigns:read` | `page`, `pageSize`, `status`, `q` |

Bodies are the same Zod schemas the web app uses (`ContactInput`, `CompanyInput` in
packages/shared/src/schemas.ts). Contacts created with `POST /contacts` are recorded as created
manually; leads that should carry their source belong in `POST /leads`.

## Lead ingest — `POST /leads`

Upserts up to **100** leads per request. Each lead goes through the same path as a CSV import row
(`ContactsService.upsert`):

1. **Matching**, in order: the lead's `externalId` (per `source`), then any email, then any phone
   (emails and phones are normalised; phones use the workspace's default country when they lack a
   `+` prefix).
2. **A match** has its blank fields filled — never overwritten — and new emails/phones, tags and the
   note added (`onDuplicate: "update"`, the default), or is left as it is (`"skip"`). Either way the
   source is recorded on it.
3. **No match** creates a contact, linked to a company: `company.domain`/`company.website` matches a
   company by domain then by name, or creates one; a bare `companyName` matches or creates by name; a
   business email's domain links to an existing company with that domain.
4. **Attribution:** a `ContactSource` row (`source`, `externalId`, the request's import id, and the
   lead's `data`). The same `externalId` always resolves to the same contact, even after its email
   changes.
5. **Events:** each new contact emits `lead.imported` (transactional outbox), which drives workflows
   with the "Lead imported" trigger and outgoing webhooks subscribed to `lead.imported`.
6. **History:** the request is recorded as an import (`source` `business_os` or `api`, name
   `API key: <key name>`), visible under Imports with its counts and per-lead errors.

Leads are processed independently: one invalid lead fails alone and the rest are saved. A
signed-in member with `contacts.import` may also call this endpoint with their session (enrolling then
needs `campaigns.launch`).

### Request

```http
POST /api/workspaces/2f0c.../leads
Authorization: Bearer gd_...
Content-Type: application/json
Idempotency-Key: bos-sync-2026-10-10T09:00Z-1
```

```json
{
  "source": "business_os",
  "onDuplicate": "update",
  "tags": ["business-os"],
  "campaignId": "8b1e...",
  "leads": [
    {
      "externalId": "lead_4821",
      "fullName": "Alan Turing",
      "email": "alan@bletchley.example",
      "phone": "+44 20 7946 0958",
      "jobTitle": "Head of Research",
      "company": { "name": "Bletchley Park", "domain": "bletchley.example", "industry": "Research" },
      "leadSource": "Website form",
      "tags": ["mql"],
      "customFields": { "budget": "50k" },
      "notes": "Asked for a demo next week.",
      "data": { "stage": "MQL", "ownerEmail": "sam@company.example" }
    }
  ]
}
```

| Field | Type | |
| --- | --- | --- |
| `leads` | array, 1–100 | required |
| `source` | `"business_os"` \| `"api"` | default `business_os`; namespaces `externalId` |
| `onDuplicate` | `"update"` \| `"skip"` | default `update` |
| `tags` | string[] ≤20 | added to every lead |
| `campaignId` | uuid | enroll every lead that resolved to a contact |

Per lead (all optional, but each needs a name, an email or a phone): `externalId` (≤200),
`firstName`, `lastName`, `fullName`, `email`, `emails[]` (≤10), `phone`, `phones[]` (≤10),
`jobTitle`, `website`, `linkedinUrl`, `city`, `country`, `timezone`, `leadSource`, `priority`
(`low|medium|high|urgent`), `score` (0–100), `customFields` (object of string/number/boolean/null),
`doNotContact` (also adds the email/phone to the suppression list), `consentStatus`, `consentSource`,
`tags[]` (≤50), `companyName`, `company` (`name`, `domain`, `website`, `industry`, `country`, `city`,
`description`), `notes` (≤5000, added as a note), `data` (object, ≤10,000 characters of JSON, kept
on the source record).

### Response — `200`

```json
{
  "data": {
    "importId": "0199...",
    "source": "business_os",
    "summary": { "received": 1, "created": 1, "updated": 0, "unchanged": 0, "skipped": 0, "failed": 0 },
    "results": [
      { "index": 0, "externalId": "lead_4821", "contactId": "0199...", "status": "created", "matchedBy": null, "error": null }
    ],
    "enrollment": { "campaignId": "8b1e...", "enrolled": 1, "skipped": [], "error": null }
  }
}
```

- `status`: `created`, `updated` (a match gained data), `unchanged` (a match, nothing new),
  `skipped` (a match under `onDuplicate: "skip"`), `failed`.
- `matchedBy`: `external`, `email`, `phone` or `null`.
- A failed lead has `error: { code, message }` — e.g. `bad_request` ("A contact needs at least a name,
  an email address or a phone number."), `plan_limit` (contact limit reached), `not_found`.
- `enrollment` is `null` without `campaignId`. `skipped` lists `{ reason, label, count }` for contacts
  not enrolled (`no_email`, `already_enrolled`, `unsubscribed`, `bounced`, `suppressed`,
  `do_not_contact`, …). If enrolling fails after the leads were saved, `error` says why and the
  contacts remain.

### Refused before any lead is saved

| Status | `code` | When |
| --- | --- | --- |
| 400 | `bad_request` | Body invalid (`fields` names each problem), bad `Idempotency-Key` |
| 402 | `plan_limit` | The plan does not include API access (`details.feature: "apiAccess"`) |
| 403 | `forbidden` | Key lacks `leads:write` |
| 404 | `not_found` | Wrong workspace id, or `campaignId` not in the workspace |
| 409 | `conflict` | `campaignId` is a draft, completed or canceled campaign; idempotency conflicts (below) |
| 423 | `locked` | Workspace suspended, or the subscription is restricted (payment overdue past grace) |

## Idempotency

Send `Idempotency-Key: <1–200 visible ASCII characters>` on `POST /leads` to make retries safe:

- The first request with a key runs and its response is stored for **24 hours** (per workspace).
- A retry with the same key **and the same body** returns the stored response without running again,
  with header `Idempotent-Replayed: true`.
- The same key with a **different body** → **409** `This Idempotency-Key was already used for a
  different request.`
- While the first request is still running, a retry → **409** `…still being processed. Retry in a few
  seconds.`
- A request that fails (any error response) does not keep its key; retry with the same key.

Without the header, a retried request is still safe for contacts (they are matched, not duplicated),
but it records a second import.

## Errors

Every error is:

```json
{ "error": { "code": "forbidden", "message": "This API key lacks the \"contacts:write\" scope" } }
```

with optional `fields` (validation, per field) and `details` (e.g. `contactId` of a duplicate, plan
numbers on `plan_limit`).

| Status | `code` | Meaning |
| --- | --- | --- |
| 400 | `bad_request` | Invalid body or query |
| 401 | `unauthorized` | Missing, unknown, revoked or expired key (`That API key is not valid`), or a route that does not accept keys |
| 402 | `plan_limit` | Plan lacks API access, or a plan limit was reached |
| 403 | `forbidden` | Key lacks the route's scope |
| 404 | `not_found` | Record or workspace not found in the key's workspace |
| 409 | `conflict` | Duplicate, state conflict, idempotency conflict |
| 423 | `locked` | Workspace suspended / account restricted |
| 429 | `too_many_requests` | Rate limit |

## Rate limits

All API traffic, keys included, is limited per **client IP address** (as the API resolves it behind
its proxies; `TRUSTED_PROXY_HOPS`), in Redis: **600 requests per minute** by default
(`RATE_LIMIT_PER_MINUTE`). Over the limit the API answers **429** `Too many requests — wait N seconds
and try again`. There is no separate per-key limit. Batch leads (up to 100 per request) rather than
sending one request per lead.

## Plan changes

The key check reads the workspace's plan on every request. When a plan loses API access, every key is
refused with **402** until the plan includes it again; keys stay listed and can still be revoked.
Lead ingest also respects the plan's contact limit: once it is reached, new leads fail individually
with `plan_limit` while matches to existing contacts still update.
