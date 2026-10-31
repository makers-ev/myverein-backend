import { asc, eq, inArray, or } from "drizzle-orm";

import { calendarFeedTokens } from "../../db/schema/calendar-feed-tokens.js";
import { eventAttendance, eventAttendanceCorrections, eventAttendanceSheets, eventAttendanceSupervisors } from "../../db/schema/event-attendance.js";
import { eventAttendees } from "../../db/schema/event-attendees.js";
import { eventRideRequests, eventRides, rateCards, timeEntries } from "../../db/schema/event-extras.js";
import { helperShifts, helperSignups, helperStations, helperSwapRequests } from "../../db/schema/event-helpers.js";
import { events } from "../../db/schema/events.js";
import type { PrivacyContributor } from "./registry.js";

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

async function rowCount(result: Promise<{ rowCount: number | null }>): Promise<number> {
  return (await result).rowCount ?? 0;
}

/**
 * Events, attendance and helper data of the person (Wave 12). Everything keyed on `club_members.id` works for members without
 * an account too. Attendance lists, helper signups, ride offers and registrations of the person are deleted (counts of other
 * people's lists are not affected); corrections of closed lists lose the person but stay as a log. Time entries and hourly rates
 * stay: they are the basis of remunerated work and underlie statutory retention (the reason is shown in the dry run).
 * `calendar_feed_tokens` belong to the account membership (the feed link dies with it).
 */
export const eventParticipation: PrivacyContributor = {
  key: "event_participation",
  tables: [
    "event_attendees",
    "event_attendance",
    "event_attendance_supervisors",
    "event_attendance_corrections",
    "helper_signups",
    "helper_swap_requests",
    "event_rides",
    "event_ride_requests",
    "time_entries",
    "rate_cards",
    "calendar_feed_tokens",
  ],
  async exportSubject(ex, s) {
    const id = s.clubMemberId;
    const registrations = await ex
      .select({ event: events.title, startsAt: events.startsAt, status: eventAttendees.status, partySize: eventAttendees.partySize, respondedAt: eventAttendees.respondedAt })
      .from(eventAttendees)
      .innerJoin(events, eq(events.id, eventAttendees.eventId))
      .where(s.accountMemberId ? or(eq(eventAttendees.clubMemberId, id), eq(eventAttendees.memberId, s.accountMemberId)) : eq(eventAttendees.clubMemberId, id))
      .orderBy(asc(events.startsAt));
    const attendance = await ex
      .select({ event: events.title, startsAt: events.startsAt, status: eventAttendance.status })
      .from(eventAttendance)
      .innerJoin(eventAttendanceSheets, eq(eventAttendanceSheets.id, eventAttendance.sheetId))
      .innerJoin(events, eq(events.id, eventAttendanceSheets.eventId))
      .where(eq(eventAttendance.clubMemberId, id))
      .orderBy(asc(events.startsAt));
    const supervised = await ex
      .select({ event: events.title, startsAt: events.startsAt })
      .from(eventAttendanceSupervisors)
      .innerJoin(eventAttendanceSheets, eq(eventAttendanceSheets.id, eventAttendanceSupervisors.sheetId))
      .innerJoin(events, eq(events.id, eventAttendanceSheets.eventId))
      .where(eq(eventAttendanceSupervisors.clubMemberId, id));
    const shifts = await ex
      .select({ event: events.title, station: helperStations.name, startsAt: helperShifts.startsAt, endsAt: helperShifts.endsAt })
      .from(helperSignups)
      .innerJoin(helperShifts, eq(helperShifts.id, helperSignups.shiftId))
      .innerJoin(helperStations, eq(helperStations.id, helperShifts.stationId))
      .innerJoin(events, eq(events.id, helperStations.eventId))
      .where(eq(helperSignups.clubMemberId, id))
      .orderBy(asc(helperShifts.startsAt));
    const rides = await ex.select({ event: events.title, seats: eventRides.seats, departurePlace: eventRides.departurePlace, departureAt: eventRides.departureAt }).from(eventRides).innerJoin(events, eq(events.id, eventRides.eventId)).where(eq(eventRides.driverClubMemberId, id));
    const times = await ex.select({ startedAt: timeEntries.startedAt, endedAt: timeEntries.endedAt, source: timeEntries.source, status: timeEntries.status }).from(timeEntries).where(eq(timeEntries.clubMemberId, id)).orderBy(asc(timeEntries.startedAt));
    const feeds = s.accountMemberId ? await ex.select({ label: calendarFeedTokens.label, createdAt: calendarFeedTokens.createdAt, revokedAt: calendarFeedTokens.revokedAt }).from(calendarFeedTokens).where(eq(calendarFeedTokens.memberId, s.accountMemberId)) : [];
    return {
      events: {
        registrations: registrations.map((r) => ({ ...r, startsAt: iso(r.startsAt), respondedAt: iso(r.respondedAt) })),
        attendance: attendance.map((r) => ({ ...r, startsAt: iso(r.startsAt) })),
        supervisedEvents: supervised.map((r) => ({ ...r, startsAt: iso(r.startsAt) })),
        helperShifts: shifts.map((r) => ({ ...r, startsAt: iso(r.startsAt), endsAt: iso(r.endsAt) })),
        rideOffers: rides.map((r) => ({ ...r, departureAt: iso(r.departureAt) })),
        timeEntries: times.map((r) => ({ ...r, startedAt: iso(r.startedAt), endedAt: iso(r.endedAt) })),
        calendarLinks: feeds.map((f) => ({ label: f.label, createdAt: iso(f.createdAt), revoked: f.revokedAt !== null })),
      },
    };
  },
  async eraseSubject(tx, s) {
    const id = s.clubMemberId;
    let deleted = 0;
    const signups = await tx.select({ id: helperSignups.id }).from(helperSignups).where(eq(helperSignups.clubMemberId, id));
    const swapFilter = signups.length > 0 ? or(inArray(helperSwapRequests.signupId, signups.map((x) => x.id)), eq(helperSwapRequests.toClubMemberId, id)) : eq(helperSwapRequests.toClubMemberId, id);
    for (const t of [
      tx.delete(helperSwapRequests).where(swapFilter),
      tx.delete(helperSignups).where(eq(helperSignups.clubMemberId, id)),
      tx.delete(eventAttendance).where(eq(eventAttendance.clubMemberId, id)),
      tx.delete(eventAttendanceSupervisors).where(eq(eventAttendanceSupervisors.clubMemberId, id)),
      tx.delete(eventRideRequests).where(eq(eventRideRequests.passengerClubMemberId, id)),
      tx.delete(eventRides).where(eq(eventRides.driverClubMemberId, id)),
      tx.delete(eventAttendees).where(s.accountMemberId ? or(eq(eventAttendees.clubMemberId, id), eq(eventAttendees.memberId, s.accountMemberId)) : eq(eventAttendees.clubMemberId, id)),
      ...(s.accountMemberId ? [tx.delete(calendarFeedTokens).where(eq(calendarFeedTokens.memberId, s.accountMemberId))] : []),
    ]) {
      deleted += await rowCount(t);
    }
    const corrections = await rowCount(tx.update(eventAttendanceCorrections).set({ clubMemberId: null }).where(eq(eventAttendanceCorrections.clubMemberId, id)));
    const keptTimes = await tx.select({ id: timeEntries.id }).from(timeEntries).where(eq(timeEntries.clubMemberId, id));
    const keptRates = await tx.select({ id: rateCards.id }).from(rateCards).where(eq(rateCards.clubMemberId, id));
    const kept = keptTimes.length + keptRates.length;
    return {
      deleted,
      anonymized: corrections,
      kept,
      ...(kept > 0 ? { keptReason: "Time entries and hourly rates underlie the statutory retention of remunerated work (Aufbewahrungsfristen) and stay until the retention period ends" } : {}),
    };
  },
};
