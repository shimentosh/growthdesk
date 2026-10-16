"use client";

import { ShoppingBag } from "lucide-react";
import type { ContactOrder } from "@growthdesk/shared";
import { Badge, type Tone } from "@/components/ui/Badge";
import { Card, CardHeader } from "@/components/ui/Card";
import { SkeletonText } from "@/components/ui/Skeleton";
import { useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import type { Contact } from "@/lib/types/crm";

function stateOf(o: ContactOrder): { label: string; tone: Tone } {
  if (o.state === "cancelled") return { label: "Cancelled", tone: "mute" };
  if (o.state === "completed") return { label: o.paid ? "Completed" : "Completed · unpaid", tone: o.paid ? "ok" : "warn" };
  return o.paid ? { label: "Paid", tone: "info" } : { label: "Unpaid", tone: "warn" };
}

/**
 * What a client bought, from the connected client portal (Clientdesk): the
 * totals the sync keeps on the contact, then each order newest first. Shown
 * only for someone who is a client or has ordered.
 */
export function OrdersCard({ contact }: { contact: Contact }) {
  const ws = useWorkspace();
  const f = useFormat();
  const show = contact.orders.count > 0 || Boolean(contact.customerSince);
  const orders = useApiQuery<ContactOrder[]>(ws.key("contacts", contact.id, "orders"), show ? ws.path(`/contacts/${contact.id}/orders`) : null);
  if (!show) return null;
  const o = contact.orders;

  return (
    <Card>
      <CardHeader
        icon={<ShoppingBag />}
        title="Orders"
        description={
          contact.customerSince ? `Client since ${f.date(contact.customerSince)}` : o.firstAt ? `First order ${f.date(o.firstAt)}` : undefined
        }
      />
      <div className="grid grid-cols-3 divide-x divide-line border-b border-line text-center">
        <div className="px-2 py-2.5">
          <div className="text-base font-semibold text-text-hi tabular-nums">{o.count}</div>
          <div className="text-2xs text-text-3">Orders</div>
        </div>
        <div className="px-2 py-2.5">
          <div className="text-base font-semibold text-text-hi tabular-nums">{o.paid}</div>
          <div className="text-2xs text-text-3">Paid</div>
        </div>
        <div className="px-2 py-2.5">
          <div className="truncate text-base font-semibold text-text-hi tabular-nums">{o.currency ? f.money(o.spent, o.currency) : "—"}</div>
          <div className="text-2xs text-text-3">Spent</div>
        </div>
      </div>
      {orders.isPending ? (
        <div className="px-4 py-3">
          <SkeletonText lines={3} />
        </div>
      ) : !orders.data?.length ? (
        <p className="px-4 py-3 text-xs text-text-3">No orders yet — a client who signed up but hasn't bought.</p>
      ) : (
        <ul className="max-h-80 divide-y divide-line overflow-y-auto">
          {orders.data.map((x) => {
            const st = stateOf(x);
            return (
              <li key={x.id} className="flex flex-col gap-0.5 px-4 py-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium text-text-hi">{x.number || "Order"}</span>
                  <span className="shrink-0 text-sm text-text tabular-nums">{f.money(x.total, x.currency)}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-xs text-text-3" title={x.items.map((i) => i.name).join(", ")}>
                    {x.items.length ? x.items.map((i) => (i.quantity > 1 ? `${i.quantity} × ${i.name}` : i.name)).join(", ") : x.status || "—"}
                  </span>
                  <Badge tone={st.tone} dot className="shrink-0">
                    {st.label}
                  </Badge>
                </div>
                <span className="text-2xs text-text-3">
                  {f.date(x.placedAt)}
                  {x.status ? ` · ${x.status}` : ""}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
