import { redirect } from "next/navigation";

/** /settings opens the first section. */
export default async function SettingsIndex({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  redirect(`/w/${workspaceId}/settings/general`);
}
