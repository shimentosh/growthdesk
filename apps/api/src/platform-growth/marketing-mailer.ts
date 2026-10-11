import { Inject, Injectable } from "@nestjs/common";
import { EmailBlocks, type EmailBlock, PLATFORM_MARKETING_VARIABLES } from "@growthdesk/shared";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { BrandingService } from "../core/branding.service.js";
import { PlatformMailService } from "../platform-mail/platform-mail.service.js";
import type { OutgoingMail } from "../platform-mail/provider.js";
import { tagValue } from "../platform-mail/provider.js";
import { type Brand, contentProblems, renderPlatformMarketing } from "../platform-mail/render.js";
import type { PlatformTemplateContent } from "../platform-mail/catalog.js";
import { listUnsubscribeHeaders, marketingToken, oneClickUrl, preferencesPageUrl } from "./unsubscribe-token.js";

/*
 * Builds one platform-marketing email (broadcast, drip step, test send):
 * the content rendered for this person with the marketing footer, the
 * marketing From / Reply-To, RFC 8058 List-Unsubscribe headers and tags.
 */

export const MARKETING_VARIABLE_KEYS = PLATFORM_MARKETING_VARIABLES.map((v) => v.key);

/** Problems that stop marketing content from being scheduled or activated. */
export const marketingProblems = (content: PlatformTemplateContent) => contentProblems(content, MARKETING_VARIABLE_KEYS);

/** Stored blocks (Json) → blocks; anything malformed renders as nothing rather than throwing mid-send. */
export function blocksOf(raw: unknown): EmailBlock[] {
  const parsed = EmailBlocks.safeParse(raw);
  return parsed.success ? parsed.data : [];
}

export const contentOf = (row: { subject: string; preheader: string; blocks: unknown }): PlatformTemplateContent => ({
  subject: row.subject,
  preheader: row.preheader,
  blocks: blocksOf(row.blocks),
});

export type Recipient = { id: string; email: string; name: string };

@Injectable()
export class MarketingMailer {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly branding: BrandingService,
    private readonly mail: PlatformMailService,
  ) {}

  async brand(): Promise<Brand> {
    const b = await this.branding.get();
    return { productName: b.productName, supportEmail: b.supportEmail, primaryColor: b.primaryColor };
  }

  envelope() {
    return this.mail.envelope("marketing");
  }

  links(userId: string, emailLogId: string | null) {
    const token = marketingToken({ userId, emailLogId });
    return { token, page: preferencesPageUrl(this.config.PUBLIC_APP_URL, token), oneClick: oneClickUrl(this.config.PUBLIC_APP_URL, token) };
  }

  /** Sample rendering for the admin preview (no real recipient). */
  preview(content: PlatformTemplateContent, brand: Brand) {
    const sample = Object.fromEntries(PLATFORM_MARKETING_VARIABLES.map((v) => [v.key, v.sample]));
    return renderPlatformMarketing(content, { name: sample.name }, brand, `${this.config.PUBLIC_APP_URL.replace(/\/+$/, "")}/email-preferences/preview`);
  }

  /** One addressed email. `kind` and `ref` go into the tags ("broadcast"/"drip", the broadcast or step id). */
  build(
    content: PlatformTemplateContent,
    to: Recipient,
    emailLogId: string | null,
    ctx: { brand: Brand; from: string; replyTo: string | undefined; kind: "broadcast" | "drip" | "test"; ref: string; subjectPrefix?: string },
  ): OutgoingMail {
    const links = this.links(to.id, emailLogId);
    const r = renderPlatformMarketing(content, { name: to.name || null }, ctx.brand, links.page);
    return {
      from: ctx.from,
      to: to.email,
      subject: `${ctx.subjectPrefix ?? ""}${r.subject}`.slice(0, 998),
      html: r.html,
      text: r.text,
      replyTo: ctx.replyTo,
      headers: listUnsubscribeHeaders(links.oneClick, ctx.replyTo),
      tags: [
        { name: "template", value: ctx.kind },
        { name: "stream", value: "marketing" },
        { name: ctx.kind === "drip" ? "drip_step_id" : "broadcast_id", value: tagValue(ctx.ref) },
      ],
    };
  }
}
