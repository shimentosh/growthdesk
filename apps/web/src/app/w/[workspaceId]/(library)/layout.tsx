import type { ReactNode } from "react";
import { LibraryShell } from "@/components/templates/library";

/** /templates, /sequences and /marketing/designs share one header and tab bar (components/templates/library). */
export default function LibraryLayout({ children }: { children: ReactNode }) {
  return <LibraryShell>{children}</LibraryShell>;
}
