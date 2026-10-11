import type { Metadata } from "next";
import { Callout } from "@/components/ui/Callout";
import { PricingTable } from "@/components/site/PricingTable";
import { getPublicPlans, getSite } from "@/lib/site";

export async function generateMetadata(): Promise<Metadata> {
  const site = await getSite();
  return { title: "Pricing", description: `Plans and prices for ${site.productName}: limits and features for each plan, billed monthly or annually.` };
}

export default async function PricingPage() {
  const plans = await getPublicPlans();
  return (
    <div className="px-4 py-16 sm:px-6 sm:py-20">
      <div className="mx-auto max-w-6xl">
        <div className="mx-auto mb-12 max-w-2xl text-center">
          <h1 className="text-[36px] leading-[1.1] font-semibold tracking-[-0.03em] text-balance text-text-hi sm:text-[48px]">Simple plans that grow with you</h1>
          <p className="mt-4 text-lg leading-7 text-pretty text-text-2">
            Every plan includes the shared CRM, the unified inbox and one-click unsubscribe. Pick the limits and features your team needs.
          </p>
        </div>
        {plans === null ? (
          <Callout tone="warn" title="Pricing is unavailable right now" className="mx-auto max-w-lg">
            The plans could not be loaded. Refresh the page in a moment.
          </Callout>
        ) : plans.length === 0 ? (
          <Callout tone="info" title="No public plans yet" className="mx-auto max-w-lg">
            Plans have not been published. Create an account to start on the default plan.
          </Callout>
        ) : (
          <PricingTable plans={plans} />
        )}
      </div>
    </div>
  );
}
