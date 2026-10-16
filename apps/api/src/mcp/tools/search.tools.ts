import { z } from "zod";
import { SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT, SEARCH_MAX_QUERY, SearchService } from "../../search/search.service.js";
import { defineTool } from "../tool.js";

/*
 * Global search through MCP: the same service as the ⌘K palette. Any member
 * may call it; SearchService leaves out each group the person's role (as
 * narrowed by the token) cannot read, and applies the usual ownership scopes.
 */
export const SEARCH_TOOLS = [
  defineTool({
    name: "global_search",
    title: "Search everything",
    description:
      "Find records across the workspace by name, email, subject or title: contacts and leads, companies, deals, inbox conversations, campaigns (outreach and marketing), lead lists, templates and email designs, workflows and tasks. " +
      "Results are grouped by kind, best matches first (exact, then prefix, then contains), at most `limit` per group, with `more: true` when a group has further matches — use the matching list/search tool for those. " +
      "Kinds your access cannot read are absent. Use the ids with the other tools (get_contact, get_deal, …).",
    input: z.object({
      query: z.string().trim().min(1).max(SEARCH_MAX_QUERY).describe("Text to look for (case-insensitive)."),
      limit: z.number().int().min(1).max(SEARCH_MAX_LIMIT).default(SEARCH_DEFAULT_LIMIT).describe(`Results per group, 1–${SEARCH_MAX_LIMIT}.`),
    }),
    permission: null,
    risk: "read",
    handler: async (ctx, args, deps) => {
      const r = await deps.get(SearchService).search(ctx, args.query, args.limit);
      const groups = Object.fromEntries(
        Object.entries(r.groups).map(([group, g]) => [
          group,
          {
            more: g.more,
            items: g.items.map(({ updatedAt: _u, ...hit }) => Object.fromEntries(Object.entries(hit).filter(([, v]) => v !== null && v !== undefined))),
          },
        ]),
      );
      return { query: r.q, groups };
    },
  }),
];
