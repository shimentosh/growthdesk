import type { Metadata } from "next";
import { serverGet } from "@/lib/server-api";
import { GOOGLE_ERROR_MESSAGES, oneParam } from "../oauth-errors";
import { safeNext } from "../safe-next";
import { LoginForm } from "./LoginForm";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  // GET /auth/providers: the Google button shows only when the API has Google sign-in configured.
  const providers = await serverGet<{ google: boolean }>("/auth/providers");
  return (
    <LoginForm
      next={safeNext(params.next)}
      googleEnabled={providers.ok && providers.data.google}
      error={GOOGLE_ERROR_MESSAGES[oneParam(params.error)] ?? null}
    />
  );
}
