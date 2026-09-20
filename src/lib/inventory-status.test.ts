import { describe, expect, it } from "vitest";

import { effectiveLoanStatus, isLoanOverdue, isMaintenanceDue, maintenanceDueDate } from "./inventory-status.js";

const now = new Date("2026-09-20T12:00:00.000Z");

describe("isLoanOverdue", () => {
  it("is false when there is no due date", () => {
    expect(isLoanOverdue({ dueAt: null, returnedAt: null, status: "ausgeliehen" }, now)).toBe(false);
  });

  it("is false once the loan has been returned, even if it was returned late", () => {
    expect(
      isLoanOverdue({ dueAt: "2026-09-01T00:00:00.000Z", returnedAt: "2026-09-19T00:00:00.000Z", status: "zurueckgegeben" }, now),
    ).toBe(false);
  });

  it("is false while the due date is still in the future", () => {
    expect(isLoanOverdue({ dueAt: "2026-09-21T00:00:00.000Z", returnedAt: null, status: "ausgeliehen" }, now)).toBe(false);
  });

  it("is true once the due date has passed and it hasn't been returned", () => {
    expect(isLoanOverdue({ dueAt: "2026-09-19T00:00:00.000Z", returnedAt: null, status: "ausgeliehen" }, now)).toBe(true);
  });
});

describe("effectiveLoanStatus", () => {
  it("passes through the stored status when not overdue", () => {
    expect(effectiveLoanStatus({ dueAt: null, returnedAt: null, status: "ausgeliehen" }, now)).toBe("ausgeliehen");
    expect(
      effectiveLoanStatus({ dueAt: "2026-09-01T00:00:00.000Z", returnedAt: "2026-09-10T00:00:00.000Z", status: "zurueckgegeben" }, now),
    ).toBe("zurueckgegeben");
  });

  it("overrides to 'ueberfaellig' when overdue, regardless of stored status", () => {
    expect(effectiveLoanStatus({ dueAt: "2026-09-01T00:00:00.000Z", returnedAt: null, status: "ausgeliehen" }, now)).toBe("ueberfaellig");
  });
});

describe("maintenanceDueDate", () => {
  it("is null when the item has no maintenance interval", () => {
    expect(maintenanceDueDate({ maintenanceIntervalDays: null, lastMaintenanceAt: "2026-01-01", acquiredAt: "2025-01-01" })).toBeNull();
  });

  it("is null when there is no baseline date to count from", () => {
    expect(maintenanceDueDate({ maintenanceIntervalDays: 90, lastMaintenanceAt: null, acquiredAt: null })).toBeNull();
  });

  it("counts from lastMaintenanceAt when set", () => {
    expect(maintenanceDueDate({ maintenanceIntervalDays: 90, lastMaintenanceAt: "2026-06-01", acquiredAt: "2020-01-01" })).toBe(
      "2026-08-30",
    );
  });

  it("falls back to acquiredAt when never maintained", () => {
    expect(maintenanceDueDate({ maintenanceIntervalDays: 30, lastMaintenanceAt: null, acquiredAt: "2026-08-25" })).toBe("2026-09-24");
  });
});

describe("isMaintenanceDue", () => {
  it("is false with no maintenance schedule", () => {
    expect(isMaintenanceDue({ maintenanceIntervalDays: null, lastMaintenanceAt: null, acquiredAt: "2020-01-01" }, now)).toBe(false);
  });

  it("is false while the due date is still ahead", () => {
    expect(isMaintenanceDue({ maintenanceIntervalDays: 90, lastMaintenanceAt: "2026-09-01", acquiredAt: null }, now)).toBe(false);
  });

  it("is true once the due date has arrived", () => {
    expect(isMaintenanceDue({ maintenanceIntervalDays: 10, lastMaintenanceAt: "2026-09-01", acquiredAt: null }, now)).toBe(true);
  });

  it("is true the exact day it becomes due", () => {
    // 2026-09-19 + 1 day == "today" (UTC) at the fixed `now`.
    expect(isMaintenanceDue({ maintenanceIntervalDays: 1, lastMaintenanceAt: "2026-09-19", acquiredAt: null }, now)).toBe(true);
  });
});
