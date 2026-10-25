import { describe, expect, it } from "vitest";

import { buildIcs, vtimezone } from "./ics.js";

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

/** Minimal parser for the tests: unfolds lines and returns the VEVENT blocks as arrays of [name;params, value]. */
function parse(ics: string) {
  expect(ics.endsWith("\r\n")).toBe(true);
  const lines = ics.slice(0, -2).split("\r\n").reduce<string[]>((acc, line) => {
    if (line.startsWith(" ")) acc[acc.length - 1] += line.slice(1);
    else acc.push(line);
    return acc;
  }, []);
  for (const raw of ics.split("\r\n")) expect(Buffer.byteLength(raw, "utf8")).toBeLessThanOrEqual(75);
  const props = (block: string[]) => block.map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1)] as const);
  const events: Array<ReadonlyArray<readonly [string, string]>> = [];
  let current: string[] | null = null;
  for (const l of lines) {
    if (l === "BEGIN:VEVENT") current = [];
    else if (l === "END:VEVENT") {
      events.push(props(current!));
      current = null;
    } else if (current) current.push(l);
  }
  return { lines, events };
}
const get = (ev: ReadonlyArray<readonly [string, string]>, name: string) => ev.find(([k]) => k === name || k.startsWith(`${name};`));

describe("buildIcs formatting", () => {
  it("folds long lines at 75 octets without splitting multi-byte characters and unfolds back to the original", () => {
    const title = "Übungsleiter-Treffen ".repeat(12) + "Schluss";
    const { events } = parse(buildIcs([{ id: "long", title, startsAt: new Date("2031-01-01T10:00:00Z") }]));
    expect(get(events[0]!, "SUMMARY")![1]).toBe(title);
  });

  it("escapes carriage returns and writes place, status and all-day dates", () => {
    const { events } = parse(
      buildIcs(
        [
          { id: "a", title: "Fest", description: "eins\r\nzwei\rdrei", startsAt: new Date("2031-03-01T00:00:00Z"), endsAt: new Date("2031-03-03T22:59:59Z"), allDay: true, location: "Halle, Hauptstr. 1", cancelled: true },
        ],
        { timezone: "Europe/Berlin" },
      ),
    );
    const ev = events[0]!;
    expect(get(ev, "DESCRIPTION")![1]).toBe("eins\\nzwei\\ndrei");
    expect(get(ev, "LOCATION")![1]).toBe("Halle\\, Hauptstr. 1");
    expect(get(ev, "STATUS")![1]).toBe("CANCELLED");
    expect(get(ev, "DTSTART")).toEqual(["DTSTART;VALUE=DATE", "20310301"]);
    expect(get(ev, "DTEND")).toEqual(["DTEND;VALUE=DATE", "20310304"]);
  });
});

describe("buildIcs series", () => {
  const series = {
    id: "s1",
    title: "Training",
    description: null,
    location: "Halle",
    timezone: "Europe/Berlin",
    allDay: false,
    startDate: "2031-03-17",
    startTime: "18:00",
    durationMinutes: 90,
    durationDays: 1,
    freq: "weekly",
    interval: 1,
    byDay: ["MO"],
    bySetPos: null,
    untilDate: null,
    count: null,
    skipHolidays: false,
    horizonUntil: new Date("2032-03-17T00:00:00Z"),
    excluded: [] as Date[],
  };
  const occ = (id: string, iso: string, extra: Partial<Parameters<typeof buildIcs>[0][number]> = {}) => ({ id, title: "Training", startsAt: new Date(iso), endsAt: new Date(new Date(iso).getTime() + 90 * 60_000), seriesId: "s1", originalStartsAt: new Date(iso), isOverride: false, ...extra });
  // Mondays 18:00 Berlin: 17 and 24 March are CET (17:00Z), 31 March CEST (16:00Z).
  const stored = [occ("e1", "2031-03-17T17:00:00Z"), occ("e2", "2031-03-24T17:00:00Z"), occ("e3", "2031-03-31T16:00:00Z"), occ("e4", "2031-04-07T16:00:00Z")];

  it("writes one master with RRULE, local DTSTART/DTEND, VTIMEZONE with both observances, and no per-occurrence events", () => {
    const { lines, events } = parse(buildIcs(stored, { series: [series] }));
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(get(ev, "UID")![1]).toBe("series-s1@myverein");
    expect(get(ev, "DTSTART")).toEqual(["DTSTART;TZID=Europe/Berlin", "20310317T180000"]);
    expect(get(ev, "DTEND")).toEqual(["DTEND;TZID=Europe/Berlin", "20310317T193000"]);
    expect(get(ev, "RRULE")![1]).toBe("FREQ=WEEKLY;BYDAY=MO;WKST=MO");
    expect(get(ev, "LOCATION")![1]).toBe("Halle");
    expect(lines).toContain("TZID:Europe/Berlin");
    expect(lines.filter((l) => l === "BEGIN:DAYLIGHT").length).toBeGreaterThanOrEqual(10);
    expect(lines).toContain("TZOFFSETTO:+0200");
    expect(lines).toContain("TZOFFSETTO:+0100");
  });

  it("writes EXDATE for dropped days, RECURRENCE-ID overrides and cancelled occurrences", () => {
    const withGap = [stored[0]!, occ("e3", "2031-03-31T16:00:00Z", { cancelled: true }), occ("e4", "2031-04-07T16:00:00Z", { isOverride: true, title: "Sonder", startsAt: new Date("2031-04-07T17:00:00Z") })];
    const { events } = parse(buildIcs(withGap, { series: [{ ...series, excluded: [new Date("2031-03-24T17:00:00Z")] }] }));
    expect(events).toHaveLength(3);
    expect(get(events[0]!, "EXDATE")).toEqual(["EXDATE;TZID=Europe/Berlin", "20310324T180000"]);
    const cancelled = events.find((e) => get(e, "RECURRENCE-ID")?.[1] === "20310331T180000")!;
    expect(get(cancelled, "STATUS")![1]).toBe("CANCELLED");
    expect(get(cancelled, "UID")![1]).toBe("series-s1@myverein");
    const moved = events.find((e) => get(e, "RECURRENCE-ID")?.[1] === "20310407T180000")!;
    expect(get(moved, "SUMMARY")![1]).toBe("Sonder");
    expect(get(moved, "DTSTART")![1]).toBe("20310407T170000Z");
  });

  it("limits skipped-holiday series to the checked horizon, honours COUNT/UNTIL, monthly weekdays and all-day series", () => {
    const rrule = (s: object, e = stored) => get(parse(buildIcs(e, { series: [{ ...series, ...s }] })).events[0]!, "RRULE")![1];
    expect(rrule({ skipHolidays: true })).toBe("FREQ=WEEKLY;BYDAY=MO;WKST=MO;UNTIL=20320317T000000Z");
    expect(rrule({ count: 4 })).toBe("FREQ=WEEKLY;BYDAY=MO;WKST=MO;COUNT=4");
    expect(rrule({ untilDate: "2031-04-07" })).toBe("FREQ=WEEKLY;BYDAY=MO;WKST=MO;UNTIL=20310407T215959Z");
    expect(rrule({ interval: 2, freq: "monthly", byDay: ["MO"], bySetPos: 3, startDate: "2031-03-17" }, [occ("m1", "2031-03-17T17:00:00Z")])).toBe("FREQ=MONTHLY;INTERVAL=2;BYDAY=3MO");
    const allDay = parse(
      buildIcs([{ id: "d1", title: "Lager", startsAt: new Date("2031-03-16T23:00:00Z"), endsAt: new Date("2031-03-18T22:59:59Z"), allDay: true, seriesId: "s1", originalStartsAt: new Date("2031-03-16T23:00:00Z") }], {
        series: [{ ...series, allDay: true, startTime: null, durationMinutes: null, durationDays: 3, freq: "monthly", byDay: null, count: 1 }],
      }),
    ).events[0]!;
    expect(get(allDay, "DTSTART")).toEqual(["DTSTART;VALUE=DATE", "20310317"]);
    expect(get(allDay, "DTEND")).toEqual(["DTEND;VALUE=DATE", "20310320"]);
    expect(get(allDay, "RRULE")![1]).toBe("FREQ=MONTHLY;BYMONTHDAY=17;COUNT=1");
  });

  it("falls back to individual events when the stored occurrences do not follow the rule", () => {
    const diverging = [occ("e1", "2031-03-17T17:00:00Z"), occ("e9", "2031-03-25T17:00:00Z")];
    const { events } = parse(buildIcs(diverging, { series: [series] }));
    expect(events.map((e) => get(e, "UID")![1])).toEqual(["e1@myverein", "e9@myverein"]);
    expect(events.every((e) => !get(e, "RRULE"))).toBe(true);
  });

  it("builds a VTIMEZONE for any zone: northern and southern hemisphere, and none for a zone without changes", () => {
    const sydney = vtimezone("Australia/Sydney", new Date("2031-01-01T00:00:00Z"));
    expect(sydney).toContain("TZID:Australia/Sydney");
    expect(sydney).toContain("TZOFFSETTO:+1100");
    expect(sydney).toContain("TZOFFSETTO:+1000");
    const tokyo = vtimezone("Asia/Tokyo", new Date("2031-01-01T00:00:00Z"));
    expect(tokyo.filter((l) => l.startsWith("BEGIN:")).length).toBe(2);
    const berlin = vtimezone("Europe/Berlin", new Date("2031-01-01T00:00:00Z"));
    // Last Sunday of March 2031 is the 30th: 02:00 local before the switch.
    expect(berlin).toContain("DTSTART:20310330T020000");
  });
});
