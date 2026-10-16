import { z } from "zod";
import { EMAIL_FONTS, EmailTheme, designProblems, renderLibraryPreview, type EmailBlock } from "@growthdesk/shared";
import { badRequest } from "../../../common/errors.js";
import { DesignsService, readBlocks, readTheme } from "../../../marketing/designs.service.js";
import { MarketingAssetsService } from "../../../marketing/assets.service.js";
import { MarketingCampaignsService } from "../../../marketing/campaigns.service.js";
import { DesignLibraryService } from "../../../design-library/design-library.service.js";
import { defineTool, pageInput, paged, type McpCtx, type McpDeps } from "../../tool.js";
import { BlockOp, applyBlockOps, looseBlock, normalizeBlocks, outline } from "./helpers.js";
import { fetchImage, fileNameFrom } from "./image-fetch.js";

/*
 * Email designs (reusable block layouts), the admin-curated template library,
 * previews and image uploads. Permissions as marketing.controller.ts and
 * design-library.controller.ts: marketing.read to look, marketing.write to change.
 */

const designId = z.string().uuid().describe("The design's id (from list_designs or create_design).");

/** The block cheat sheet, for get_design_block_reference and the tool descriptions. */
export const BLOCK_REFERENCE = `Email design = { theme, blocks[] }. Each block: { type, id, ...fields }. Text fields accept **bold**, *italic*, [label](https://link) and line breaks (never HTML). Personalise with {{first_name|there}} (value|fallback), {{last_name}}, {{full_name}}, {{company}}, {{job_title}}, {{city}}, {{email}}. Links must be full https:// URLs (or mailto:, or a {{token}}). Hex colours like #0071e3.

Block types (defaults in brackets):
- header: logo (image URL), brand (wordmark text), tagline, align [left], background, color
- hero: eyebrow, title, text, image, buttonLabel, buttonUrl, align [center], background, color
- heading: text, level 1|2 [1], align [left]
- text: text (up to 10,000 chars), align [left]
- button: label ["Learn more"], url, align [center], color
- image: src (https URL — use upload_image_from_url to host one), alt, href (link), width 10–100 (% of column) [100]
- columns: items: 2–3 × { image, title, text, linkLabel, linkUrl }, align
- quote: text, author, role
- callout: title, text, background, align [center] — a tinted box for an offer, code or deadline
- list: items: 1–12 strings, ordered [false]
- social: links: up to 8 × { network: website|linkedin|x|facebook|instagram|youtube|tiktok|github, url }, align [center]
- divider: (no fields)
- spacer: height 4–120 px [24]

Theme (all optional): background, surface (the card), text, heading, muted, accent (buttons/links), accentText, tint (hero/callout/header bands), font & headingFont (${Object.keys(EMAIL_FONTS).join(" | ")}), radius 0–32, buttonRadius 0–40.

The footer (legal name, postal address, unsubscribe link) is added automatically on send — never add one yourself.`;

const designSummary = (d: Awaited<ReturnType<DesignsService["get"]>>) => ({
  id: d.id,
  name: d.name,
  blocks: d.blocks.length,
  fromLibrary: d.fromLibrary,
  updatedAt: d.updatedAt,
});

const designView = (d: Awaited<ReturnType<DesignsService["get"]>>) => ({
  id: d.id,
  name: d.name,
  theme: d.theme,
  blocks: d.blocks,
  problems: designProblems(d.blocks),
});

async function profileFooter(ctx: McpCtx, deps: McpDeps) {
  const p = await deps.prisma.db.workspace.findUniqueOrThrow({ where: { id: ctx.workspace.id }, select: { legalName: true, postalAddress: true } });
  return { legalName: p.legalName || undefined, postalAddress: p.postalAddress || undefined };
}

const HTML_CAP = 20_000;

function rendered(blocks: EmailBlock[], theme: unknown, footer: { legalName?: string; postalAddress?: string }, includeHtml: boolean) {
  const { html, text } = renderLibraryPreview(blocks, readTheme(theme), footer);
  return {
    problems: designProblems(blocks),
    outline: outline(blocks),
    text: text.length > 4000 ? `${text.slice(0, 4000)}\n…` : text,
    htmlBytes: Buffer.byteLength(html),
    ...(includeHtml ? { html: html.length > HTML_CAP ? `${html.slice(0, HTML_CAP)}<!-- … cut at ${HTML_CAP} characters -->` : html } : {}),
    note: "Rendered with a sample contact (first name Alex). The footer with legal name, address and unsubscribe link is added on every send.",
  };
}

export const DESIGN_TOOLS = [
  defineTool({
    name: "get_design_block_reference",
    title: "Email block reference",
    description: "The cheat sheet for email designs: every block type with its fields, the theme fields, text markup and personalisation tokens. Read it before writing blocks for create_design or update_design.",
    input: z.object({}),
    permission: "marketing.read",
    risk: "read",
    handler: async () => BLOCK_REFERENCE,
  }),

  defineTool({
    name: "list_designs",
    title: "List email designs",
    description: "The workspace's saved email designs (most recently edited first): id, name, number of blocks, whether it came from the template library. Campaigns copy a design's content.",
    input: z.object({ search: z.string().trim().max(120).optional(), ...pageInput }),
    permission: "marketing.read",
    risk: "read",
    handler: async (ctx, args, deps) => {
      const q = args.search?.toLowerCase();
      const rows = (await deps.get(DesignsService).list(ctx)).filter((d) => !q || d.name.toLowerCase().includes(q));
      const start = (args.page - 1) * args.limit;
      return paged(rows.slice(start, start + args.limit).map(designSummary), rows.length, args.page, args.limit);
    },
  }),

  defineTool({
    name: "get_design",
    title: "Get an email design",
    description: "One design in full: theme, every block (with ids for update_design's block operations) and any problems that would stop it from sending.",
    input: z.object({ designId }),
    permission: "marketing.read",
    risk: "read",
    handler: async (ctx, args, deps) => designView(await deps.get(DesignsService).get(ctx, args.designId)),
  }),

  defineTool({
    name: "list_design_templates",
    title: "List design templates",
    description: "The template library curated by Growthdesk (newsletter, product launch, promo, webinar…): id, name, category, description and its block types. Start a design from one with create_design { templateId }.",
    input: z.object({ category: z.string().trim().max(60).optional() }),
    permission: "marketing.read",
    risk: "read",
    handler: async (_ctx, args, deps) => {
      const rows = await deps.get(DesignLibraryService).published();
      const cat = args.category?.toLowerCase();
      return {
        items: rows
          .filter((r) => !cat || r.category.toLowerCase().includes(cat))
          .map((r) => ({ templateId: r.id, name: r.name, category: r.category, description: r.description, blocks: r.blocks.map((b) => b.type).join(", ") })),
      };
    },
  }),

  defineTool({
    name: "create_design",
    title: "Create an email design",
    description:
      "Creates a design: from a library template (templateId from list_design_templates — recommended), or from your own theme and blocks (see get_design_block_reference), or a simple starter when neither is given. name is optional with a template (the template's name is used).",
    input: z.object({
      name: z.string().trim().min(1).max(120).optional(),
      templateId: z.string().uuid().optional().describe("A template from list_design_templates to copy."),
      theme: EmailTheme.optional(),
      blocks: z.array(looseBlock).max(100).optional().describe("The blocks, in order. Ignored when templateId is given (edit afterwards with update_design)."),
    }),
    permission: "marketing.write",
    risk: "write",
    idempotent: false,
    handler: async (ctx, args, deps) => {
      const designs = deps.get(DesignsService);
      if (args.templateId) {
        let d = await deps.get(DesignLibraryService).use(ctx, args.templateId);
        if ((args.name && args.name !== d.name) || args.theme) {
          d = await designs.update(ctx, d.id, { ...(args.name ? { name: args.name } : {}), ...(args.theme ? { theme: { ...d.theme, ...args.theme } } : {}) });
        }
        return designView(d);
      }
      if (!args.name) throw badRequest("Give the design a name (or start from a templateId).", { name: "Required" });
      const blocks = args.blocks ? normalizeBlocks(args.blocks) : undefined;
      return designView(await designs.create(ctx, { name: args.name, blocks, theme: args.theme }));
    },
  }),

  defineTool({
    name: "update_design",
    title: "Edit an email design",
    description:
      "Changes a design. name; theme (fields given are merged into the current theme; resetTheme clears it first); blocks (replaces ALL blocks) or blockOps — targeted edits applied in order: { op: \"update\", id, fields } sets fields on one block, { op: \"replace\", id, block }, { op: \"insert\", block, afterId | beforeId | position }, { op: \"remove\", id }, { op: \"move\", id, afterId | beforeId | position }. Block ids come from get_design. Campaigns already made from it keep their own copy (re-apply with update_marketing_campaign { designId }).",
    input: z.object({
      designId,
      name: z.string().trim().min(1).max(120).optional(),
      theme: EmailTheme.optional(),
      resetTheme: z.boolean().optional(),
      blocks: z.array(looseBlock).max(100).optional(),
      blockOps: z.array(BlockOp).max(50).optional(),
    }),
    permission: "marketing.write",
    risk: "write",
    handler: async (ctx, args, deps) => {
      if (args.blocks && args.blockOps) throw badRequest("Give either blocks (the whole list) or blockOps (edits), not both.");
      const designs = deps.get(DesignsService);
      const current = await designs.get(ctx, args.designId);
      const blocks = args.blocks ? normalizeBlocks(args.blocks) : args.blockOps?.length ? applyBlockOps(current.blocks, args.blockOps) : undefined;
      const theme = args.resetTheme || args.theme ? { ...(args.resetTheme ? {} : current.theme), ...(args.theme ?? {}) } : undefined;
      if (args.name === undefined && !blocks && !theme) throw badRequest("Nothing to change: give name, theme, blocks or blockOps.");
      return designView(await designs.update(ctx, args.designId, { ...(args.name !== undefined ? { name: args.name } : {}), ...(blocks ? { blocks } : {}), ...(theme ? { theme } : {}) }));
    },
  }),

  defineTool({
    name: "preview_design",
    title: "Preview an email",
    description:
      "Renders a design (or a campaign's current content) as the recipient would see it: the plain-text version, an outline of the blocks, the size of the HTML, and problems that would stop it from sending. includeHtml adds the HTML (cut at 20,000 characters).",
    input: z.object({
      designId: z.string().uuid().optional(),
      campaignId: z.string().uuid().optional().describe("Preview a marketing campaign's content instead of a design."),
      includeHtml: z.boolean().default(false),
    }),
    permission: "marketing.read",
    risk: "read",
    handler: async (ctx, args, deps) => {
      if (!args.designId === !args.campaignId) throw badRequest("Give a designId or a campaignId.");
      const footer = await profileFooter(ctx, deps);
      if (args.designId) {
        const d = await deps.get(DesignsService).get(ctx, args.designId);
        return { designId: d.id, name: d.name, ...rendered(d.blocks, d.theme, footer, args.includeHtml) };
      }
      const c = await deps.get(MarketingCampaignsService).get(ctx, args.campaignId!);
      return { campaignId: c.id, name: c.name, subject: c.subject, preheader: c.preheader, ...rendered(readBlocks(c.blocks), c.theme, footer, args.includeHtml) };
    },
  }),

  defineTool({
    name: "duplicate_design",
    title: "Duplicate an email design",
    description: "Copies a design as \"<name> (copy)\" — to try a variation without touching the original.",
    input: z.object({ designId }),
    permission: "marketing.write",
    risk: "write",
    idempotent: false,
    handler: async (ctx, args, deps) => designSummary(await deps.get(DesignsService).duplicate(ctx, args.designId)),
  }),

  defineTool({
    name: "delete_design",
    title: "Delete an email design",
    description: "Removes a design from the workspace's designs. Campaigns made from it keep their own copy of its content.",
    input: z.object({ designId }),
    permission: "marketing.write",
    risk: "important",
    preview: async (ctx, args, deps) => {
      const d = await deps.get(DesignsService).get(ctx, args.designId);
      if (d.archivedAt) throw badRequest(`"${d.name}" is already deleted.`);
      const used = await deps.prisma.db.marketingCampaign.count({ where: { workspaceId: ctx.workspace.id, designId: d.id, deletedAt: null } });
      return {
        summary: `Delete the email design "${d.name}" (${d.blocks.length} blocks).${used ? ` ${used} campaign(s) were made from it; they keep their own copy.` : ""}`,
        details: { designId: d.id, name: d.name, campaignsMadeFromIt: used },
      };
    },
    handler: async (ctx, args, deps) => ({ designId: args.designId, ...(await deps.get(DesignsService).archive(ctx, args.designId)) }),
  }),

  defineTool({
    name: "upload_image_from_url",
    title: "Host an image from a link",
    description:
      "Downloads an image from a public https:// link and hosts it in the workspace (PNG, JPEG, GIF or WebP, up to 1 MB; never SVG), returning the hosted URL to use in image, hero, header or columns blocks. The same image uploaded twice reuses the stored copy. Links to private networks are refused.",
    input: z.object({ url: z.string().trim().min(1).max(2000).describe("The image's https:// address."), fileName: z.string().trim().max(200).optional() }),
    permission: "marketing.write",
    risk: "write",
    handler: async (ctx, args, deps) => {
      const img = await fetchImage(args.url);
      const asset = await deps.get(MarketingAssetsService).upload(ctx, {
        data: img.bytes.toString("base64"),
        mime: img.contentType,
        fileName: args.fileName || fileNameFrom(img.finalUrl),
      });
      return { url: asset.url, assetId: asset.id, contentType: asset.contentType, bytes: asset.size };
    },
  }),
];
