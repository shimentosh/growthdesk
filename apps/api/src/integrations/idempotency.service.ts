import { Injectable } from "@nestjs/common";
import { IDEMPOTENCY_TTL_HOURS } from "@growthdesk/shared";
import { PrismaService } from "../prisma/prisma.service.js";
import { sha256 } from "../common/crypto.js";
import { ApiError, conflict } from "../common/errors.js";

/** A claim older than this is from a request that died mid-way; a retry may take it over. */
const STALE_CLAIM_MS = 5 * 60_000;
const TTL_MS = IDEMPOTENCY_TTL_HOURS * 3_600_000;
/** statusCode of a claimed key whose request is still running. */
const IN_PROGRESS = 0;

export type Idempotent<T> = { statusCode: number; body: T; replayed: boolean };

/** The fingerprint a key is bound to: the operation plus its validated input. */
export const fingerprint = (operation: string, input: unknown) => sha256(`${operation}\n${JSON.stringify(input)}`);

/*
 * `Idempotency-Key` for API writes, on the IdempotencyKey table
 * (unique per workspace + key).
 *
 *   1. A key is claimed (statusCode 0) before the work starts, so two
 *      concurrent requests with the same key cannot both run it — the second
 *      gets 409 until the first finishes.
 *   2. A successful response is stored and replayed, unchanged, to every
 *      retry with the same key and the same request for IDEMPOTENCY_TTL_HOURS.
 *   3. The same key with a different request is refused (409), never
 *      silently answered with the other request's result.
 *   4. A failed request releases its claim, so the client can retry it.
 */
@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  async run<T>(workspaceId: string, key: string | undefined, requestHash: string, work: () => Promise<{ statusCode: number; body: T }>): Promise<Idempotent<T>> {
    if (!key) return { ...(await work()), replayed: false };

    for (let attempt = 0; attempt < 2; attempt++) {
      const existing = await this.prisma.db.idempotencyKey.findFirst({ where: { workspaceId, key } });
      if (existing) {
        const age = Date.now() - existing.createdAt.getTime();
        const expired = age > TTL_MS;
        const abandoned = existing.statusCode === IN_PROGRESS && age > STALE_CLAIM_MS;
        if (expired || abandoned) {
          await this.prisma.db.idempotencyKey.deleteMany({ where: { id: existing.id, workspaceId } });
        } else {
          if (existing.requestHash !== requestHash) {
            throw conflict("This Idempotency-Key was already used for a different request. Use a new key for a new request.");
          }
          if (existing.statusCode === IN_PROGRESS) {
            throw conflict("A request with this Idempotency-Key is still being processed. Retry in a few seconds.");
          }
          return { statusCode: existing.statusCode, body: existing.response as T, replayed: true };
        }
      }

      let claimId: string;
      try {
        const claim = await this.prisma.db.idempotencyKey.create({
          data: { workspaceId, key, requestHash, statusCode: IN_PROGRESS, response: {} },
        });
        claimId = claim.id;
      } catch (e) {
        // Another request claimed the key between our read and write: look again.
        if ((e as { code?: string }).code === "P2002") continue;
        throw e;
      }

      try {
        const result = await work();
        await this.prisma.db.idempotencyKey.update({
          where: { id: claimId, workspaceId },
          data: { statusCode: result.statusCode, response: result.body as never },
        });
        return { ...result, replayed: false };
      } catch (e) {
        await this.prisma.db.idempotencyKey.deleteMany({ where: { id: claimId, workspaceId } }).catch(() => undefined);
        throw e;
      }
    }
    throw new ApiError(409, "conflict", "A request with this Idempotency-Key is still being processed. Retry in a few seconds.");
  }
}
