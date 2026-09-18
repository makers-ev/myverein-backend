/**
 * Minimal hand-built RFC 5545 ICS writer -- no npm dependency, this repo has
 * none for ICS and it's a handful of lines. Only the fields GET /events.ics
 * needs: UID/DTSTAMP/DTSTART/DTEND/SUMMARY/DESCRIPTION.
 */

export interface IcsEventInput {
  id: string;
  title: string;
  description?: string | null;
  startsAt: Date;
  endsAt?: Date | null;
}

/** Backslash-escapes `,`/`;` and turns a real newline into a literal `\n`, per RFC 5545 §3.3.11. */
function escapeIcsText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/,/g, "\\,").replace(/;/g, "\\;").replace(/\n/g, "\\n");
}

function formatIcsDateTime(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
}

export function buildIcs(events: IcsEventInput[]): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//MyVerein//DE"];
  const now = formatIcsDateTime(new Date());

  for (const event of events) {
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${event.id}@myverein`);
    lines.push(`DTSTAMP:${now}`);
    lines.push(`DTSTART:${formatIcsDateTime(event.startsAt)}`);
    if (event.endsAt) lines.push(`DTEND:${formatIcsDateTime(event.endsAt)}`);
    lines.push(`SUMMARY:${escapeIcsText(event.title)}`);
    if (event.description) lines.push(`DESCRIPTION:${escapeIcsText(event.description)}`);
    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}
