/*
 * The browser's side of the API.
 *
 * Ported from LinkDesk's lib/api.ts: one place that knows the envelope —
 * `{ data }` on success, `{ error: { code, message, fields?, details? } }` on
 * failure — so no component ever unwraps a response by hand. Requests go to
 * this app's own origin (/api/*), which the route handler at
 * src/app/api/[...path]/route.ts forwards to the Nest API under /v1.
 *
 * Paths are API paths WITHOUT the /api prefix: `get("/auth/me")`,
 * `post(\`/workspaces/${id}/contacts\`, body)`. A path that already starts
 * with /api/ is accepted as-is.
 */

export type ApiErrorBody = {
  code: string;
  message: string;
  fields?: Record<string, string>;
  details?: Record<string, unknown>;
};

/** What a 402 `plan_limit` error carries in `details`. */
export type PlanLimitDetails = {
  limit?: string;
  feature?: string;
  used?: number;
  allowed?: number;
  plan?: string;
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** Per-field messages, keyed by the input's name (dotted for nested fields). */
  readonly fields: Record<string, string>;
  readonly details: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message: string,
    fields: Record<string, string> = {},
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.fields = fields;
    this.details = details;
  }

  /** A plan limit or a feature the plan does not include (HTTP 402). */
  get isPlanLimit(): boolean {
    return this.status === 402 || this.code === "plan_limit";
  }
  get planLimit(): PlanLimitDetails | null {
    return this.isPlanLimit ? (this.details as PlanLimitDetails) : null;
  }
  get isAuth(): boolean {
    return this.status === 401;
  }
  get isForbidden(): boolean {
    return this.status === 403;
  }
  get isNotFound(): boolean {
    return this.status === 404;
  }
  /** The workspace is suspended, or the account is restricted (HTTP 423). */
  get isLocked(): boolean {
    return this.status === 423;
  }
  get isOffline(): boolean {
    return this.status === 0 || this.code === "api_unreachable";
  }
}

export type RequestOptions = {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
  /** Appended as a query string; undefined/null/"" values are skipped, objects are JSON-encoded. */
  query?: QueryParams;
  /** Do not send the person to /login on a 401 (sign-in forms, public pages). */
  noAuthRedirect?: boolean;
};

export type QueryParams = Record<string, string | number | boolean | null | undefined | object>;

/** Routes a signed-out visitor may be on. A 401 there is an answer, not a reason to redirect. */
const PUBLIC_PREFIXES = [
  "/login",
  "/register",
  "/verify-email",
  "/forgot-password",
  "/reset-password",
  "/invite",
  "/unsubscribe",
];

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/** `withQuery("/x", { page: 2, filter: { q: "a" } })` → `/x?page=2&filter=%7B%22q%22%3A%22a%22%7D` */
export function withQuery(path: string, query?: QueryParams): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
  }
  const s = params.toString();
  if (!s) return path;
  return `${path}${path.includes("?") ? "&" : "?"}${s}`;
}

function url(path: string, query?: QueryParams): string {
  const p = path.startsWith("/api/") ? path : `/api${path.startsWith("/") ? "" : "/"}${path}`;
  return withQuery(p, query);
}

function redirectToLogin() {
  if (typeof window === "undefined") return;
  const { pathname, search } = window.location;
  if (isPublicPath(pathname)) return;
  const next = encodeURIComponent(pathname + search);
  window.location.assign(`/login?next=${next}`);
}

/**
 * Calls the API and returns the payload, or throws an ApiError. Throwing is
 * deliberate: a caller either gets data or handles an error.
 */
export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url(path, options.query), {
      method: options.method ?? "GET",
      headers: options.body === undefined ? { accept: "application/json" } : { "content-type": "application/json", accept: "application/json" },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      credentials: "same-origin",
      cache: "no-store",
      signal: options.signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ApiError(0, "offline", "Could not reach the server. Check your connection and try again.");
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw new ApiError(res.status, "bad_response", `The server answered ${res.status} with something that is not JSON.`);
  }

  const shaped = payload as { data?: T; error?: ApiErrorBody } | null;
  if (!res.ok || shaped?.error) {
    const err = shaped?.error;
    const error = new ApiError(
      res.status,
      err?.code ?? "server_error",
      err?.message ?? `The server answered ${res.status}`,
      err?.fields ?? {},
      err?.details ?? {},
    );
    if (error.isAuth && !options.noAuthRedirect) redirectToLogin();
    throw error;
  }
  // `@Raw()` routes answer without the envelope; everything else is `{ data }` (data may be null).
  if (shaped && typeof shaped === "object" && "data" in shaped) return shaped.data as T;
  return payload as T;
}

export const get = <T>(path: string, options: Omit<RequestOptions, "method" | "body"> = {}) => api<T>(path, options);
export const post = <T>(path: string, body?: unknown, options: Omit<RequestOptions, "method" | "body"> = {}) =>
  api<T>(path, { ...options, method: "POST", body });
export const patch = <T>(path: string, body?: unknown, options: Omit<RequestOptions, "method" | "body"> = {}) =>
  api<T>(path, { ...options, method: "PATCH", body });
export const put = <T>(path: string, body?: unknown, options: Omit<RequestOptions, "method" | "body"> = {}) =>
  api<T>(path, { ...options, method: "PUT", body });
export const del = <T>(path: string, options: Omit<RequestOptions, "method" | "body"> = {}) =>
  api<T>(path, { ...options, method: "DELETE" });

/** The message to show a person, whatever was thrown. */
export const messageOf = (e: unknown): string =>
  e instanceof ApiError ? e.message : e instanceof Error ? e.message : "Something went wrong";

/** Field errors from a thrown ApiError, or an empty object. */
export const fieldsOf = (e: unknown): Record<string, string> => (e instanceof ApiError ? e.fields : {});

export const isApiError = (e: unknown): e is ApiError => e instanceof ApiError;
