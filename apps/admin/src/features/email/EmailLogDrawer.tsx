"use client";

import Link from "next/link";
import { CircleAlert, CircleCheck, Clock, Inbox, MailOpen, MousePointerClick, Send, ShieldAlert } from "lucide-react";
import type { ReactNode } from "react";
import { labelOf } from "@growthdesk/shared";
import { Badge } from "@/components/ui/Badge";
import { Callout } from "@/components/ui/Callout";
import { Drawer } from "@/components/ui/Drawer";
import { QueryState } from "@/components/ui/ErrorState";
import { KeyValueList } from "@/components/ui/KeyValue";
import { SkeletonText } from "@/components/ui/Skeleton";
import { cn } from "@/lib/cn";
import { useApiQuery } from "@/lib/query";
import { useFormat } from "@/lib/session";
import { PlatformTile, platformKey } from "@/features/common/platform";
import { CopyButton, EmailStatusBadge, PROVIDER_LABEL, templateLabel } from "./common";
import type { EmailLogDetail } from "./types";

/* One delivery-log row: envelope, the delivery timeline, and the provider's webhook events. */

type Step = { label: string; at: string | null; icon: ReactNode; tone: "ok" | "bad" | "mute" | "info" };

function Timeline({ steps }: { steps: Step[] }) {
  const f = useFormat();
  return (
    <ol className="relative flex flex-col gap-3 pl-1">
      {steps.map((s, i) => {
        const done = Boolean(s.at);
        return (
          <li key={s.label} className="relative flex items-start gap-3">
            {i < steps.length - 1 && <span aria-hidden className={cn("absolute top-6 left-[11px] h-[calc(100%-8px)] w-px", done ? "bg-line-strong" : "bg-line")} />}
            <span
              aria-hidden
              className={cn(
                "relative z-[1] flex size-6 shrink-0 items-center justify-center rounded-full border [&_svg]:size-3.5",
                !done && "border-line bg-panel text-text-3",
                done && s.tone === "ok" && "border-ok-edge bg-ok-wash text-ok-ink",
                done && s.tone === "bad" && "border-bad-edge bg-bad-wash text-bad-ink",
                done && s.tone === "info" && "border-info-edge bg-info-wash text-accent-ink",
                done && s.tone === "mute" && "border-line-strong bg-s-2 text-text-2",
              )}
            >
              {s.icon}
            </span>
            <div className="min-w-0 pt-0.5">
              <div className={cn("text-sm", done ? "font-medium text-text" : "text-text-3")}>{s.label}</div>
              <div className="text-xs text-text-3">{done ? f.dateTime(s.at) : "—"}</div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function steps(d: EmailLogDetail): Step[] {
  const out: Step[] = [
    { label: "Queued", at: d.createdAt, icon: <Clock />, tone: "mute" },
    { label: "Sent to the provider", at: d.sentAt, icon: <Send />, tone: "info" },
    { label: "Delivered", at: d.deliveredAt, icon: <Inbox />, tone: "ok" },
    { label: "Opened", at: d.openedAt, icon: <MailOpen />, tone: "ok" },
    { label: "Clicked", at: d.clickedAt, icon: <MousePointerClick />, tone: "ok" },
  ];
  if (d.bouncedAt) out.push({ label: "Bounced", at: d.bouncedAt, icon: <CircleAlert />, tone: "bad" });
  if (d.complainedAt) out.push({ label: "Marked as spam", at: d.complainedAt, icon: <ShieldAlert />, tone: "bad" });
  if (d.status === "failed") out.push({ label: "Failed", at: d.updatedAt, icon: <CircleAlert />, tone: "bad" });
  return out;
}

export function EmailLogDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const f = useFormat();
  const detail = useApiQuery<EmailLogDetail>(platformKey("email-log", "detail", id), id ? `/admin/email-log/${id}` : null);
  return (
    <Drawer open={id !== null} onOpenChange={(v) => !v && onClose()} width="lg" icon={<PlatformTile of="email" size="md" />} title={detail.data?.subject || "Email"} description={detail.data ? `To ${detail.data.to}` : undefined}>
      {id && (
        <QueryState query={detail} loading={<SkeletonText lines={10} />}>
          {(d) => (
            <div className="flex flex-col gap-6">
              <div className="flex flex-wrap items-center gap-2">
                <EmailStatusBadge status={d.status} />
                <Badge tone="mute" quiet>
                  {labelOf(d.stream)}
                </Badge>
                <Badge tone="mute" quiet>
                  {PROVIDER_LABEL[d.provider] ?? labelOf(d.provider)}
                </Badge>
                {d.attempts > 1 && (
                  <Badge tone="warn" quiet>
                    {d.attempts} attempts
                  </Badge>
                )}
              </div>
              {d.error && (
                <Callout tone={d.status === "sent" || d.status === "delivered" ? "warn" : "bad"} title={d.status === "sent" || d.status === "delivered" ? "Note" : "Error"}>
                  <span className="break-words">{d.error}</span>
                </Callout>
              )}

              <section>
                <h3 className="mb-2 text-xs font-semibold tracking-wide text-text-3 uppercase">Envelope</h3>
                <KeyValueList
                  items={[
                    { label: "To", value: d.to },
                    {
                      label: "User",
                      value: d.user ? (
                        <Link href={`/users/${d.user.id}`} className="hover:underline">
                          {d.user.name || d.user.email}
                        </Link>
                      ) : null,
                    },
                    { label: "From", value: d.fromAddress },
                    { label: "Subject", value: d.subject },
                    {
                      label: "Template",
                      value: (
                        <>
                          {templateLabel(d.template)}
                          {d.templateVersion ? (
                            <span className="text-text-3"> · version {d.templateVersion.version}</span>
                          ) : (
                            !d.template.startsWith("test:") && <span className="text-text-3"> · default</span>
                          )}
                        </>
                      ),
                    },
                    {
                      label: "Provider message id",
                      value: d.providerMessageId ? (
                        <span className="flex items-center gap-1">
                          <code className="truncate font-mono text-xs">{d.providerMessageId}</code>
                          <CopyButton value={d.providerMessageId} />
                        </span>
                      ) : null,
                    },
                    {
                      label: "Log id",
                      value: (
                        <span className="flex items-center gap-1">
                          <code className="truncate font-mono text-xs">{d.id}</code>
                          <CopyButton value={d.id} />
                        </span>
                      ),
                    },
                  ]}
                />
              </section>

              <section>
                <h3 className="mb-3 text-xs font-semibold tracking-wide text-text-3 uppercase">Timeline</h3>
                <Timeline steps={steps(d)} />
              </section>

              <section>
                <h3 className="mb-2 text-xs font-semibold tracking-wide text-text-3 uppercase">Webhook events</h3>
                {d.events.length === 0 ? (
                  <p className="text-sm text-text-3">
                    {d.provider === "resend" ? "No events from Resend yet. They arrive once the webhook is set up in Resend." : "SMTP reports no delivery events."}
                  </p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {d.events.map((e) => (
                      <li key={e.id} className="rounded-lg border border-line">
                        <details className="group">
                          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-sm [&::-webkit-details-marker]:hidden">
                            <span className="flex min-w-0 items-center gap-2">
                              <CircleCheck aria-hidden className="size-3.5 shrink-0 text-text-3" />
                              <code className="truncate font-mono text-xs">{e.type}</code>
                            </span>
                            <span className="shrink-0 text-xs text-text-3">
                              {f.dateTime(e.occurredAt)}
                              <span className="ml-2 text-text-3 group-open:hidden">Show</span>
                              <span className="ml-2 hidden text-text-3 group-open:inline">Hide</span>
                            </span>
                          </summary>
                          <pre className="max-h-72 overflow-auto border-t border-line bg-well px-3 py-2 font-mono text-2xs leading-relaxed whitespace-pre-wrap text-text-2">{JSON.stringify(e.payload, null, 2)}</pre>
                        </details>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          )}
        </QueryState>
      )}
    </Drawer>
  );
}
