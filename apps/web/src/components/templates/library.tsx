"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ENTITY, EntityTile } from "@/components/ui/icons";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { NavTabs } from "@/components/ui/Tabs";
import { useWorkspace } from "@/lib/session";

/*
 * Templates, Sequences and Email designs are one screen with three tabs (the
 * sidebar's Templates link): the header and tabs stay put across a switch and
 * only the list below changes. Each tab puts its own buttons in the header
 * through <LibraryActions>, so they can open that tab's own dialogs.
 */

const ActionsSlot = createContext<HTMLElement | null>(null);

export function LibraryShell({ children }: { children: ReactNode }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  return (
    <Page>
      <PageHeader
        icon={<EntityTile of="templates" />}
        title="Templates"
        description="Reusable content for outreach and marketing: message templates, step-by-step sequences and email designs. A campaign copies what it uses, so editing one here never changes a campaign already made from it."
        actions={<div ref={setSlot} className="flex flex-wrap items-center gap-2" />}
      />
      <LibraryTabs />
      <ActionsSlot.Provider value={slot}>{children}</ActionsSlot.Provider>
    </Page>
  );
}

/** Renders its children as the header's buttons, from inside a tab's page. */
export function LibraryActions({ children }: { children: ReactNode }) {
  const slot = useContext(ActionsSlot);
  return slot ? createPortal(children, slot) : null;
}

/** The tabs a role can see, in order; the first is where the sidebar link lands. */
export function useLibraryTabs() {
  const ws = useWorkspace();
  return [
    ...(ws.can("templates.read") ? [{ href: ws.href("/templates"), label: "Templates", icon: <ENTITY.templates.icon /> }] : []),
    ...(ws.can("campaigns.read") ? [{ href: ws.href("/sequences"), label: "Sequences", icon: <ENTITY.sequences.icon /> }] : []),
    ...(ws.can("marketing.read") ? [{ href: ws.href("/marketing/designs"), label: "Email designs", icon: <ENTITY.designs.icon /> }] : []),
  ];
}

function LibraryTabs() {
  const items = useLibraryTabs();
  if (items.length < 2) return null;
  return <NavTabs aria-label="Templates, sequences and email designs" className="mb-4" items={items} />;
}
