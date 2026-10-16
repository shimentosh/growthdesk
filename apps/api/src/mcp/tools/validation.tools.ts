import { z } from "zod";
import { EmailValidationService } from "../../core/email-validation.service.js";
import { CatalogSyncService } from "../../catalog-sync/catalog-sync.service.js";
import { defineTool } from "../tool.js";

/*
 * Read-only checks around data quality: the platform's contact email
 * validation (its settings are platform-admin only and stay out of MCP), and
 * the product catalog synced from the client portal (pushing a sync is the
 * portal's job — a manual push could archive products — so only its status
 * is exposed).
 */

export const VALIDATION_TOOLS = [
  defineTool({
    name: "check_email",
    title: "Check an email address",
    description:
      "Runs the platform's contact email validation on one address before adding it: syntax, blocked domains, disposable providers, role accounts (info@, sales@…) and whether the domain accepts mail — whichever checks the platform has turned on. Returns ok, and when not ok the reason and a message. Creating or importing a contact applies the same rules automatically (a refusal comes back with code email_rejected).",
    input: z.object({ email: z.string().trim().min(3).max(320).describe("The email address to check.") }),
    permission: "contacts.read",
    risk: "read",
    idempotent: true,
    handler: async (_ctx, args, deps) => deps.get(EmailValidationService).check(args.email),
  }),

  defineTool({
    name: "catalog_sync_status",
    title: "Product catalog sync status",
    description:
      "Where the product catalog comes from and how fresh it is: per source (e.g. the client portal), how many products and how many active, and when it last synced. The portal pushes the whole catalog itself; this tool only reports.",
    input: z.object({}),
    permission: "quotes.read",
    risk: "read",
    idempotent: true,
    handler: async (ctx, _args, deps) => ({ sources: await deps.get(CatalogSyncService).status(ctx) }),
  }),
];
