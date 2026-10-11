import type { Metadata } from "next";
import { serverGet } from "@/lib/server-api";
import { safeNext } from "../safe-next";
import { RegisterForm, type SignupPolicy } from "./RegisterForm";

export const metadata: Metadata = { title: "Create an account" };

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export default async function RegisterPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const invite = one(params.invite).slice(0, 200);
  // GET /auth/signup-policy decides between the form, the waitlist and the closed notice. If the API
  // cannot be reached the form still shows, and the API's own answer explains any refusal.
  const policy = await serverGet<SignupPolicy>(`/auth/signup-policy${invite ? `?invite=${encodeURIComponent(invite)}` : ""}`);
  return (
    <RegisterForm
      next={safeNext(params.next)}
      invite={invite}
      error={one(params.error)}
      policy={policy.ok ? policy.data : { mode: "open", googleEnabled: false, requiresInvite: false, invite: null }}
    />
  );
}
