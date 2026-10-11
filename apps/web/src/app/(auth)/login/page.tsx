import type { Metadata } from "next";
import { safeNext } from "../safe-next";
import { LoginForm } from "./LoginForm";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  // ?step=2fa: the Google callback proved the first factor and left a pending two-factor sign-in.
  return <LoginForm next={safeNext(params.next)} twoFactor={params.step === "2fa"} />;
}
