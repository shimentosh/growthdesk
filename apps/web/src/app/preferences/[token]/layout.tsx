import type { ReactNode } from "react";
import { AuthFrame } from "@/components/account/AuthFrame";

/** A marketing email's preference page: the same centred column as unsubscribe and sign-in, a little wider for the list switches. */
export default function PreferencesLayout({ children }: { children: ReactNode }) {
  return <AuthFrame width="md">{children}</AuthFrame>;
}
