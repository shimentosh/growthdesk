import { Controller, Get, Module } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { z } from "zod";
import { Ctx, Query } from "../common/decorators.js";
import type { RequestContext } from "../common/context.js";
import { SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT, SEARCH_MAX_QUERY, SearchService } from "./search.service.js";

const SearchQuery = z.object({
  q: z.string().max(SEARCH_MAX_QUERY * 2).default(""),
  limit: z.coerce.number().int().min(1).max(SEARCH_MAX_LIMIT).default(SEARCH_DEFAULT_LIMIT),
});

@ApiTags("search")
@Controller("workspaces/:workspaceId/search")
export class SearchController {
  constructor(private readonly search: SearchService) {}

  /**
   * Any member may call it; each group is filtered by the permission its own
   * list endpoint needs (a group the role cannot read is absent). Typing in
   * the palette is debounced, so a modest per-client limit is plenty.
   */
  @Throttle({ default: { limit: Number(process.env.SEARCH_RATE_LIMIT ?? 120), ttl: 60_000 } })
  @Get()
  find(@Ctx() ctx: RequestContext, @Query(SearchQuery) q: z.infer<typeof SearchQuery>) {
    return this.search.search(ctx, q.q, q.limit);
  }
}

/** Global search across a workspace (the ⌘K palette and MCP global_search). */
@Module({ controllers: [SearchController], providers: [SearchService], exports: [SearchService] })
export class SearchModule {}
