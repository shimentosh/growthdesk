"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { CalendarDays, CalendarRange, ChevronDown, Plus, Settings2 } from "lucide-react";
import { CALENDAR_PROVIDER_LABELS, type CalendarProvider } from "@growthdesk/shared";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/DropdownMenu";
import { toast } from "@/components/ui/Toast";
import { get } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useApiQuery, useInvalidate } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import type { CalendarConnection, MyCalendars } from "@/lib/types/booking";

/** Google's "G", for the connect buttons. */
export function GoogleGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={cn("size-4 shrink-0", className)}>
      <path fill="#4285F4" d="M23.5 12.27c0-.82-.07-1.6-.2-2.36H12v4.47h6.46a5.52 5.52 0 0 1-2.4 3.62v3h3.88c2.27-2.09 3.56-5.17 3.56-8.73z" />
      <path fill="#34A853" d="M12 24c3.24 0 5.96-1.07 7.94-2.9l-3.88-3.01c-1.07.72-2.45 1.15-4.06 1.15-3.12 0-5.77-2.11-6.71-4.95H1.28v3.1A12 12 0 0 0 12 24z" />
      <path fill="#FBBC05" d="M5.29 14.29a7.2 7.2 0 0 1 0-4.58v-3.1H1.28a12 12 0 0 0 0 10.78l4.01-3.1z" />
      <path fill="#EA4335" d="M12 4.75c1.76 0 3.34.61 4.59 1.8l3.44-3.44A11.98 11.98 0 0 0 1.28 6.61l4.01 3.1C6.23 6.86 8.88 4.75 12 4.75z" />
    </svg>
  );
}

/** Microsoft's four squares. */
export function MicrosoftGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={cn("size-4 shrink-0", className)}>
      <path fill="#F25022" d="M1 1h10.5v10.5H1z" />
      <path fill="#7FBA00" d="M12.5 1H23v10.5H12.5z" />
      <path fill="#00A4EF" d="M1 12.5h10.5V23H1z" />
      <path fill="#FFB900" d="M12.5 12.5H23V23H12.5z" />
    </svg>
  );
}

export const ProviderGlyph = ({ provider, className }: { provider: CalendarProvider; className?: string }) =>
  provider === "google" ? <GoogleGlyph className={className} /> : <MicrosoftGlyph className={className} />;

const PROVIDERS: CalendarProvider[] = ["google", "microsoft"];

/** The signed-in person's calendars (GET /calendar/connections). */
export function useMyCalendars() {
  const ws = useWorkspace();
  return useApiQuery<MyCalendars>(ws.key("calendar", "mine"), ws.path("/calendar/connections"), { staleTime: 30_000 });
}

/**
 * "Connect calendar": asks the API for the provider's consent URL and sends
 * the browser there. The provider comes back to
 * /api/calendar/oauth/<provider>/callback, which redirects to the page named
 * by `returnTo` with ?calendar=connected or ?calendarError=… (CalendarLanding).
 */
export function useCalendarStart(returnTo: "settings" | "meetings") {
  const ws = useWorkspace();
  const [pending, setPending] = useState<CalendarProvider | null>(null);
  const start = async (provider: CalendarProvider) => {
    setPending(provider);
    try {
      const { url } = await get<{ url: string }>(ws.path(`/calendar/oauth/${provider}/start`), { query: { return: returnTo } });
      window.location.assign(url);
    } catch (e) {
      setPending(null);
      toast.error(e);
    }
  };
  return { start, pending };
}

/**
 * Where the provider's sign-in lands: says what happened once, then drops the
 * parameters from the address. A failure stays (until dismissed) so its
 * reason can be read. Render inside <Suspense> (useSearchParams).
 */
export function CalendarLanding() {
  const ws = useWorkspace();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const invalidate = useInvalidate();
  const handled = useRef<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    const connected = params.get("calendar") === "connected";
    const error = params.get("calendarError");
    if (!connected && !error) return;
    const sig = params.toString();
    if (handled.current === sig) return;
    handled.current = sig;
    if (connected) {
      setFailure(null);
      toast.success("Calendar connected", { description: "Booking pages now skip your busy times and add meetings to it." });
      void invalidate(ws.key("calendar"), ws.key("booking-pages"));
    } else if (error) setFailure(error.slice(0, 300));
    const rest = new URLSearchParams(params.toString());
    for (const k of ["calendar", "calendarError", "connection"]) rest.delete(k);
    router.replace(rest.size ? `${pathname}?${rest.toString()}` : pathname, { scroll: false });
  }, [params, router, pathname, invalidate, ws]);

  if (!failure) return null;
  return (
    <Callout
      tone="bad"
      title="The calendar was not connected"
      className="mb-4"
      action={
        <Button size="sm" variant="ghost" onClick={() => setFailure(null)}>
          Dismiss
        </Button>
      }
    >
      {failure}
    </Callout>
  );
}

const dotTone = (c: CalendarConnection) => (c.status === "connected" ? "bg-ok" : c.status === "error" ? "bg-bad" : "bg-text-3");

/** The provider options of a connect menu: each starts the sign-in, or says why it can't. */
function ProviderItems({ available, start, pending }: { available: MyCalendars["available"] | undefined; start: (p: CalendarProvider) => void; pending: CalendarProvider | null }) {
  const none = available && !available.google && !available.microsoft;
  return (
    <>
      {PROVIDERS.map((p) => {
        const on = available?.[p] ?? false;
        return (
          <DropdownMenuItem key={p} icon={<ProviderGlyph provider={p} />} disabled={!on || pending !== null} onSelect={() => start(p)}>
            <span className="flex flex-col">
              <span>{pending === p ? "Opening…" : CALENDAR_PROVIDER_LABELS[p]}</span>
              {!on && available && !none && <span className="text-2xs text-text-3">Not set up on this installation</span>}
            </span>
          </DropdownMenuItem>
        );
      })}
      {none && <p className="max-w-64 px-2 py-1.5 text-2xs text-text-3">Calendar sign-in isn&apos;t set up yet. A platform admin adds the Google or Microsoft OAuth client in the admin console.</p>}
    </>
  );
}

/**
 * The Meetings page's calendar control (beside "Record meeting"): "Connect
 * calendar" with Google / Microsoft when the person has none; otherwise their
 * calendar (provider, address, status dot) with settings, another
 * connection and booking pages in its menu.
 */
export function CalendarHeaderControl() {
  const ws = useWorkspace();
  const router = useRouter();
  const mine = useMyCalendars();
  const { start, pending } = useCalendarStart("meetings");
  const connections = mine.data?.connections ?? [];
  const first = connections.find((c) => c.status === "connected") ?? connections[0];
  const canBook = ws.can("booking.manage");

  if (!first) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button icon={<CalendarDays />} loading={pending !== null} disabled={mine.isPending}>
            Connect calendar
            <ChevronDown aria-hidden className="-mr-1 size-3.5 text-text-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-56">
          <DropdownMenuLabel>Connect your calendar</DropdownMenuLabel>
          <ProviderItems available={mine.data?.available} start={start} pending={pending} />
          {canBook && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem icon={<CalendarRange />} onSelect={() => router.push(ws.href("/meetings/booking-pages"))}>
                Booking pages
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button className="max-w-64" title={first.status === "connected" ? `${CALENDAR_PROVIDER_LABELS[first.provider]}: ${first.email}` : `Needs reconnecting: ${first.lastError}`}>
          <span className="relative">
            <ProviderGlyph provider={first.provider} />
            <span aria-hidden className={cn("absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2 ring-panel", dotTone(first))} />
          </span>
          <span className="truncate">{first.email}</span>
          {connections.length > 1 && <span className="text-2xs text-text-3">+{connections.length - 1}</span>}
          <ChevronDown aria-hidden className="-mr-1 size-3.5 text-text-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-60">
        <DropdownMenuLabel>{first.status === "connected" ? "Calendar connected" : "Calendar needs reconnecting"}</DropdownMenuLabel>
        <DropdownMenuItem icon={<Settings2 />} onSelect={() => router.push(ws.href("/settings/calendar"))}>
          Calendar settings
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="flex items-center gap-1.5">
          <Plus aria-hidden className="size-3.5" />
          Connect another
        </DropdownMenuLabel>
        <ProviderItems available={mine.data?.available} start={start} pending={pending} />
        {canBook && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem icon={<CalendarRange />} onSelect={() => router.push(ws.href("/meetings/booking-pages"))}>
              Booking pages
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
