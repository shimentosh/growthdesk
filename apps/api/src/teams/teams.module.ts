import { Global, Module } from "@nestjs/common";
import { TeamsController } from "./teams.controller.js";
import { TeamsService } from "./teams.service.js";
import { TeamOverviewService } from "./team-overview.service.js";

/** Global: lead routing and the activity feed resolve team pools through TeamsService. */
@Global()
@Module({
  controllers: [TeamsController],
  providers: [TeamsService, TeamOverviewService],
  exports: [TeamsService, TeamOverviewService],
})
export class TeamsModule {}
