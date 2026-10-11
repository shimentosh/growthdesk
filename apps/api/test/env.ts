/** Each parallel test runner can use its own database and Redis db: TEST_DB_NAME / TEST_REDIS_DB. */
export const TEST_DATABASE_NAME = process.env.TEST_DB_NAME ?? "growthdesk_test";
export const ADMIN_DATABASE_URL = "postgresql://growthdesk:growthdesk@127.0.0.1:5466/growthdesk";
export const TEST_DATABASE_URL = `postgresql://growthdesk:growthdesk@127.0.0.1:5466/${TEST_DATABASE_NAME}`;

export const TEST_ENV: Record<string, string> = {
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  PUBLIC_APP_URL: "http://localhost:3600",
  DATABASE_URL: TEST_DATABASE_URL,
  REDIS_URL: `redis://127.0.0.1:6386/${process.env.TEST_REDIS_DB ?? "1"}`,
  // A fixed test-only key; never used outside the test database.
  ENCRYPTION_KEY: "dGVzdC1vbmx5LWtleS0zMi1ieXRlcy1sb25nLW9rISE=",
  TRUSTED_PROXY_HOPS: "0",
  RATE_LIMIT_PER_MINUTE: "100000",
  AUTH_RATE_LIMIT: "100000",
  STRIPE_SECRET_KEY: "sk_test_growthdesk_fake",
  STRIPE_WEBHOOK_SECRET: "whsec_growthdesk_test_secret",
  ALLOW_PRIVATE_MAIL_HOSTS: "true",
  // apps/api/.env may turn this on for local development; tests check real (faked) DNS.
  MARKETING_SKIP_DNS_CHECKS: "false",
};
