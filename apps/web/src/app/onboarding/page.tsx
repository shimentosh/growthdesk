import type { Metadata } from "next";
import { AuthFrame } from "@/components/account/AuthFrame";
import { CreateWorkspace } from "./CreateWorkspace";

export const metadata: Metadata = { title: "Set up your workspace" };

export default function OnboardingPage() {
  return (
    <AuthFrame width="md">
      <CreateWorkspace />
    </AuthFrame>
  );
}
