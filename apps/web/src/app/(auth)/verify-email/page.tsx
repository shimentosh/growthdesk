import type { Metadata } from "next";
import { VerifyEmail } from "./VerifyEmail";

export const metadata: Metadata = { title: "Confirm your email" };

/** The link in the verification email lands here: /verify-email?token=… */
export default async function VerifyEmailPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { token } = await searchParams;
  return <VerifyEmail token={typeof token === "string" ? token : ""} />;
}
