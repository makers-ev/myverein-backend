/**
 * Live derivation of inventory "overdue"/"maintenance due" status. Neither
 * is ever written to the DB by a cron job -- `inventory_loans.status` stays
 * "ausgeliehen"/"zurueckgegeben" in Postgres, and these functions compute
 * "ueberfaellig"/maintenance-due at read time instead. See Data Model -
 * MyVerein Backend §3 "inventory_loans" for why (a scheduled job that
 * flips status would drift from `now()` between runs; deriving it on every
 * read never can).
 *
 * UTC-only date arithmetic, same convention as lib/activity-stats.ts.
 */

export interface LoanOverdueInput {
  dueAt: Date | string | null;
  returnedAt: Date | string | null;
  status: string;
}

export interface MaintenanceDueInput {
  maintenanceIntervalDays: number | null;
  lastMaintenanceAt: string | null;
  acquiredAt: string | null;
}

/** True if a loan is past its due date and hasn't been returned yet. */
export function isLoanOverdue(loan: LoanOverdueInput, now: Date): boolean {
  if (!loan.dueAt || loan.returnedAt) return false;
  return new Date(loan.dueAt).getTime() < now.getTime();
}

/** The stored `status`, unless the loan is overdue -- then "ueberfaellig". */
export function effectiveLoanStatus(loan: LoanOverdueInput, now: Date): string {
  return isLoanOverdue(loan, now) ? "ueberfaellig" : loan.status;
}

/** `dateStr` ("YYYY-MM-DD") plus `days`, as a UTC midnight Date. */
function addDaysUTC(dateStr: string, days: number): Date {
  const [year, month, day] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days));
}

/**
 * The item's next maintenance due date, or `null` if it isn't on a
 * maintenance schedule (`maintenanceIntervalDays` unset) or has no baseline
 * date to count from yet (never maintained AND never given an acquisition
 * date). `lastMaintenanceAt` wins over `acquiredAt` when both are set --
 * the most recent service is the correct baseline, not when it was bought.
 */
export function maintenanceDueDate(item: MaintenanceDueInput): string | null {
  if (!item.maintenanceIntervalDays) return null;
  const baseline = item.lastMaintenanceAt ?? item.acquiredAt;
  if (!baseline) return null;
  return addDaysUTC(baseline, item.maintenanceIntervalDays).toISOString().slice(0, 10);
}

/** True if the item's maintenance due date has arrived (today or earlier). */
export function isMaintenanceDue(item: MaintenanceDueInput, now: Date): boolean {
  const dueDate = maintenanceDueDate(item);
  if (!dueDate) return false;
  return addDaysUTC(dueDate, 0).getTime() <= now.getTime();
}
