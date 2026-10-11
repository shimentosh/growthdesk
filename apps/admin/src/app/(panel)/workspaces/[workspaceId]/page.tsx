import type { Metadata } from "next";
import { WorkspaceDetail } from "@/features/workspaces/WorkspaceDetail";

export const metadata: Metadata = { title: "Workspace" };

export default function Page() {
  return <WorkspaceDetail />;
}
