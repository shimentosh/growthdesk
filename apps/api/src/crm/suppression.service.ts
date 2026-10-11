import { Injectable } from "@nestjs/common";
import { emailDomain, normalizeDomain, normalizeEmail, normalizePhone, type SuppressionKind, type SuppressionScope } from "@growthdesk/shared";
import { PrismaService, type Tx } from "../prisma/prisma.service.js";
import { badRequest, notFound } from "../common/errors.js";
import { derivedKey, hmac } from "../common/crypto.js";

/** The sending engine asking whether it may contact someone. */
export type SendingEngine = Exclude<SuppressionScope, "all">;

/** Value prefix of the suppression rows a GDPR erasure leaves behind (ContactPrivacyService.erase). */
export const ERASED_PREFIX = "erased:";

/*
 * The do-not-contact list. Checked by every outbound path (campaign engine,
 * inbox compose, WhatsApp/Telegram, calling) immediately before it acts —
 * not only when a contact is enrolled — so an unsubscribe that lands between
 * two steps still stops the next one.
 *
 * Each entry has a scope. `all` (bounces, complaints, do-not-contact, manual
 * by default) stops every engine; `outreach` and `marketing` stop only their
 * own, so unsubscribing from a newsletter does not cut off a sales thread.
 */
@Injectable()
export class SuppressionService {
  constructor(private readonly prisma: PrismaService) {}

  normalize(kind: SuppressionKind, value: string): string {
    const v =
      kind === "email" ? normalizeEmail(value) : kind === "domain" ? normalizeDomain(value) : normalizePhone(value) ?? value.replace(/[^\d+]/g, "");
    if (!v) throw badRequest(`That is not a valid ${kind}`);
    return v;
  }

  async add(workspaceId: string, kind: SuppressionKind, value: string, reason: string, source = "", createdById: string | null = null, tx?: Tx, scope: SuppressionScope = "all") {
    const db = tx ?? this.prisma.db;
    const normalized = this.normalize(kind, value);
    return db.suppression.upsert({
      where: { workspaceId_scope_kind_value: { workspaceId, scope, kind, value: normalized } },
      create: { workspaceId, kind, value: normalized, scope, reason, source, createdById },
      update: {},
    });
  }

  async remove(workspaceId: string, id: string) {
    const res = await this.prisma.db.suppression.deleteMany({ where: { workspaceId, id } });
    if (!res.count) throw notFound("That suppression entry");
  }

  async list(workspaceId: string, q: string | undefined, page: number, pageSize: number) {
    const where = { workspaceId, ...(q ? { value: { contains: q.toLowerCase() } } : {}) };
    const [items, total] = await Promise.all([
      this.prisma.db.suppression.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize }),
      this.prisma.db.suppression.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  /**
   * The stand-in an erased person's address or number is kept as: a keyed
   * hash (HMAC under a key derived from ENCRYPTION_KEY, salted with the
   * workspace id), so the suppression list can recognise them again without
   * holding the address itself, and the same person cannot be linked across
   * workspaces from the database alone.
   */
  static erasureValue(workspaceId: string, kind: "email" | "phone", normalized: string): string {
    return `${ERASED_PREFIX}${hmac(derivedKey("gdpr-erasure"), `${workspaceId}|${kind}|${normalized}`)}`;
  }

  /** Adds the hashed "erased" entries for these (already normalised) addresses and numbers. */
  async addErased(tx: Tx, workspaceId: string, emails: string[], phones: string[], createdById: string | null) {
    const rows = [
      ...emails.map((v) => ({ kind: "email" as const, value: SuppressionService.erasureValue(workspaceId, "email", v) })),
      ...phones.map((v) => ({ kind: "phone" as const, value: SuppressionService.erasureValue(workspaceId, "phone", v) })),
    ];
    for (const r of rows) {
      await tx.suppression.upsert({
        where: { workspaceId_scope_kind_value: { workspaceId, scope: "all", kind: r.kind, value: r.value } },
        create: { workspaceId, kind: r.kind, value: r.value, scope: "all", reason: "erased", source: "gdpr_erasure", createdById },
        update: {},
      });
    }
    return rows.length;
  }

  /** Whether any of these normalised addresses or numbers belonged to someone whose data was erased. */
  async isErased(workspaceId: string, emails: string[], phones: string[], tx?: Tx): Promise<boolean> {
    if (!emails.length && !phones.length) return false;
    const db = tx ?? this.prisma.db;
    const values = [
      ...emails.map((v) => SuppressionService.erasureValue(workspaceId, "email", v)),
      ...phones.map((v) => SuppressionService.erasureValue(workspaceId, "phone", v)),
    ];
    return (await db.suppression.count({ where: { workspaceId, value: { in: values } } })) > 0;
  }

  /** Scopes that stop `engine`. */
  static scopesFor(engine: SendingEngine): SuppressionScope[] {
    return ["all", engine];
  }

  /** The reason an address or number is suppressed for `engine`, or null when it may be contacted. */
  async check(workspaceId: string, target: { email?: string | null; phone?: string | null }, tx?: Tx, engine: SendingEngine = "outreach"): Promise<string | null> {
    const db = tx ?? this.prisma.db;
    const or: { kind: SuppressionKind; value: string }[] = [];
    const email = normalizeEmail(target.email ?? null);
    if (email) {
      or.push({ kind: "email", value: email });
      or.push({ kind: "email", value: SuppressionService.erasureValue(workspaceId, "email", email) });
      or.push({ kind: "domain", value: emailDomain(email) });
    }
    const phone = normalizePhone(target.phone ?? null);
    if (phone) {
      or.push({ kind: "phone", value: phone });
      or.push({ kind: "phone", value: SuppressionService.erasureValue(workspaceId, "phone", phone) });
    }
    if (!or.length) return null;
    const hit = await db.suppression.findFirst({ where: { workspaceId, scope: { in: SuppressionService.scopesFor(engine) }, OR: or } });
    if (!hit) return null;
    if (hit.value.startsWith(ERASED_PREFIX)) return "This person's data was erased on their request; they must not be contacted";
    return `${hit.value} is on the do-not-contact list${hit.scope === "all" ? "" : ` for ${hit.scope}`} (${hit.reason})`;
  }
}
