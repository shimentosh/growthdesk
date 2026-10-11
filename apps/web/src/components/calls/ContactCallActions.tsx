"use client";

import { useState } from "react";
import { ListPlus, Phone } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useWorkspace } from "@/lib/session";
import type { ContactDetail } from "@/lib/types/crm";
import { AddToQueueModal } from "./AddToQueueModal";
import { CallDrawer } from "./CallDrawer";

/**
 * "Call" and "Add to call list" for a contact record's header. The drawer
 * places the call through Twilio when it is connected (or explains how to
 * dial and log it); either way the API re-checks do-not-contact first.
 */
export function ContactCallActions({ contact }: { contact: ContactDetail }) {
  const ws = useWorkspace();
  const [calling, setCalling] = useState(false);
  const [queueing, setQueueing] = useState(false);
  if (!ws.can("calls.make")) return null;
  const blocked = contact.doNotContact ? "Marked do not contact." : null;
  return (
    <>
      <Button icon={<Phone />} onClick={() => setCalling(true)} disabled={Boolean(blocked)} title={blocked ?? undefined}>
        {contact.phone ? "Call" : "Log call"}
      </Button>
      <Button
        icon={<ListPlus />}
        onClick={() => setQueueing(true)}
        disabled={Boolean(blocked) || !contact.phone}
        title={blocked ?? (!contact.phone ? "No phone number on file" : undefined)}
      >
        Add to call list
      </Button>
      <CallDrawer open={calling} onOpenChange={setCalling} contact={contact} blocked={blocked} />
      <AddToQueueModal open={queueing} onOpenChange={setQueueing} initial={[contact]} />
    </>
  );
}
