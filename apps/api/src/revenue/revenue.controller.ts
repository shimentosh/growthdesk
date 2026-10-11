import { Controller, Get } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { PlatformRevenueQuery, type PlatformRevenueQueryT } from "@growthdesk/shared";
import { Platform, Query } from "../common/decorators.js";
import { RevenueService } from "./revenue.service.js";

/** /v1/admin/revenue — platform revenue reporting. Admin and above: support staff do not see revenue. */
@ApiTags("admin")
@Controller("admin")
export class RevenueController {
  constructor(private readonly revenue: RevenueService) {}

  @Platform("admin")
  @Get("revenue")
  report(@Query(PlatformRevenueQuery) q: PlatformRevenueQueryT) {
    return this.revenue.report(q);
  }
}
