"use client";

import { useEffect, useState } from "react";
import { Eye, RefreshCw, UserRound } from "lucide-react";
import type { Channel } from "@growthdesk/shared";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { Spinner } from "@/components/ui/Skeleton";
import { ContactPicker } from "@/components/pickers/Pickers";
import { cn } from "@/lib/cn";
import { useApiMutation } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import type { TemplatePreview, TemplatePreviewBody } from "@/lib/types/templates";

const tokenList = (names: string[]) => names.map((n) => `{{${n}}}`).join(", ");

/**
 * The template rendered for one contact by POST /templates/:id/preview, with
 * the editor's unsaved subject and body, refreshed as they change.
 */
export function TemplatePreviewPanel({ templateId, channel, subject, body }: { templateId: string | null; channel: Channel; subject: string; body: string }) {
  const ws = useWorkspace();
  const [contactId, setContactId] = useState<string | null>(null);
  const [contactLabel, setContactLabel] = useState<string | null>(null);
  // The last good rendering stays on screen while the next one is on its way.
  const [last, setLast] = useState<TemplatePreview | null>(null);
  const preview = useApiMutation<TemplatePreview, TemplatePreviewBody>({
    path: ws.path(`/templates/${templateId}/preview`),
    errorToast: false,
    onSuccess: (d) => setLast(d),
  });
  const { mutate } = preview;
  const isEmail = channel === "email";

  // Re-render shortly after typing pauses.
  useEffect(() => {
    if (!templateId || !contactId || !body.trim()) return;
    const t = setTimeout(() => mutate({ contactId, subject: isEmail ? subject : "", body }), 400);
    return () => clearTimeout(t);
  }, [templateId, contactId, subject, body, isEmail, mutate]);

  const data = last && last.contact.id === contactId ? last : null;

  return (
    <Card>
      <CardHeader
        icon={<Eye />}
        title="Preview"
        description="How it reads for one contact, with your unsaved changes."
        actions={
          contactId && templateId ? (
            <Button size="sm" variant="ghost" icon={<RefreshCw />} loading={preview.isPending} onClick={() => mutate({ contactId, subject: isEmail ? subject : "", body })}>
              Refresh
            </Button>
          ) : undefined
        }
      />
      <CardBody className="flex flex-col gap-3">
        {!templateId ? (
          <p className="text-xs text-text-3">Save the template to preview it against a contact.</p>
        ) : !ws.can("contacts.read") ? (
          <p className="text-xs text-text-3">Your role cannot view contacts, so there is no one to preview with.</p>
        ) : (
          <>
            <Field label="Contact">
              <ContactPicker
                value={contactId}
                valueLabel={contactLabel}
                onChange={(id, c) => {
                  setContactId(id);
                  setContactLabel(c ? c.fullName || c.email || null : null);
                  setLast(null);
                  preview.reset();
                }}
              />
            </Field>
            {!contactId ? (
              <EmptyState compact icon={<UserRound />} title="Pick a contact" description="See the message with their details filled in." className="py-6" />
            ) : !body.trim() ? (
              <p className="text-xs text-text-3">Write a body to preview it.</p>
            ) : preview.isError ? (
              <Callout tone="bad">{preview.error.message}</Callout>
            ) : !data ? (
              <div className="flex justify-center py-6">
                <Spinner label="Rendering preview" />
              </div>
            ) : (
              <>
                {data.missing.length > 0 && (
                  <Callout tone="warn" title="Missing for this contact">
                    {tokenList(data.missing)} {data.missing.length === 1 ? "has" : "have"} no value and no fallback. A campaign will not send this message to
                    this contact; add a fallback like <code className="font-mono">{"{{first_name|there}}"}</code> or fill in the contact.
                  </Callout>
                )}
                {data.unknown.length > 0 && (
                  <Callout tone="bad" title="Unknown variables">
                    {tokenList(data.unknown)} {data.unknown.length === 1 ? "is" : "are"} neither a standard variable nor a contact custom field. Check the
                    spelling; sequences refuse to save steps that use {data.unknown.length === 1 ? "it" : "them"}.
                  </Callout>
                )}
                <div className={cn("flex flex-col gap-2 rounded-md border border-line bg-well p-3 transition-opacity", preview.isPending && "opacity-60")}>
                  {isEmail && (
                    <div className="flex flex-col gap-0.5 border-b border-line pb-2 text-xs">
                      <div className="text-text-3">
                        From <span className="text-text-2">{data.sender.name ? `${data.sender.name} <${data.sender.email}>` : data.sender.email || "—"}</span>
                      </div>
                      <div className="text-text-3">
                        To <span className="text-text-2">{data.contact.email || "this contact has no email address"}</span>
                      </div>
                      <div className="mt-1 text-sm font-medium text-text-hi">{data.subject || <span className="text-text-3">(no subject)</span>}</div>
                    </div>
                  )}
                  <div className="text-sm leading-relaxed break-words whitespace-pre-wrap text-text">{data.body}</div>
                </div>
                <p className="text-xs text-text-3">
                  {isEmail
                    ? data.sender.mailboxId
                      ? "Sent from the workspace's first connected mailbox here; a campaign uses its own mailboxes. The mailbox signature and, when the campaign adds one, an unsubscribe line are appended at send time."
                      : "No mailbox is connected, so your own name and email stand in for the sender."
                    : "Variables are filled in the same way when the step sends."}
                </p>
              </>
            )}
          </>
        )}
      </CardBody>
    </Card>
  );
}
