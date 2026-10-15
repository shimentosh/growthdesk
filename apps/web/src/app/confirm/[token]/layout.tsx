import type { ReactNode } from "react";
import { AuthFrame } from "@/components/account/AuthFrame";

/** A double opt-in confirmation link: the same centred column as the preference page. */
export default function ConfirmLayout({ children }: { children: ReactNode }) {
  return <AuthFrame width="md">{children}</AuthFrame>;
}
