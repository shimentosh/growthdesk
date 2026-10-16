/*
 * Shapes of the API-key and lead-ingest responses — apps/api/src/integrations.
 * The full key is part of a response once, on creation, and never again.
 */
import type { ApiScope, IntegrationApp } from "@growthdesk/shared";

export type ApiKeyStatus = "active" | "expired" | "revoked";

/** GET /api-keys — api-keys.service.ts `keyDto()` (active first, then expired, then revoked). */
export type ApiKey = {
  id: string;
  name: string;
  /** "gd_" + the next 8 characters, kept in clear so keys can be told apart. */
  prefix: string;
  scopes: ApiScope[];
  /** The app the key connects (Settings → Integrations); null for a general key. */
  app: IntegrationApp | null;
  status: ApiKeyStatus;
  createdBy: { id: string; name: string } | null;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

/** POST /api-keys — the key plus its secret (the only time it is returned). */
export type ApiKeyWithSecret = ApiKey & { secret: string };

/** GET /catalog/sync — catalog-sync.service.ts `status()`: per source, the products it owns. */
export type CatalogSource = { source: string; products: number; active: number; lastSyncedAt: string | null };
