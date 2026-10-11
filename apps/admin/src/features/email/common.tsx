"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { labelOf, PLATFORM_TEMPLATES, type PlatformTemplateKey } from "@growthdesk/shared";
import { Badge, type Tone } from "@/components/ui/Badge";
import { IconButton } from "@/components/ui/Button";
import { toast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";

/* Pieces the email screens share: status chips, template names, copy buttons. */

export const EMAIL_STATUS_TONE: Record<string, Tone> = {
  queued: "mute",
  sent: "info",
  delivered: "ok",
  bounced: "bad",
  complained: "bad",
  failed: "bad",
  suppressed: "warn",
};

export const EMAIL_STATUS_HELP: Record<string, string> = {
  queued: "Waiting for the worker to send it",
  sent: "Handed to the provider",
  delivered: "Accepted by the recipient's mail server",
  bounced: "Rejected by the recipient's mail server",
  complained: "The recipient marked it as spam",
  failed: "Could not be sent",
  suppressed: "The provider refused the address (earlier bounce or complaint)",
};

export function EmailStatusBadge({ status }: { status: string }) {
  return (
    <Badge tone={EMAIL_STATUS_TONE[status] ?? "mute"} dot title={EMAIL_STATUS_HELP[status]}>
      {labelOf(status)}
    </Badge>
  );
}

export const PROVIDER_LABEL: Record<string, string> = { resend: "Resend", smtp: "SMTP", outbox: "Test outbox" };

/** "verify_email" → "Confirm email"; "test:verify_email" → "Test · Confirm email". */
export function templateLabel(key: string): string {
  if (key.startsWith("test:")) {
    const rest = key.slice(5);
    return `Test · ${rest === "settings" ? "Email settings" : templateLabel(rest)}`;
  }
  return PLATFORM_TEMPLATES[key as PlatformTemplateKey]?.label ?? labelOf(key);
}

export const CATEGORY_LABEL: Record<string, string> = {
  account: "Account",
  team: "Team",
  billing: "Billing",
  notifications: "Notifications",
  signup: "Sign-up",
};

export async function copyText(text: string, what = "Copied") {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(what);
    return true;
  } catch {
    toast.error("Could not copy — select the text and copy it by hand");
    return false;
  }
}

export function CopyButton({ value, label = "Copy", size = "sm" }: { value: string; label?: string; size?: "sm" | "md" }) {
  const [done, setDone] = useState(false);
  return (
    <IconButton
      label={label}
      size={size}
      icon={done ? <Check /> : <Copy />}
      onClick={async () => {
        if (await copyText(value, "Copied to the clipboard")) {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        }
      }}
    />
  );
}

/** A monospace value with a copy button (URLs, DNS records). */
export function CopyValue({ value, className }: { value: string; className?: string }) {
  return (
    <div className={cn("flex min-w-0 items-center gap-1 rounded-md border border-line bg-well py-0.5 pr-0.5 pl-2", className)}>
      <code className="min-w-0 flex-1 truncate font-mono text-xs text-text" title={value}>
        {value}
      </code>
      <CopyButton value={value} />
    </div>
  );
}
