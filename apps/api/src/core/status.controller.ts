import { Controller, Get } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Public } from "../common/decorators.js";
import { BrandingService } from "./branding.service.js";
import { PlatformSettingsService } from "./platform-settings.service.js";

/**
 * GET /status — what the app shell shows everyone, signed in or not: whether
 * the platform is in maintenance (AccessGuard then refuses writes from
 * non-admins, with the same message) and where to reach support.
 */
@ApiTags("status")
@Public()
@Controller("status")
export class StatusController {
  constructor(
    private readonly platform: PlatformSettingsService,
    private readonly branding: BrandingService,
  ) {}

  @Get()
  async status() {
    const [settings, brand] = await Promise.all([this.platform.get(), this.branding.get()]);
    return {
      maintenance: settings.maintenanceMode
        ? { message: settings.maintenanceMessage || `${brand.productName} is in maintenance for a few minutes — nothing can be changed until it is back.` }
        : null,
      supportEmail: brand.supportEmail || null,
    };
  }
}
