import type { EmailBlock, PlatformTemplateKey, PlatformTemplateVariable } from "@growthdesk/shared";

/* Response shapes of /v1/admin/email/… and /v1/admin/email-log (apps/api/src/platform-mail). */

export type MailProviderId = "smtp" | "resend";

export type EmailSettings = {
  mailProvider: MailProviderId;
  transactionalFrom: string;
  marketingFrom: string;
  replyTo: string;
  resendRateLimitPerSec: number;
  resendApiKeySet: boolean;
  resendApiKeyFromEnv: boolean;
  resendWebhookSecretSet: boolean;
  resendWebhookSecretFromEnv: boolean;
  webhookUrl: string;
  effective: { provider: MailProviderId; reason: string; transactionalFrom: string; marketingFrom: string; replyTo: string | null };
  defaults: { mailFrom: string; replyTo: string | null };
  /** What SMTP sends through now: the server saved here, else the environment's (fromEnv). */
  smtp: { host: string; port: number; secure: boolean; authenticated: boolean; user: string; passwordSet: boolean; fromEnv: boolean };
};

export type EmailSettingsPatch = Partial<{
  mailProvider: MailProviderId;
  resendApiKey: string;
  resendWebhookSecret: string;
  transactionalFrom: string;
  marketingFrom: string;
  replyTo: string;
  resendRateLimitPerSec: number;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPassword: string;
}>;

export type SendResult = {
  ok: boolean;
  emailLogId: string;
  provider: MailProviderId;
  providerMessageId: string | null;
  fallbackReason: string | null;
  error: string | null;
  to: string;
};

export type DomainRecord = { record: string; name: string; type: string; ttl: string; status: string; value: string; priority: number | null };
export type ResendDomain = { id: string; name: string; status: string; region: string; createdAt: string | null; records: DomainRecord[] };

export type EmailLogRow = {
  id: string;
  to: string;
  template: string;
  status: string;
  error: string;
  stream: string;
  provider: string;
  providerMessageId: string | null;
  userId: string | null;
  subject: string;
  fromAddress: string;
  templateVersionId: string | null;
  attempts: number;
  sentAt: string | null;
  deliveredAt: string | null;
  openedAt: string | null;
  clickedAt: string | null;
  bouncedAt: string | null;
  complainedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type EmailLogPage = { items: EmailLogRow[]; total: number; page: number; pageSize: number; templates: string[] };

export type EmailLogDetail = EmailLogRow & {
  user: { id: string; name: string; email: string } | null;
  templateVersion: { id: string; version: number; templateKey: string } | null;
  events: { id: string; type: string; occurredAt: string; createdAt: string; payload: unknown }[];
};

export type TemplateContent = { subject: string; preheader: string; blocks: EmailBlock[] };

export type TemplateListItem = {
  key: PlatformTemplateKey;
  label: string;
  category: string;
  customised: boolean;
  activeVersion: { id: string; version: number; createdAt: string } | null;
  versionCount: number;
  updatedAt: string | null;
};

export type TemplateVersion = TemplateContent & {
  id: string;
  version: number;
  note: string;
  active: boolean;
  createdAt: string;
  createdBy: { id: string; name: string; email: string } | null;
};

export type TemplateDetail = {
  key: PlatformTemplateKey;
  label: string;
  category: string;
  variables: PlatformTemplateVariable[];
  required: string[];
  default: TemplateContent;
  customised: boolean;
  activeVersionId: string | null;
  current: TemplateContent;
  versions: TemplateVersion[];
};

export type TemplatePreview = { subject: string; html: string; text: string; problems: string[] };
