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
  // ?step=2fa: the Google callback proved the first factor and left a pending two-factor sign-in.
  return (
    <LoginForm
      next={safeNext(params.next)}
      googleEnabled={providers.ok && providers.data.google}
      error={GOOGLE_ERROR_MESSAGES[oneParam(params.error)] ?? null}
      twoFactor={params.step === "2fa"}
    />
  );
}
