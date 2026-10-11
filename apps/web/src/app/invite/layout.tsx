import type { ReactNode } from "react";
import { AuthFrame } from "@/components/account/AuthFrame";

/** The invitation link's page: the same centred column as sign-in. */
export default function InviteLayout({ children }: { children: ReactNode }) {
  return <AuthFrame>{children}</AuthFrame>;
}
