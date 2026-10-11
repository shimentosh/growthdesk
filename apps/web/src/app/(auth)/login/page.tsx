import type { Metadata } from "next";
import { safeNext } from "../safe-next";
import { LoginForm } from "./LoginForm";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  return <LoginForm next={safeNext(params.next)} />;
}
