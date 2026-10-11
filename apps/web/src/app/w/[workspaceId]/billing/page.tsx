import { redirect } from "next/navigation";

/**
 * The upgrade prompt links to /billing, and the payment provider returns here
 * (?checkout=success|canceled); the page lives under settings.
 */
export default async function BillingRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const { checkout } = await searchParams;
  const result = checkout === "success" || checkout === "canceled" ? `?checkout=${checkout}` : "";
  redirect(`/w/${workspaceId}/settings/billing${result}`);
}
