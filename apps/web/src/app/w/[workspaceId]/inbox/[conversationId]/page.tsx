import { redirect } from "next/navigation";

/**
 * /w/:id/inbox/:conversationId — the form reply notifications link to
 * (mailboxes/inbound-email.service.ts). The inbox keeps the open
 * conversation in ?c=, so this forwards there.
 */
export default async function ConversationRedirect({ params }: { params: Promise<{ workspaceId: string; conversationId: string }> }) {
  const { workspaceId, conversationId } = await params;
  redirect(`/w/${encodeURIComponent(workspaceId)}/inbox?c=${encodeURIComponent(conversationId)}`);
}
