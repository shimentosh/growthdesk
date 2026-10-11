import type { Metadata } from "next";
import { ResetPasswordForm } from "./ResetPasswordForm";

export const metadata: Metadata = { title: "Choose a new password" };

/** The link in the reset email lands here: /reset-password?token=… */
export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { token } = await searchParams;
  return <ResetPasswordForm token={typeof token === "string" ? token : ""} />;
}
