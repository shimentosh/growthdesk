/** GET /status (public): maintenance mode and the support address, from the platform settings and branding. */
export type PlatformStatus = { maintenance: { message: string } | null; supportEmail: string | null };

/** The query key every banner and support link shares; useApiMutation refetches it when a write is refused with 503. */
export const PLATFORM_STATUS_KEY = ["platform-status"] as const;
