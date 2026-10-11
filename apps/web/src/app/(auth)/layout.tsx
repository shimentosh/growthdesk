import type { ReactNode } from "react";
import { AuthFrame } from "@/components/account/AuthFrame";

/** Sign-in, sign-up and email links: one centred card on the deep ground, under the brand tile. */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return <AuthFrame>{children}</AuthFrame>;
}
