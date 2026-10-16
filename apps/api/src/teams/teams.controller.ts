import { Controller, Delete, Get, Param, Patch, Post, Put } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { RecordVisibilityInput, TeamFocusInput, TeamInput } from "@growthdesk/shared";
import { Body, Ctx, Permission, Query } from "../common/decorators.js";
import type { RequestContext } from "../common/context.js";
import { TeamsService } from "./teams.service.js";
import { TeamOverviewService } from "./team-overview.service.js";

const OverviewQuery = z.object({ teamId: z.string().uuid().optional() });

/** Teams and record visibility. Reading needs members.read; changing teams, members.manage; visibility, settings.manage. */
@ApiTags("teams")
@Controller("workspaces/:workspaceId")
export class TeamsController {
  constructor(
    private readonly teams: TeamsService,
    private readonly overview: TeamOverviewService,
  ) {}

  /** The manager's view: who carries what and where work is slipping. */
  @Permission("analytics.team")
  @Get("team-overview")
  teamOverview(@Ctx() ctx: RequestContext, @Query(OverviewQuery) q: z.infer<typeof OverviewQuery>) {
    return this.overview.overview(ctx, q);
  }

  @Permission("members.read")
  @Get("teams")
  list(@Ctx() ctx: RequestContext) {
    return this.teams.list(ctx);
  }

  @Permission("members.manage")
  @Post("teams")
  create(@Ctx() ctx: RequestContext, @Body(TeamInput) body: z.infer<typeof TeamInput>) {
    return this.teams.create(ctx, body);
  }

  @Permission("members.manage")
  @Patch("teams/:id")
  update(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(TeamInput) body: z.infer<typeof TeamInput>) {
    return this.teams.update(ctx, id, body);
  }

  @Permission("members.manage")
  @Delete("teams/:id")
  remove(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.teams.remove(ctx, id);
  }

  /** This week's focus: the workspace's and the caller's teams'. */
  @Permission("members.read")
  @Get("team-focus")
  focus(@Ctx() ctx: RequestContext) {
    return this.teams.focus(ctx);
  }

  /** Managers pin the workspace's focus; a team lead (or manager) a team's. Checked in the service. */
  @Put("team-focus")
  setFocus(@Ctx() ctx: RequestContext, @Body(TeamFocusInput) body: z.infer<typeof TeamFocusInput>) {
    return this.teams.setFocus(ctx, body);
  }

  @Permission("settings.manage")
  @Put("record-visibility")
  visibility(@Ctx() ctx: RequestContext, @Body(RecordVisibilityInput) body: z.infer<typeof RecordVisibilityInput>) {
    return this.teams.setVisibility(ctx, body.recordVisibility);
  }
}
