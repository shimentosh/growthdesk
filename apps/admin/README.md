# @growthdesk/admin — the operator console

The platform super-admin for Growthdesk, on its own port: `http://localhost:3602`.
It talks to the API exactly like the customer app: the browser calls this app's own
`/api/*`, which `src/app/api/[...path]/route.ts` forwards to `${API_URL}/v1/*`
(default `http://127.0.0.1:3601`). The session is the API's `gd_session` cookie.
Writes from this origin pass the API's CSRF check because `ALLOWED_ORIGINS` defaults
to `PUBLIC_APP_URL` + `ADMIN_APP_URL` (apps/api/src/config/config.ts).

```
pnpm --filter @growthdesk/admin dev         # next dev -p 3602
pnpm --filter @growthdesk/admin typecheck
pnpm --filter @growthdesk/admin test:ui     # Playwright smoke (no database needed)
pnpm --filter @growthdesk/api admin:create --email you@example.com --password '…' --name You --role owner
```

## Layout

```
src/nav.ts                     sidebar groups + items (one line per page), breadcrumbs, search "Pages"
src/proxy.ts                   no gd_session cookie → /login?next=… (except /login and /api)
src/app/login/                 staff email + password sign-in
src/app/(panel)/layout.tsx     /auth/me gate: 401 → /login, platformRole "none" → 404
src/app/(panel)/**/page.tsx    thin route files (metadata + the feature component)
src/features/<area>/           the screens, by area (users, workspaces, billing, …)
src/features/common/           shared admin pieces: role context, tiles, audit table, types
src/components/shell/          AdminShell, Sidebar, Topbar, GlobalSearch, ThemeToggle, Brand
src/components/ui/, src/lib/   COPIES of apps/web (see below)
```

## Adding a page

1. `src/features/<area>/<Thing>.tsx` — a client component that renders `<Page>` + `<PageHeader>`
   and reads data with `useApiQuery(platformKey(...), "/admin/...")`.
2. `src/app/(panel)/<path>/page.tsx` — export `metadata = { title }` and render the component
   (wrap in `<Suspense>` if it reads `useSearchParams`).
3. Add one line to the right group in `src/nav.ts`, e.g.
   `{ href: "/revenue", label: "Revenue & MRR", icon: TrendingUp }`. A new group is one more
   `{ id, label, items }` object. Breadcrumbs and the search's "Pages" results follow automatically.
4. Optionally add a tile to `PLATFORM` in `src/features/common/platform.tsx` for the page header.

## Copied code — to be unified into `packages/ui`

While apps/web was being edited by another session, nothing was extracted into a shared
package. These files are **copies** of apps/web and should become `packages/ui` later:

- `src/components/ui/*` — from apps/web/src/components/ui (minus `RequirePermission`, `UpgradePrompt`;
  `ErrorState` no longer renders the upgrade prompt).
- `src/lib/{api,query,server-api,session,format,cn,theme,types}.ts(x)` — `query.tsx` has no upgrade
  dialog or `wsKey`; `session.tsx` has no workspace context (browser time zone, USD);
  `types.ts` keeps only `Me` and `Paged`.
- `src/app/globals.css`, `src/app/api/[...path]/route.ts`, `src/lib/safe-next.ts`.
- `src/features/common/{labels,userAgent,types}.ts`, `platform.tsx` — from apps/web
  `components/admin/labels.ts`, `components/account/userAgent.ts`, `lib/types/platform.ts`,
  `components/platform/common.tsx`.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `API_URL` | `http://127.0.0.1:3601` | where `/api/*` and server-side calls go |
| `PUBLIC_APP_URL` | this host on :3600 when served on :3602 | the "Open app" link (also reads `NEXT_PUBLIC_APP_URL`) |
| `ADMIN_ENV_LABEL` | Local / Staging / Production from the host | the top bar's environment badge |
