import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { safeNext } from "@/lib/safe-next";
import { serverGet } from "@/lib/server-api";
import type { Me } from "@/lib/types";
import { LoginForm } from "./LoginForm";

export const metadata: Metadata = { title: "Sign in" };

/*
 * Staff sign-in. A visitor who already has a valid staff session goes
 * straight on; a signed-in customer account sees "no platform access" with a
 * way to sign out, instead of a form that would only lead back to a 404.
 */
export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const next = safeNext(params.next);
  const jar = await cookies();
  let noAccess: { email: string; name: string } | null = null;
  if (jar.has("gd_session")) {
    const me = await serverGet<Me>("/auth/me");
    if (me.ok) {
      if (me.data.user.platformRole !== "none") redirect(next);
      noAccess = { email: me.data.user.email, name: me.data.user.name };
    }
  }
  return <LoginForm next={next} noAccess={noAccess} />;
}
