import { describe, expect, it } from "vitest";

import { easterSunday, holidayOn, holidaysOf } from "./holidays-de.js";

describe("easterSunday", () => {
  it("matches known dates", () => {
    expect(easterSunday(2024)).toBe("2024-03-31");
    expect(easterSunday(2025)).toBe("2025-04-20");
    expect(easterSunday(2026)).toBe("2026-04-05");
    expect(easterSunday(2038)).toBe("2038-04-25");
    expect(easterSunday(2000)).toBe("2000-04-23");
  });
});

describe("holidaysOf", () => {
  it("derives the moveable nationwide holidays from Easter", () => {
    const h = holidaysOf(2026);
    expect(h.get("2026-04-03")).toBe("Karfreitag");
    expect(h.get("2026-04-06")).toBe("Ostermontag");
    expect(h.get("2026-05-14")).toBe("Christi Himmelfahrt");
    expect(h.get("2026-05-25")).toBe("Pfingstmontag");
    expect(h.get("2026-10-03")).toBe("Tag der Deutschen Einheit");
    expect(h.size).toBe(9);
  });

  it("adds state holidays and keeps others out", () => {
    expect(holidayOn("2026-01-06", "BY")).toBe("Heilige Drei Könige");
    expect(holidayOn("2026-01-06", "NW")).toBeNull();
    expect(holidayOn("2026-01-06")).toBeNull();
    expect(holidayOn("2026-06-04", "BY")).toBe("Fronleichnam");
    expect(holidayOn("2026-06-04", "BE")).toBeNull();
    expect(holidayOn("2026-03-08", "BE")).toBe("Internationaler Frauentag");
    expect(holidayOn("2026-10-31", "SN")).toBe("Reformationstag");
    expect(holidayOn("2026-10-31", "BY")).toBeNull();
    expect(holidayOn("2026-11-18", "SN")).toBe("Buß- und Bettag");
    expect(holidayOn("2025-11-19", "SN")).toBe("Buß- und Bettag");
    expect(holidayOn("2026-05-24", "BB")).toBe("Pfingstsonntag");
  });

  it("ignores an unknown state", () => {
    expect(holidaysOf(2026, "XX").size).toBe(9);
  });
});
