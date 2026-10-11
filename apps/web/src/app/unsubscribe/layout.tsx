import type { ReactNode } from "react";
import { AuthFrame } from "@/components/account/AuthFrame";

/** The unsubscribe link's page: the same centred column as sign-in. */
export default function UnsubscribeLayout({ children }: { children: ReactNode }) {
  return <AuthFrame>{children}</AuthFrame>;
}
