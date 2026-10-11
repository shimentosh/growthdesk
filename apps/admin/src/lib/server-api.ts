/*
 * Calling the API from a server component (the "/" redirect, the admin gate).
 * Forwards the visitor's cookies straight to the API — no proxy hop — and
 * returns a result object rather than throwing, so the caller decides between
 * redirect(), notFound() and an error screen.
 *
 * Server-only: it reads next/headers. Client code uses src/lib/api.ts.
 */
import { cookies } from "next/headers";

export const apiTarget = () => (process.env.API_URL ?? "http://127.0.0.1:3601").replace(/\/$/, "");

export type ServerResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; code: string; message: string };

export async function serverGet<T>(path: string): Promise<ServerResult<T>> {
  const jar = await cookies();
  try {
    const res = await fetch(`${apiTarget()}/v1${path}`, {
      headers: { cookie: jar.toString(), accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => null)) as { data?: T; error?: { code?: string; message?: string } } | null;
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        code: body?.error?.code ?? "server_error",
        message: body?.error?.message ?? `The API answered ${res.status}`,
      };
    }
    return { ok: true, data: body?.data as T };
  } catch {
    return { ok: false, status: 502, code: "api_unreachable", message: "Could not reach the Growthdesk API." };
  }
}
