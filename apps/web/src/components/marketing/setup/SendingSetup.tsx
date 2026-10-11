"use client";

import { useState } from "react";
import { Globe, Info, Plus } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card, CardBody } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { QueryState } from "@/components/ui/ErrorState";
import { Section } from "@/components/ui/PageHeader";
import { SkeletonText } from "@/components/ui/Skeleton";
import { useMarketingSetup } from "@/components/marketing/common";
import { useWorkspace } from "@/lib/session";
import { DomainCard } from "./DomainCard";
import { AddDomainModal } from "./DomainModals";
import { EspCard } from "./EspCard";

/**
 * The email service card, then the sending domains, each with the DNS
 * records to publish. Everything is read-only without marketing.manage.
 */
export function SendingSetup() {
  const ws = useWorkspace();
  const setup = useMarketingSetup();
  const manage = ws.can("marketing.manage");
  const [adding, setAdding] = useState(false);

  return (
    <QueryState
      query={setup}
      loading={
        <Card>
          <CardBody>
            <SkeletonText lines={5} />
          </CardBody>
        </Card>
      }
    >
      {(s) => (
        <div className="flex flex-col gap-8">
          <EspCard esp={s.esp} canManage={manage} />

          <Section
            icon={<Globe />}
            title="Sending domains"
            description="A verified domain signs every email with DKIM and passes DMARC alignment, so inbox providers can trust that it really comes from you."
            actions={
              manage && s.domains.length > 0 ? (
                <Button size="sm" icon={<Plus />} onClick={() => setAdding(true)}>
                  Add domain
                </Button>
              ) : undefined
            }
          >
            {s.dnsChecksSkipped && (
              <p className="-mt-1 flex items-center gap-1.5 text-xs text-text-3">
                <Info aria-hidden className="size-3.5" />
                DNS checks skipped (development): verifying passes without looking anything up.
              </p>
            )}
            {s.domains.length === 0 ? (
              <Card>
                <EmptyState
                  icon={<Globe />}
                  tint="blue"
                  title="No sending domain yet"
                  description={
                    manage
                      ? "Add a domain you own, ideally a subdomain only for marketing, then publish the DNS records it shows."
                      : "Nobody has added a sending domain yet. Ask a workspace admin to add one."
                  }
                  action={
                    manage ? (
                      <Button variant="primary" icon={<Plus />} onClick={() => setAdding(true)}>
                        Add domain
                      </Button>
                    ) : undefined
                  }
                />
              </Card>
            ) : (
              s.domains.map((d) => <DomainCard key={d.id} domain={d} esp={s.esp} canManage={manage} />)
            )}
          </Section>

          {manage && <AddDomainModal open={adding} onOpenChange={setAdding} />}
        </div>
      )}
    </QueryState>
  );
}
