import type { Metadata } from "next";
import { serverGet } from "@/lib/server-api";
import { AcceptInvitation } from "./AcceptInvitation";

export const metadata: Metadata = { title: "Join a workspace" };

/** The link in the invitation email lands here: /invite/:token */
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  // GET /auth/providers, as the login page: "Continue with Google" shows only when the API has it configured.
  const providers = await serverGet<{ google: boolean }>("/auth/providers");
  return <AcceptInvitation token={token} googleEnabled={providers.ok && providers.data.google} />;
}
