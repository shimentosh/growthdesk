import { redirect } from "next/navigation";

/** Teams moved under Members (one "Members & teams" section); old links land on its Teams tab. */
export default async function TeamsRedirect({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  redirect(`/w/${workspaceId}/settings/members/teams`);
}
