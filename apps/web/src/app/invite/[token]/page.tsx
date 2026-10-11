import type { Metadata } from "next";
import { AcceptInvitation } from "./AcceptInvitation";

export const metadata: Metadata = { title: "Join a workspace" };

/** The link in the invitation email lands here: /invite/:token */
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <AcceptInvitation token={token} />;
}
