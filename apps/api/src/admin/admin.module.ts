import { Module } from "@nestjs/common";
import { BillingModule } from "../billing/billing.module.js";
import { RevenueModule } from "../revenue/revenue.module.js";
import { AdminController } from "./admin.controller.js";
import { AdminService } from "./admin.service.js";
import { AdminSupportController } from "./admin-support.controller.js";
import { AdminSupportService } from "./admin-support.service.js";
import { AuthModule } from "../auth/auth.module.js";
import { AdminUsersController } from "./admin-users.controller.js";
import { AdminUsersService } from "./admin-users.service.js";

/** Platform super-admin API (/v1/admin/…), authorised by platform role with @Platform(min). */
@Module({
  imports: [BillingModule, RevenueModule, AuthModule],
  // AdminUsersController first: its users/export.csv must win over AdminController's users/:id.
  controllers: [AdminUsersController, AdminController, AdminSupportController],
  providers: [AdminService, AdminSupportService, AdminUsersService],
})
export class AdminModule {}
