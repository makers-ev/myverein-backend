import { and, count, eq, exists, gt, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";

import { db } from "../db/client.js";
import { ballotVoters, ballots } from "../db/schema/assembly.js";
import { calendars } from "../db/schema/calendars.js";
import { clubApplications } from "../db/schema/club-applications.js";
import { clubExitRequests } from "../db/schema/club-exit-requests.js";
import { clubMembers } from "../db/schema/club-members.js";
import { clubSettings } from "../db/schema/club-settings.js";
import { clubAnnouncements, messageDeliveries } from "../db/schema/communication.js";
import { departments } from "../db/schema/departments.js";
import { eventAttendees } from "../db/schema/event-attendees.js";
import { events } from "../db/schema/events.js";
import { inventoryItems, inventoryLoans } from "../db/schema/inventory.js";
import { locations } from "../db/schema/locations.js";
import { meetingAttendance } from "../db/schema/meetings.js";
import { getVisibleCalendarIds } from "./calendar-visibility.js";
import { hasClubPermission } from "./club-permissions.js";
import { isMaintenanceDue } from "./inventory-status.js";
import { callerClubMemberId } from "./meeting-members.js";
import { todayBerlin } from "./member-lifecycle.js";
import { visibleStatusCondition } from "./member-read-scope.js";

/**
 * "Heute" overview of one club for the calling member (Wave 14 N2/S2): what needs an answer or attention now. Every part is
 * scoped to the caller (own RSVPs, own loans, own ballots) or to a permission (`board`, `setup`); nothing is club-wide data a
 * plain member could not read elsewhere.
 */

export const TODAY_LIST_MAX = 10;
export const TODAY_WINDOW_DAYS = 14;
export const RETURN_LEAD_DAYS = 3;
const DAY_MS = 86_400_000;

export const SETUP_KEYS = ["logo", "departments", "calendar", "location", "members"] as const;
export type SetupKey = (typeof SETUP_KEYS)[number];

export interface TodayCaller {
  clubId: string;
  userId: string;
  accountMemberId: string;
  isGuest: boolean;
  roleTypes: string[];
}

export interface TodayOverview {
  generatedAt: string;
  openRsvps: Array<{ eventId: string; title: string; startsAt: Date }>;
  cancelled: Array<{ eventId: string; title: string; startsAt: Date }>;
  unreadAnnouncements: number;
  dueReturns: Array<{ loanId: string; itemName: string; dueAt: Date }>;
  openBallots: number;
  board?: { openApplications?: number; openExits?: number; maintenanceDue?: number; memberCount?: number };
  setup?: { done: SetupKey[]; open: SetupKey[] };
}

async function upcomingEvents(caller: TodayCaller, now: Date) {
  const calendarIds = await getVisibleCalendarIds(caller.clubId, caller.accountMemberId, caller.roleTypes);
  if (calendarIds.length === 0) return { open: [], cancelled: [] };
  const window = and(inArray(events.calendarId, calendarIds), gt(events.startsAt, now), lte(events.startsAt, new Date(now.getTime() + TODAY_WINDOW_DAYS * DAY_MS)));
  const pick = { eventId: events.id, title: events.title, startsAt: events.startsAt };
  const [open, cancelled] = await Promise.all([
    db
      .select(pick)
      .from(events)
      .where(and(window, isNull(events.cancelledAt), sql`NOT EXISTS (SELECT 1 FROM ${eventAttendees} a WHERE a.event_id = ${events.id} AND a.member_id = ${caller.accountMemberId})`))
      .orderBy(events.startsAt, events.id)
      .limit(TODAY_LIST_MAX),
    db.select(pick).from(events).where(and(window, isNotNull(events.cancelledAt))).orderBy(events.startsAt, events.id).limit(TODAY_LIST_MAX),
  ]);
  return { open, cancelled };
}

async function unreadCount(caller: TodayCaller): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(messageDeliveries)
    .leftJoin(clubAnnouncements, eq(clubAnnouncements.id, messageDeliveries.announcementId))
    .where(
      and(
        eq(messageDeliveries.userId, caller.userId),
        eq(messageDeliveries.clubId, caller.clubId),
        eq(messageDeliveries.channel, "in_app"),
        isNull(messageDeliveries.readAt),
        or(isNull(messageDeliveries.announcementId), and(eq(clubAnnouncements.status, "sent"), or(isNull(clubAnnouncements.expiresAt), gt(clubAnnouncements.expiresAt, sql`now()`)))),
      ),
    );
  return row?.n ?? 0;
}

async function dueReturns(caller: TodayCaller, now: Date) {
  return db
    .select({ loanId: inventoryLoans.id, itemName: inventoryItems.name, dueAt: inventoryLoans.dueAt })
    .from(inventoryLoans)
    .innerJoin(inventoryItems, eq(inventoryItems.id, inventoryLoans.itemId))
    .where(and(eq(inventoryItems.clubId, caller.clubId), eq(inventoryLoans.memberId, caller.accountMemberId), isNull(inventoryLoans.returnedAt), isNotNull(inventoryLoans.dueAt), lte(inventoryLoans.dueAt, new Date(now.getTime() + RETURN_LEAD_DAYS * DAY_MS))))
    .orderBy(inventoryLoans.dueAt, inventoryLoans.id)
    .limit(TODAY_LIST_MAX) as Promise<Array<{ loanId: string; itemName: string; dueAt: Date }>>;
}

/** Open ballots the caller may still vote in: eligible on the roll, not voted, window open; in-session ballots need the check-in. */
async function openBallotCount(caller: TodayCaller): Promise<number> {
  if (caller.isGuest) return 0;
  const me = await callerClubMemberId(db, caller.clubId, caller.accountMemberId);
  if (!me) return 0;
  const [row] = await db
    .select({ n: count() })
    .from(ballots)
    .where(
      and(
        eq(ballots.clubId, caller.clubId),
        eq(ballots.status, "open"),
        or(isNull(ballots.opensAt), lte(ballots.opensAt, sql`now()`)),
        or(isNull(ballots.closesAt), gt(ballots.closesAt, sql`now()`)),
        exists(db.select({ one: sql`1` }).from(ballotVoters).where(and(eq(ballotVoters.ballotId, ballots.id), eq(ballotVoters.clubMemberId, me), eq(ballotVoters.eligible, true), eq(ballotVoters.hasVoted, false)))),
        or(
          eq(ballots.mode, "circular"),
          exists(db.select({ one: sql`1` }).from(meetingAttendance).where(and(eq(meetingAttendance.meetingId, ballots.meetingId), eq(meetingAttendance.clubMemberId, me), eq(meetingAttendance.present, true)))),
        ),
      ),
    );
  return row?.n ?? 0;
}

async function boardSection(caller: TodayCaller, now: Date): Promise<TodayOverview["board"] | undefined> {
  const may = (p: Parameters<typeof hasClubPermission>[1]) => !caller.isGuest && hasClubPermission(caller.roleTypes, p);
  const board: NonNullable<TodayOverview["board"]> = {};
  const jobs: Array<Promise<void>> = [];
  if (may("members:write")) {
    jobs.push(
      db
        .select({ n: count() })
        .from(clubApplications)
        .where(and(eq(clubApplications.clubId, caller.clubId), eq(clubApplications.status, "pending")))
        .then(([r]) => void (board.openApplications = r?.n ?? 0)),
      db
        .select({ n: count() })
        .from(clubExitRequests)
        .innerJoin(clubMembers, eq(clubMembers.id, clubExitRequests.clubMemberId))
        .where(and(eq(clubMembers.clubId, caller.clubId), eq(clubExitRequests.status, "pending")))
        .then(([r]) => void (board.openExits = r?.n ?? 0)),
    );
  }
  if (may("inventory:write")) {
    jobs.push(
      db
        .select({ maintenanceIntervalDays: inventoryItems.maintenanceIntervalDays, lastMaintenanceAt: inventoryItems.lastMaintenanceAt, acquiredAt: inventoryItems.acquiredAt })
        .from(inventoryItems)
        .where(and(eq(inventoryItems.clubId, caller.clubId), isNotNull(inventoryItems.maintenanceIntervalDays)))
        .then((items) => void (board.maintenanceDue = items.filter((i) => isMaintenanceDue(i, now)).length)),
    );
  }
  if (may("club_stats:read")) {
    jobs.push(
      db
        .select({ n: count() })
        .from(clubMembers)
        .where(and(eq(clubMembers.clubId, caller.clubId), visibleStatusCondition(todayBerlin())))
        .then(([r]) => void (board.memberCount = r?.n ?? 0)),
    );
  }
  await Promise.all(jobs);
  return Object.keys(board).length > 0 ? board : undefined;
}

/** Setup checklist for a new club; only for callers who maintain the club data, gone once everything is done. */
async function setupSection(caller: TodayCaller): Promise<TodayOverview["setup"] | undefined> {
  if (caller.isGuest || !hasClubPermission(caller.roleTypes, "club_info:write")) return undefined;
  const has = (rows: Array<{ n: number }>) => (rows[0]?.n ?? 0) > 0;
  const [logo, depts, calendar, location, others] = await Promise.all([
    db.select({ n: count() }).from(clubSettings).where(and(eq(clubSettings.clubId, caller.clubId), isNotNull(clubSettings.brandLogoKey))),
    db.select({ n: count() }).from(departments).where(eq(departments.clubId, caller.clubId)),
    db.select({ n: count() }).from(events).innerJoin(calendars, eq(calendars.id, events.calendarId)).where(eq(calendars.clubId, caller.clubId)),
    db.select({ n: count() }).from(locations).where(eq(locations.clubId, caller.clubId)),
    // "Members" is done once somebody besides the founder is in the club.
    db.select({ n: count() }).from(clubMembers).where(and(eq(clubMembers.clubId, caller.clubId), visibleStatusCondition(todayBerlin()))),
  ]);
  const state: Record<SetupKey, boolean> = {
    logo: has(logo),
    departments: has(depts),
    calendar: has(calendar),
    location: has(location),
    members: (others[0]?.n ?? 0) > 1,
  };
  const done = SETUP_KEYS.filter((k) => state[k]);
  const open = SETUP_KEYS.filter((k) => !state[k]);
  return open.length === 0 ? undefined : { done, open };
}

export async function buildToday(caller: TodayCaller, now = new Date()): Promise<TodayOverview> {
  const [ev, unread, returns, ballotsOpen, board, setup] = await Promise.all([upcomingEvents(caller, now), unreadCount(caller), dueReturns(caller, now), openBallotCount(caller), boardSection(caller, now), setupSection(caller)]);
  return {
    generatedAt: now.toISOString(),
    openRsvps: ev.open,
    cancelled: ev.cancelled,
    unreadAnnouncements: unread,
    dueReturns: returns,
    openBallots: ballotsOpen,
    ...(board ? { board } : {}),
    ...(setup ? { setup } : {}),
  };
}
