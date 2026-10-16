/*
 * A one-event iCalendar file (RFC 5545) for the attendee's "Add to calendar"
 * link. METHOD:PUBLISH, not REQUEST: it is a copy for their own calendar;
 * the real invitation (with RSVP) comes from the host's calendar provider.
 * The UID is stable per meeting and SEQUENCE grows with every change, so
 * opening the link again after a reschedule updates the copy.
 */

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/** Escapes TEXT values (RFC 5545 §3.3.11). */
const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

/** Folds lines at 75 octets (§3.1), continuing with a space. */
function fold(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let rest = line;
  while (Buffer.byteLength(rest, "utf8") > 75) {
    let cut = 75;
    while (Buffer.byteLength(rest.slice(0, cut), "utf8") > 75) cut -= 1;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  parts.push(rest);
  return parts.join("\r\n ");
}

export function meetingIcs(m: {
  uid: string;
  sequence: number;
  title: string;
  description: string;
  location: string;
  start: Date;
  end: Date;
  canceled: boolean;
  organizer?: { name: string; email: string } | null;
  url?: string;
}): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Growthdesk//Booking//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${m.uid}`,
    `SEQUENCE:${Math.max(0, Math.floor(m.sequence))}`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(m.start)}`,
    `DTEND:${stamp(m.end)}`,
    `SUMMARY:${esc(m.title)}`,
    ...(m.description ? [`DESCRIPTION:${esc(m.description)}`] : []),
    ...(m.location ? [`LOCATION:${esc(m.location)}`] : []),
    ...(m.url ? [`URL:${m.url}`] : []),
    ...(m.organizer?.email ? [`ORGANIZER;CN=${esc(m.organizer.name || m.organizer.email).replace(/[:;]/g, " ")}:mailto:${m.organizer.email}`] : []),
    `STATUS:${m.canceled ? "CANCELLED" : "CONFIRMED"}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines.map(fold).join("\r\n")}\r\n`;
}
