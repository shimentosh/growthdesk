import { Inject, Injectable, Logger } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { normalizeEmail, permissionsFor, type RolePermissionOverrides } from "@growthdesk/shared";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { PrismaService } from "../prisma/prisma.service.js";
import type { Mailbox } from "../generated/prisma/client.js";
import { EntitlementsService } from "../billing/entitlements.service.js";
import { AuditService } from "../core/audit.service.js";
import { OAUTH_PROVIDERS } from "../messaging/mailbox-auth.service.js";
import { dropTransport, verifySmtp } from "../messaging/smtp.js";
import { derivedKey, hmac, safeEqual, seal } from "../common/crypto.js";
import { me, ws, type RequestContext } from "../common/context.js";
import { isApiError, notFound, unavailable } from "../common/errors.js";
import { MailboxesService } from "./mailboxes.service.js";

export type OAuthProvider = "gmail" | "microsoft";
export const isOAuthProvider = (p: string): p is OAuthProvider => p === "gmail" || p === "microsoft";

const STATE_TTL_MS = 10 * 60_000;
const LABEL: Record<OAuthProvider, string> = { gmail: "Google", microsoft: "Microsoft 365" };
const ENV: Record<OAuthProvider, string> = { gmail: "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET", microsoft: "MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET" };

type State = { w: string; u: string; p: OAuthProvider; exp: number; n: string };

/** A failure to show the person on the mailboxes page (as ?error=). */
class FlowError extends Error {}

/*
 * "Connect with Google / Microsoft 365" for sending mailboxes.
 *
 * The state parameter is an HMAC-signed (key derived for "mailbox-oauth")
 * payload naming the workspace, the person and the provider, valid for ten
 * minutes. The callback additionally requires the browser's own session to
 * be that same person — otherwise someone could start a flow for their
 * workspace and trick another person into completing it with their mailbox —
 * and re-checks that they still hold integrations.manage there.
 *
 * The refresh token is sealed into `secretSealed`, the access token and its
 * expiry into `oauthAccessSealed`/`oauthExpiresAt`; MailboxAuthService
 * refreshes from there. SMTP is proved over XOAUTH2 before anything is stored.
 */
@Injectable()
export class MailboxOAuthService {
  private readonly log = new Logger("mailbox-oauth");

  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly mailboxes: MailboxesService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private base() {
    return this.config.PUBLIC_APP_URL.replace(/\/+$/, "");
  }

  redirectUri(provider: OAuthProvider) {
    return `${this.base()}/api/mailboxes/oauth/${provider}/callback`;
  }

  /** The OAuth client, or a clear 503 when this installation has none. */
  client(provider: OAuthProvider) {
    const id = provider === "gmail" ? this.config.GOOGLE_CLIENT_ID : this.config.MICROSOFT_CLIENT_ID;
    const secret = provider === "gmail" ? this.config.GOOGLE_CLIENT_SECRET : this.config.MICROSOFT_CLIENT_SECRET;
    if (!id || !secret) throw unavailable(`${LABEL[provider]} sign-in is not configured on this installation (set ${ENV[provider]}). Connect the mailbox with SMTP/IMAP instead.`);
    return { id, secret };
  }

  signState(state: State): string {
    const body = Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
    return `${body}.${hmac(derivedKey("mailbox-oauth"), body, "base64url")}`;
  }

  readState(raw: string | undefined): State | null {
    const [body, sig, extra] = String(raw ?? "").split(".");
    if (!body || !sig || extra !== undefined) return null;
    if (!safeEqual(sig, hmac(derivedKey("mailbox-oauth"), body, "base64url"))) return null;
    try {
      const s = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as State;
      if (!s || typeof s.w !== "string" || typeof s.u !== "string" || !isOAuthProvider(s.p) || typeof s.exp !== "number") return null;
      if (s.exp < Date.now()) return null;
      return s;
    } catch {
      return null;
    }
  }

  async start(ctx: RequestContext, provider: string) {
    if (!isOAuthProvider(provider)) throw notFound("That mailbox provider");
    const w = ws(ctx);
    const client = this.client(provider);
    await this.entitlements.assertFullAccess(w.billingAccountId, "Connecting a mailbox");
    const state = this.signState({ w: w.id, u: me(ctx).userId, p: provider, exp: Date.now() + STATE_TTL_MS, n: randomBytes(9).toString("base64url") });
    const p = OAUTH_PROVIDERS[provider];
    const params = new URLSearchParams({
      client_id: client.id,
      redirect_uri: this.redirectUri(provider),
      response_type: "code",
      scope: p.scope,
      state,
      ...(provider === "gmail"
        ? { access_type: "offline", prompt: "consent", include_granted_scopes: "true" }
        : { response_mode: "query", prompt: "select_account" }),
    });
    const host = provider === "gmail" ? "https://accounts.google.com/o/oauth2/v2/auth" : `https://login.microsoftonline.com/${encodeURIComponent(this.config.MICROSOFT_TENANT)}/oauth2/v2.0/authorize`;
    return { url: `${host}?${params.toString()}` };
  }

  /** Handles the provider's redirect; returns where to send the browser next. */
  async callback(provider: string, query: { code?: string; state?: string; error?: string; error_description?: string }, ctx: RequestContext): Promise<string> {
    if (!isOAuthProvider(provider)) return `${this.base()}/?error=${encodeURIComponent("Unknown mailbox provider")}`;
    this.client(provider); // 503 when not configured
    const state = this.readState(query.state);
    if (!state || state.p !== provider) {
      return `${this.base()}/?error=${encodeURIComponent("That sign-in link has expired or is not valid. Start connecting the mailbox again.")}`;
    }
    const page = `${this.base()}/w/${state.w}/settings/mailboxes`;
    const fail = (message: string) => `${page}?error=${encodeURIComponent(message.slice(0, 300))}`;
    try {
      const box = await this.complete(provider, state, query, ctx);
      return `${page}?connected=1&mailbox=${encodeURIComponent(box.id)}`;
    } catch (e) {
      if (e instanceof FlowError) return fail(e.message);
      if (isApiError(e) && e.status === 503) throw e;
      if (isApiError(e)) return fail(e.message);
      this.log.error(`${provider} callback failed: ${e instanceof Error ? e.stack : String(e)}`);
      return fail(`${LABEL[provider]} sign-in could not be completed. Try again.`);
    }
  }

  private async complete(provider: OAuthProvider, state: State, query: { code?: string; error?: string; error_description?: string }, ctx: RequestContext): Promise<Mailbox> {
    if (query.error) throw new FlowError(query.error === "access_denied" ? `${LABEL[provider]} access was not granted.` : `${LABEL[provider]} said: ${query.error_description || query.error}`);
    if (!query.code) throw new FlowError(`${LABEL[provider]} did not return an authorisation code.`);

    // The browser finishing the flow must be the person who started it.
    if (!ctx.identity || ctx.identity.userId !== state.u) throw new FlowError("Sign in as the person who started connecting this mailbox, then try again.");
    const membership = await this.prisma.db.membership.findUnique({ where: { workspaceId_userId: { workspaceId: state.w, userId: state.u } }, include: { workspace: true } });
    if (!membership) throw new FlowError("You are no longer a member of that workspace.");
    const permissions = permissionsFor(membership.role, membership.workspace.rolePermissions as RolePermissionOverrides | null);
    if (!permissions.includes("integrations.manage")) throw new FlowError("Your role can no longer connect mailboxes in this workspace.");
    if (membership.workspace.status !== "active") throw new FlowError("This workspace is suspended.");
    const billingAccountId = membership.workspace.billingAccountId;
    await this.entitlements.assertFullAccess(billingAccountId, "Connecting a mailbox");

    const tokens = await this.exchange(provider, query.code);
    const email = await this.accountEmail(provider, tokens);
    if (!tokens.refresh_token) {
      throw new FlowError(`${LABEL[provider]} did not grant offline access. Remove Growthdesk from the account's connected apps and connect again.`);
    }

    const existing = await this.prisma.db.mailbox.findFirst({ where: { workspaceId: state.w, email } });
    if (!existing || existing.deletedAt) await this.entitlements.assertCapacity(billingAccountId, "mailboxes");

    const p = OAUTH_PROVIDERS[provider];
    const smtp = await verifySmtp({
      mailboxId: `probe-${state.n}`,
      host: p.smtp.host,
      port: p.smtp.port,
      security: p.smtp.security,
      auth: { user: email, accessToken: tokens.access_token },
      allowSelfSigned: false,
    });
    if (!smtp.ok) throw new FlowError(`${LABEL[provider]} accepted the sign-in, but its SMTP server refused to relay: ${smtp.error}`);

    const data = {
      provider,
      email,
      status: "connected" as const,
      lastError: "",
      lastCheckedAt: new Date(),
      smtpHost: p.smtp.host,
      smtpPort: p.smtp.port,
      smtpSecurity: p.smtp.security,
      smtpUser: email,
      imapEnabled: true,
      imapHost: p.imap.host,
      imapPort: p.imap.port,
      imapSecurity: p.imap.security,
      imapUser: email,
      secretSealed: seal(tokens.refresh_token),
      oauthAccessSealed: seal(tokens.access_token),
      oauthExpiresAt: new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000),
      oauthScope: (tokens.scope ?? p.scope).slice(0, 1000),
      syncError: "",
      deletedAt: null,
    };
    const sameServer = existing && existing.provider === provider && !existing.deletedAt;
    const box = existing
      ? await this.prisma.db.mailbox.update({
          where: { id: existing.id, workspaceId: state.w },
          // A different server (or a revived mailbox) starts its UID pointer over.
          data: { ...data, ...(sameServer ? {} : { imapUidValidity: null, imapUidNext: null, lastSyncedAt: null }) },
        })
      : await this.prisma.db.mailbox.create({ data: { workspaceId: state.w, createdById: state.u, displayName: "", ...data } });
    dropTransport(box.id);
    await this.audit.record(ctx, { workspaceId: state.w, action: existing && !existing.deletedAt ? "mailbox.reconnected" : "mailbox.connected", targetType: "mailbox", targetId: box.id, metadata: { email, provider } });
    await this.mailboxes.enqueueSync(state.w, box.id);
    return box;
  }

  private async exchange(provider: OAuthProvider, code: string) {
    const client = this.client(provider);
    const res = await fetch(OAUTH_PROVIDERS[provider].tokenUrl(this.config.MICROSOFT_TENANT), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        client_id: client.id,
        client_secret: client.secret,
        code,
        redirect_uri: this.redirectUri(provider),
        grant_type: "authorization_code",
        ...(provider === "microsoft" ? { scope: OAUTH_PROVIDERS.microsoft.scope } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    }).catch((e: unknown) => {
      throw new FlowError(`${LABEL[provider]} could not be reached: ${e instanceof Error ? e.message : String(e)}`);
    });
    const body = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
      id_token?: string;
      error?: string;
      error_description?: string;
    };
    if (!res.ok || !body.access_token) throw new FlowError(`${LABEL[provider]} refused the sign-in: ${body.error_description ?? body.error ?? `HTTP ${res.status}`}`);
    return body as typeof body & { access_token: string };
  }

  /** The mailbox address: Google's userinfo (verified addresses only), or the Microsoft id_token's claims. */
  private async accountEmail(provider: OAuthProvider, tokens: { access_token: string; id_token?: string }): Promise<string> {
    let raw: string | undefined;
    if (provider === "gmail") {
      const res = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { authorization: `Bearer ${tokens.access_token}` }, signal: AbortSignal.timeout(15_000) }).catch(() => null);
      const info = res?.ok ? ((await res.json().catch(() => ({}))) as { email?: string; email_verified?: boolean }) : {};
      if (info.email && info.email_verified === false) throw new FlowError("That Google account's address is not verified.");
      raw = info.email;
    } else {
      // Received directly from the token endpoint over TLS, so the claims are trusted without a signature check (OIDC Core §3.1.3.7).
      const payload = tokens.id_token?.split(".")[1];
      if (payload) {
        try {
          const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { email?: string; preferred_username?: string; upn?: string };
          raw = claims.email ?? claims.preferred_username ?? claims.upn;
        } catch {
          raw = undefined;
        }
      }
    }
    const email = normalizeEmail(raw ?? null);
    if (!email) throw new FlowError(`${LABEL[provider]} did not tell us the account's email address.`);
    return email;
  }
}

