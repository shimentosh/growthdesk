import { Controller, Get } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { Ctx, Permission, Query } from "../common/decorators.js";
import type { RequestContext } from "../common/context.js";
import { ACTOR_TYPES } from "../common/actor.js";
import { ActivityFeedService } from "./activity-feed.service.js";

const Range = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  teamId: z.string().uuid().optional(),
});
const FeedQuery = Range.extend({
  actorType: z.enum(ACTOR_TYPES).optional(),
  userId: z.string().uuid().optional(),
  type: z.string().trim().regex(/^[a-z_]+(\.[a-z_]*)*$/, "An activity type such as deal.created or deal.").max(60).optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/** The team activity feed (who did what, across the workspace). */
@ApiTags("activity")
@Controller("workspaces/:workspaceId")
export class ActivityFeedController {
  constructor(private readonly feed: ActivityFeedService) {}

  @Permission("contacts.read")
  @Get("activity")
  list(@Ctx() ctx: RequestContext, @Query(FeedQuery) q: z.infer<typeof FeedQuery>) {
    return this.feed.feed(ctx, q);
  }

  @Permission("contacts.read")
  @Get("activity/summary")
  summary(@Ctx() ctx: RequestContext, @Query(Range) q: z.infer<typeof Range>) {
    return this.feed.summary(ctx, q);
  }
}
