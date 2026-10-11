import { Module } from "@nestjs/common";
import { BillingController } from "./billing.controller.js";
import { BillingService } from "./billing.service.js";
import { StripeProvider } from "./providers/stripe.provider.js";

@Module({ controllers: [BillingController], providers: [BillingService, StripeProvider], exports: [BillingService, StripeProvider] })
export class BillingModule {}
