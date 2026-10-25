import { and, asc, eq, gt, isNull, lte } from "drizzle-orm";

import { db } from "../db/client.js";
import { calendars } from "../db/schema/calendars.js";
import { helperShifts, helperSignups, helperStations } from "../db/schema/event-helpers.js";
import { events } from "../db/schema/events.js";
import { clubMailLanguage } from "./club-settings.js";
import { clubTimezone, formatWhen } from "./event-notify.js";
import { helperManagers } from "./event-helpers.js";
import type { JobContext } from "./jobs/registry.js";
import { logger } from "./logger.js";
import { notifySafely } from "./notify/dispatcher.js";
import { tr } from "./notify/i18n.js";

/**
 * Helper reminders (Wave 12 B17), hourly sweep of the job queue. (1) Everybody on a shift that starts within 24 hours is reminded
 * (in-app + push, with their guardians); (2) a shift that starts within 48 hours and is still below its minimum staffing is
 * reported to the organisers ("Schicht noch offen"). Both are idempotent through the delivery reference (`<shift>#remind24`,
 * `<shift>#open48`), so repeated and parallel sweeps send nothing twice. Cancelled events are skipped.
 */

export const HELPER_REMINDER_JOB_TYPE = "helper_reminder_sweep";
export const HELPER_REMINDER_INTERVAL_MS = 60 * 60 * 1000;
const BATCH = 300;

export async function sweepHelperReminders(now: Date = new Date()): Promise<{ reminded: number; opened: number }> {
  const in24 = new Date(now.getTime() + 24 * 3_600_000);
  const in48 = new Date(now.getTime() + 48 * 3_600_000);
  const rows = await db
    .select({ shift: helperShifts, stationName: helperStations.name, event: events, calendar: calendars })
    .from(helperShifts)
    .innerJoin(helperStations, eq(helperStations.id, helperShifts.stationId))
    .innerJoin(events, eq(events.id, helperStations.eventId))
    .innerJoin(calendars, eq(calendars.id, events.calendarId))
    .where(and(gt(helperShifts.startsAt, now), lte(helperShifts.startsAt, in48), isNull(events.cancelledAt)))
    .orderBy(asc(helperShifts.startsAt))
    .limit(BATCH);

  let reminded = 0;
  let opened = 0;
  for (const { shift, stationName, event, calendar } of rows) {
    try {
      const clubId = calendar.clubId;
      const lang = await clubMailLanguage(db, clubId);
      const when = formatWhen(shift.startsAt, await clubTimezone(clubId), shift.endsAt, lang);
      const signups = await db.select({ clubMemberId: helperSignups.clubMemberId }).from(helperSignups).where(eq(helperSignups.shiftId, shift.id));
      if (shift.startsAt <= in24 && signups.length > 0) {
        const result = await notifySafely({
          clubId,
          class: "optional",
          eventKey: "helper.reminder",
          refId: `${shift.id}#remind24`,
          audience: { memberIds: signups.map((s) => s.clubMemberId), includeGuardians: true },
          content: {
            title: `${tr(lang, "Erinnerung: Helferschicht", "Reminder: helper shift")} - ${event.title}`,
            body: tr(lang, `Du bist für „${stationName}“ bei „${event.title}“ eingetragen: ${when}. Wenn du nicht kannst, tausche oder melde dich bitte ab.`, `You are signed up for “${stationName}” at “${event.title}”: ${when}. If you cannot make it, please swap or withdraw.`),
            category: "reminders",
            template: "reminder",
            lang,
            eventId: event.id,
          },
          channels: ["in_app", "push"],
        });
        reminded += result?.inApp ?? 0;
      }
      if (signups.length < shift.minStaff) {
        const managers = await helperManagers(clubId, calendar);
        if (managers.length > 0) {
          const result = await notifySafely({
            clubId,
            class: "optional",
            eventKey: "helper.shift_open",
            refId: `${shift.id}#open48`,
            recipients: managers.map((m) => ({ userId: m.userId, clubMemberId: m.clubMemberId, name: m.name })),
            content: {
              title: `${tr(lang, "Schicht noch offen", "Shift still open")} - ${event.title}`,
              body: tr(lang, `„${stationName}“ bei „${event.title}“ (${when}) hat ${signups.length} von mindestens ${shift.minStaff} Helfer:innen. Bitte noch Leute eintragen oder ansprechen.`, `“${stationName}” at “${event.title}” (${when}) has ${signups.length} of at least ${shift.minStaff} helpers. Please sign up or ask more people.`),
              category: "reminders",
              template: "reminder",
              lang,
              eventId: event.id,
            },
            channels: ["in_app", "push"],
          });
          opened += result?.inApp ?? 0;
        }
      }
    } catch (err) {
      logger.error({ shiftId: shift.id, errName: (err as Error)?.name }, "[helpers] reminder failed for a shift");
    }
  }
  return { reminded, opened };
}

export async function handleHelperReminders(_job: JobContext): Promise<void> {
  await sweepHelperReminders();
}
