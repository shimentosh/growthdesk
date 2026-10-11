import type { StripeProvider } from "../src/billing/providers/stripe.provider.js";
import { normalizeStripeSubscription } from "../src/billing/providers/stripe.provider.js";

type SubObject = Record<string, unknown> & { id: string };

/*
 * A stand-in for the Stripe account in e2e tests. The API re-reads every
 * subscription from Stripe before applying a webhook (BillingService.apply),
 * so tests replace the provider's Stripe client calls with this:
 *
 * - `remember(event)`: called by a test's webhook poster for every
 *   subscription event, it makes the newest one (by `created`; ties keep the
 *   first) Stripe's "current state".
 * - `says(subId, patch)`: changes the current state directly, the way Stripe
 *   itself moves a subscription (for example, to past_due on a failed renewal).
 * - `live`, `priceChanges`, `checkouts`: what checkout() sees and asks for.
 */
export function fakeStripe() {
  const fake = {
    truth: new Map<string, { created: number; sub: SubObject }>(),
    live: null as string | null,
    priceChanges: [] as { subId: string; priceId: string }[],
    checkouts: 0,
    remember(event: { created?: number; data?: { object?: Record<string, unknown> } }) {
      const obj = event.data?.object;
      if (obj?.object !== "subscription") return;
      const sub = obj as SubObject;
      const created = event.created ?? 0;
      const held = fake.truth.get(sub.id);
      if (!held || created > held.created) fake.truth.set(sub.id, { created, sub });
    },
    says(subId: string, patch: Record<string, unknown>) {
      const held = fake.truth.get(subId);
      if (!held) throw new Error(`fakeStripe: no subscription ${subId} yet`);
      fake.truth.set(subId, { created: held.created, sub: { ...held.sub, ...patch } });
    },
    install(provider: StripeProvider) {
      provider.fetchSubscription = async (id: string) => {
        const held = fake.truth.get(id);
        if (!held) throw new Error(`No such subscription: ${id}`);
        return normalizeStripeSubscription(held.sub as never);
      };
      provider.findLiveSubscription = async () => fake.live;
      provider.changePrice = async (subId: string, priceId: string) => {
        fake.priceChanges.push({ subId, priceId });
      };
      provider.createCheckout = async () => {
        fake.checkouts++;
        return { url: "https://checkout.stripe.test/session" };
      };
      return fake;
    },
  };
  return fake;
}
