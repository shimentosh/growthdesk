import {
  DEFAULT_DISCORD_TEMPLATE,
  DISCORD_LIMITS,
  DISCORD_PERMISSION,
  DiscordTemplateBody,
  discordBasePermissions,
  discordChannelPermissions,
  discordContextPaths,
  discordInstallPermissions,
  discordNonce,
  escapeDiscordMarkdown,
  evaluateDiscordConditions,
  hasDiscordPermission,
  normalizeDiscordChannelName,
  renderDiscordMessage,
  safeDiscordUrl,
  validateDiscordTemplate,
} from "../src/discord.js";

const ctx = {
  event: { type: "deal.won", label: "Deal won", link: "https://app.test/w/1/deals/2", occurredAt: "2026-10-16T10:00:00.000Z", actor: { name: "Priya" } },
  workspace: { name: "Acme" },
  contact: { fullName: "Lucas Ibrahim", email: "lucas@example.com", tags: ["vip", "enterprise"], company: { name: "Mosaic" }, owner: null },
  deal: { title: "Mosaic renewal", stage: "Won", value: 12000, valueFormatted: "$12,000.00" },
  payload: { toStage: "Won", value: 12000 },
};

const t = (over: Partial<ReturnType<typeof DiscordTemplateBody.parse>> = {}) => DiscordTemplateBody.parse({ ...over });

describe("discord templates", () => {
  it("renders the default template for any event, dropping fields with nothing behind them", () => {
    const r = renderDiscordMessage(DEFAULT_DISCORD_TEMPLATE, ctx);
    const e = r.message.embeds[0]!;
    expect(e.title).toBe("Deal won");
    expect(e.url).toBe("https://app.test/w/1/deals/2");
    expect(e.timestamp).toBe("2026-10-16T10:00:00.000Z");
    expect(e.fields?.map((f) => f.name)).toEqual(["Company", "Email", "Deal", "Stage", "Value", "By"]);
    expect(r.message.components[0]!.components[0]).toMatchObject({ type: 2, style: 5, label: "Open in Growthdesk", url: "https://app.test/w/1/deals/2" });
    expect(r.message.allowed_mentions).toEqual({ parse: [] });
    expect(r.missing).toContain("contact.owner.name");
    expect(r.skip).toBeNull();
  });

  it("renders for an event with no contact or deal at all", () => {
    const r = renderDiscordMessage(DEFAULT_DISCORD_TEMPLATE, { event: { type: "campaign.completed", label: "Campaign completed" } });
    expect(r.message.embeds[0]!.title).toBe("Campaign completed");
    expect(r.message.embeds[0]!.fields).toBeUndefined();
    expect(r.message.components).toEqual([]);
    expect(r.skip).toBeNull();
  });

  it("uses fallbacks, and holds the message back when told to and something is missing", () => {
    const tpl = t({ content: "Owner: {{contact.owner.name|nobody}} · {{deal.missing}}" });
    expect(renderDiscordMessage(tpl, ctx).message.content).toBe("Owner: nobody ·");
    const skip = renderDiscordMessage({ ...tpl, missing: "skip" }, ctx);
    expect(skip.skip).toMatch(/deal\.missing/);
  });

  it("joins lists and indexes into them", () => {
    expect(renderDiscordMessage(t({ content: "{{contact.tags}} / {{contact.tags.1}}" }), ctx).message.content).toBe("vip, enterprise / enterprise");
  });

  it("makes values from the event inert: no markdown, no links, no pings", () => {
    const hostile = { contact: { fullName: "**@everyone** [click](https://evil.test) <@123456789012345678> <@&123456789012345678>" } };
    const r = renderDiscordMessage(t({ content: "New lead: {{contact.fullName}}" }), hostile);
    const c = r.message.content;
    expect(c).not.toContain("@everyone");
    expect(c).not.toMatch(/<@\d/);
    expect(c).not.toMatch(/<@&\d/);
    expect(c).toContain("\\*\\*");
    expect(c).toContain("\\[click\\]");
    expect(r.message.allowed_mentions.parse).toEqual([]);
  });

  it("keeps the admin's own markdown but never @everyone / @here", () => {
    const r = renderDiscordMessage(t({ content: "**Heads up** @here — {{contact.fullName}}" }), ctx);
    expect(r.message.content.startsWith("**Heads up**")).toBe(true);
    expect(r.message.content).not.toContain("@here");
  });

  it("only lets absolute http(s) links into URLs", () => {
    expect(safeDiscordUrl("javascript:alert(1)")).toBe("");
    expect(safeDiscordUrl("/relative")).toBe("");
    expect(safeDiscordUrl("https://ok.test/a")).toBe("https://ok.test/a");
    const r = renderDiscordMessage(t({ embed: { ...DEFAULT_DISCORD_TEMPLATE.embed, url: "{{payload.url}}" }, buttons: [{ label: "Go", url: "{{payload.url}}" }] }), { payload: { url: "javascript:x" }, event: { label: "x" } });
    expect(r.message.embeds[0]!.url).toBeUndefined();
    expect(r.message.components).toEqual([]);
  });

  it("cuts everything to Discord's limits", () => {
    const long = "x".repeat(5000);
    const r = renderDiscordMessage(
      ({ ...t(), content: long, embed: { enabled: true, title: long.slice(0, 256), url: "", description: "{{v}}", color: "", author: "", footer: "", timestamp: false, fields: Array.from({ length: 25 }, (_, i) => ({ name: `f${i}`, value: "{{w}}", inline: false })) } }),
      { v: long, w: "y".repeat(1024) },
    );
    expect(r.message.content.length).toBe(DISCORD_LIMITS.content);
    const e = r.message.embeds[0]!;
    const total = (e.title?.length ?? 0) + (e.description?.length ?? 0) + (e.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0);
    expect(total).toBeLessThanOrEqual(DISCORD_LIMITS.embedTotal);
    expect(r.truncated).toEqual(expect.arrayContaining(["content", "embed"]));
  });

  it("refuses to send an empty message", () => {
    const r = renderDiscordMessage(t({ content: "{{nothing}}", embed: { ...DEFAULT_DISCORD_TEMPLATE.embed, enabled: false } }), {});
    expect(r.skip).toMatch(/empty/);
  });

  it("validates templates against the fields an event offers", () => {
    const known = discordContextPaths(ctx).map((p) => p.path);
    const ok = validateDiscordTemplate(t({ content: "{{contact.fullName}} {{deal.nope|-}}" }), known);
    expect(ok.errors).toEqual({});
    expect(ok.warnings).toEqual([]);
    const bad = validateDiscordTemplate(t({ content: "{{deal.nope}}", buttons: [{ label: "x", url: "ftp://x" }] }), known);
    expect(bad.errors["buttons.0.url"]).toBeDefined();
    expect(bad.warnings.join(" ")).toMatch(/deal\.nope/);
    expect(validateDiscordTemplate(t({ content: "", embed: { ...DEFAULT_DISCORD_TEMPLATE.embed, title: "", description: "", fields: [] } })).errors.content).toBeDefined();
  });

  it("lists every leaf path with an example", () => {
    const paths = discordContextPaths(ctx);
    expect(paths).toContainEqual({ path: "contact.company.name", example: "Mosaic" });
    expect(paths).toContainEqual({ path: "contact.tags", example: "vip, enterprise" });
  });

  it("escapes markdown so Discord shows it literally", () => {
    expect(escapeDiscordMarkdown("a_b*c")).toBe("a\\_b\\*c");
  });
});

describe("discord conditions", () => {
  it("evaluates every operator against the context", () => {
    const ev = (field: string, op: Parameters<typeof evaluateDiscordConditions>[0][number]["op"], value = "") => evaluateDiscordConditions([{ field, op, value }], ctx).met;
    expect(ev("deal.stage", "is", "won")).toBe(true);
    expect(ev("deal.stage", "is_not", "won")).toBe(false);
    expect(ev("contact.tags", "is", "VIP")).toBe(true);
    expect(ev("contact.tags", "contains", "enter")).toBe(true);
    expect(ev("contact.tags", "not_contains", "smb")).toBe(true);
    expect(ev("deal.value", "gt", "10000")).toBe(true);
    expect(ev("deal.value", "lt", "10000")).toBe(false);
    expect(ev("contact.owner.name", "exists")).toBe(false);
    expect(ev("contact.owner.name", "not_exists")).toBe(true);
    expect(ev("deal.value", "gt", "abc")).toBe(false);
  });

  it("reports the first condition that failed", () => {
    const r = evaluateDiscordConditions([{ field: "deal.stage", op: "is", value: "Won" }, { field: "deal.value", op: "gt", value: "50000" }], ctx);
    expect(r).toEqual({ met: false, failed: { field: "deal.value", op: "gt", value: "50000" } });
  });
});

describe("discord permissions", () => {
  const guildId = "100000000000000001";
  const bot = "200000000000000002";
  const role = "300000000000000003";
  const roles = [
    { id: guildId, permissions: String(DISCORD_PERMISSION.VIEW_CHANNEL) },
    { id: role, permissions: String(DISCORD_PERMISSION.SEND_MESSAGES | DISCORD_PERMISSION.EMBED_LINKS) },
  ];

  it("asks for Manage Channels only when channel management is wanted", () => {
    expect(BigInt(discordInstallPermissions(false)) & DISCORD_PERMISSION.MANAGE_CHANNELS).toBe(0n);
    expect(BigInt(discordInstallPermissions(true)) & DISCORD_PERMISSION.MANAGE_CHANNELS).toBe(DISCORD_PERMISSION.MANAGE_CHANNELS);
  });

  it("combines @everyone and the bot's roles, then applies channel overwrites in Discord's order", () => {
    const base = discordBasePermissions({ guildId, ownerId: "1", userId: bot, roles, memberRoleIds: [role] });
    expect(hasDiscordPermission(base, DISCORD_PERMISSION.SEND_MESSAGES)).toBe(true);
    // @everyone loses View Channel in a private channel; the bot's role does not get it back.
    const hidden = discordChannelPermissions(base, { guildId, userId: bot, memberRoleIds: [role], overwrites: [{ id: guildId, type: 0, allow: "0", deny: String(DISCORD_PERMISSION.VIEW_CHANNEL) }] });
    expect(hasDiscordPermission(hidden, DISCORD_PERMISSION.VIEW_CHANNEL)).toBe(false);
    // …unless the bot itself is allowed in.
    const allowed = discordChannelPermissions(base, {
      guildId,
      userId: bot,
      memberRoleIds: [role],
      overwrites: [
        { id: guildId, type: 0, allow: "0", deny: String(DISCORD_PERMISSION.VIEW_CHANNEL) },
        { id: bot, type: 1, allow: String(DISCORD_PERMISSION.VIEW_CHANNEL), deny: "0" },
      ],
    });
    expect(hasDiscordPermission(allowed, DISCORD_PERMISSION.VIEW_CHANNEL)).toBe(true);
  });

  it("treats Administrator as everything", () => {
    const base = discordBasePermissions({ guildId, ownerId: "1", userId: bot, roles: [{ id: guildId, permissions: String(DISCORD_PERMISSION.ADMINISTRATOR) }], memberRoleIds: [] });
    const ch = discordChannelPermissions(base, { guildId, userId: bot, memberRoleIds: [], overwrites: [{ id: guildId, type: 0, allow: "0", deny: String(DISCORD_PERMISSION.VIEW_CHANNEL) }] });
    expect(hasDiscordPermission(ch, DISCORD_PERMISSION.SEND_MESSAGES)).toBe(true);
  });
});

describe("discord helpers", () => {
  it("normalises channel names like Discord does", () => {
    expect(normalizeDiscordChannelName("  Deals Won!! 2026 ")).toBe("deals-won-2026");
  });
  it("makes a stable nonce within Discord's 25 characters", () => {
    const n = discordNonce("01a1405e-4ed0-73c0-84e0-3fdb4c78ac17");
    expect(n).toHaveLength(25);
    expect(discordNonce("01a1405e-4ed0-73c0-84e0-3fdb4c78ac17")).toBe(n);
  });
});
