import type { Metadata } from "next";
import { UserDetail } from "@/features/users/UserDetail";

export const metadata: Metadata = { title: "User" };

export default function Page() {
  return <UserDetail />;
}
