import type { Metadata } from "next";
import { WorkspacesList } from "@/features/workspaces/Workspaces";

export const metadata: Metadata = { title: "Workspaces" };

export default function Page() {
  return <WorkspacesList />;
}
