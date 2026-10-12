import { redirect } from "next/navigation";

/** Marketing campaigns are listed with outreach campaigns on the one Campaigns page. */
export default async function MarketingCampaignsIndex({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  redirect(`/w/${workspaceId}/campaigns?type=marketing`);
}
