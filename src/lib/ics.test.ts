import { describe, expect, it } from "vitest";

import { buildIcs } from "./ics.js";

describe("buildIcs", () => {
  it("wraps zero events in a valid empty VCALENDAR", () => {
    const ics = buildIcs([]);
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("VERSION:2.0");
    expect(ics).toContain("PRODID:-//MyVerein//DE");
    expect(ics).toContain("END:VCALENDAR");
    expect(ics).not.toContain("BEGIN:VEVENT");
  });

  it("emits one VEVENT per event with UID/DTSTART/DTEND/SUMMARY/DESCRIPTION", () => {
    const ics = buildIcs([
      {
        id: "abc-123",
        title: "Training",
        description: "Bring your own ball",
        startsAt: new Date("2026-05-01T18:00:00.000Z"),
        endsAt: new Date("2026-05-01T19:30:00.000Z"),
      },
    ]);

    expect(ics).toContain("BEGIN:VEVENT");
    expect(ics).toContain("UID:abc-123@myverein");
    expect(ics).toContain("DTSTART:20260501T180000Z");
    expect(ics).toContain("DTEND:20260501T193000Z");
    expect(ics).toContain("SUMMARY:Training");
    expect(ics).toContain("DESCRIPTION:Bring your own ball");
    expect(ics).toContain("END:VEVENT");
  });

  it("omits DTEND when endsAt is null and DESCRIPTION when unset", () => {
    const ics = buildIcs([{ id: "no-end", title: "Fest", startsAt: new Date("2026-06-01T10:00:00.000Z") }]);
    expect(ics).not.toContain("DTEND:");
    expect(ics).not.toContain("DESCRIPTION:");
  });

  it("escapes commas, semicolons, backslashes, and newlines per RFC 5545", () => {
    const ics = buildIcs([
      {
        id: "escape-me",
        title: "Vorstand; Kassenwart, Schriftführer",
        description: "Line one\nLine two, with; semicolons and a \\backslash",
        startsAt: new Date("2026-07-01T09:00:00.000Z"),
      },
    ]);

    expect(ics).toContain("SUMMARY:Vorstand\\; Kassenwart\\, Schriftführer");
    expect(ics).toContain("DESCRIPTION:Line one\\nLine two\\, with\\; semicolons and a \\\\backslash");
  });
});
