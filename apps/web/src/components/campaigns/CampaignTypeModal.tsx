"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { AudioLines, ChevronRight, Mail, MailPlus, MessageCircle, Phone, Send } from "lucide-react";
import { NewCampaignModal as NewMarketingCampaignModal } from "@/components/marketing/campaigns/NewCampaignModal";
import { Modal } from "@/components/ui/Dialog";
import { IconTile, type Tint } from "@/components/ui/IconTile";
import { cn } from "@/lib/cn";
import { useWorkspace } from "@/lib/session";
import { NewAiCallingCampaignModal } from "./NewAiCallingCampaignModal";
import { NewCampaignModal as NewOutreachCampaignModal } from "./NewCampaignModal";

export type CampaignKind = "outreach" | "marketing" | "ai_calling";

/** Who may create each kind, and why not when they cannot. */
export function useCampaignKinds() {
  const ws = useWorkspace();
  const outreach = ws.can("campaigns.write");
  const marketingAllowed = ws.can("marketing.write");
  const marketingPlan = ws.hasFeature("marketing");
  // An AI call step needs both (step-rules.service.ts); having no agent yet is handled by the create dialog.
  const callingPlan = ws.hasFeature("calling") && ws.hasFeature("multichannel");
  return {
    outreach: { ok: outreach, reason: outreach ? null : "Your role cannot create outreach campaigns." },
    aiCalling: {
      ok: outreach && callingPlan,
      reason: !outreach ? "Your role cannot create campaigns." : !callingPlan ? "Your plan does not include AI calling." : null,
      upgrade: outreach && !callingPlan,
    },
    marketing: {
      ok: marketingAllowed && marketingPlan,
      reason: !marketingAllowed ? "Your role cannot create marketing campaigns." : !marketingPlan ? "Your plan does not include email marketing." : null,
      upgrade: marketingAllowed && !marketingPlan,
    },
    any: outreach || (marketingAllowed && marketingPlan),
  };
}

/**
 * "New campaign": pick Outreach (1:1 sequences from your mailboxes),
 * Marketing (one-to-many email from your verified domain) or AI calling (an
 * outreach campaign whose steps an AI voice agent places), then the create
 * dialog for that kind opens.
 */
export function CampaignTypeModal({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const ws = useWorkspace();
  const kinds = useCampaignKinds();
  const [kind, setKind] = useState<CampaignKind | null>(null);
  const pick = (k: CampaignKind) => {
    onOpenChange(false);
    setKind(k);
  };

  return (
    <>
      <Modal open={open} onOpenChange={onOpenChange} size="xl" title="New campaign" description="Choose how this campaign reaches people.">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <KindCard
            title="Outreach"
            tint="blue"
            icon={<Send />}
            description="1:1 multi-step sequences — cold email, calls, WhatsApp, Telegram. Sends from your mailboxes."
            channels={[
              { icon: <Mail />, label: "Email" },
              { icon: <Phone />, label: "Calls" },
              { icon: <MessageCircle />, label: "WhatsApp" },
              { icon: <Send />, label: "Telegram" },
            ]}
            disabledReason={kinds.outreach.reason}
            onPick={() => pick("outreach")}
          />
          <KindCard
            title="Marketing"
            tint="pink"
            icon={<MailPlus />}
            description="One-to-many email to opted-in lists. Sends from your verified domain."
            channels={[{ icon: <Mail />, label: "Email" }]}
            disabledReason={kinds.marketing.reason}
            extra={
              kinds.marketing.upgrade && ws.can("billing.read") ? (
                <Link href={ws.href("/settings/billing")} className="text-xs font-medium text-accent-ink hover:text-accent-hi" onClick={() => onOpenChange(false)}>
                  See plans and upgrade
                </Link>
              ) : undefined
            }
            onPick={() => pick("marketing")}
          />
          <KindCard
            title="AI calling"
            tint="cyan"
            icon={<AudioLines />}
            description="An AI voice agent calls your consented leads, qualifies them and books meetings. Results land in your CRM."
            channels={[
              { icon: <AudioLines />, label: "AI voice" },
              { icon: <Mail />, label: "Follow-up email" },
            ]}
            disabledReason={kinds.aiCalling.reason}
            extra={
              kinds.aiCalling.upgrade && ws.can("billing.read") ? (
                <Link href={ws.href("/settings/billing")} className="text-xs font-medium text-accent-ink hover:text-accent-hi" onClick={() => onOpenChange(false)}>
                  See plans and upgrade
                </Link>
              ) : undefined
            }
            onPick={() => pick("ai_calling")}
          />
        </div>
      </Modal>
      {kinds.outreach.ok && <NewOutreachCampaignModal open={kind === "outreach"} onOpenChange={(o) => !o && setKind(null)} />}
      {kinds.aiCalling.ok && <NewAiCallingCampaignModal open={kind === "ai_calling"} onOpenChange={(o) => !o && setKind(null)} />}
      {kinds.marketing.ok && <NewMarketingCampaignModal open={kind === "marketing"} onOpenChange={(o) => !o && setKind(null)} />}
    </>
  );
}

function KindCard({
  title,
  tint,
  icon,
  description,
  channels,
  disabledReason,
  extra,
  onPick,
}: {
  title: string;
  tint: Tint;
  icon: ReactNode;
  description: string;
  channels: { icon: ReactNode; label: string }[];
  disabledReason: string | null;
  extra?: ReactNode;
  onPick: () => void;
}) {
  const disabled = Boolean(disabledReason);
  return (
    <div className={cn("flex flex-col rounded-lg border border-line", disabled ? "bg-well" : "hover:border-accent hover:bg-tint-pick")}>
      <button type="button" disabled={disabled} onClick={onPick} className="group flex flex-1 flex-col gap-3 p-4 text-left disabled:cursor-not-allowed">
        <div className="flex items-center gap-3">
          <IconTile icon={icon} tint={tint} size="md" className={cn(disabled && "opacity-50")} />
          <span className={cn("flex-1 text-sm font-semibold", disabled ? "text-text-3" : "text-text-hi")}>{title}</span>
          {!disabled && <ChevronRight aria-hidden className="size-4 text-text-3 group-hover:text-accent-ink" />}
        </div>
        <p className={cn("text-sm", disabled ? "text-text-3" : "text-text-2")}>{description}</p>
        <ul className="flex flex-wrap gap-1.5" aria-label="Channels">
          {channels.map((c) => (
            <li key={c.label} className="inline-flex h-6 items-center gap-1 rounded-xs bg-mute-chip px-2 text-2xs font-medium text-text-2 [&_svg]:size-3">
              {c.icon}
              {c.label}
            </li>
          ))}
        </ul>
      </button>
      {(disabledReason || extra) && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-2">
          {disabledReason && <span className="text-xs text-text-3">{disabledReason}</span>}
          {extra}
        </div>
      )}
    </div>
  );
}
