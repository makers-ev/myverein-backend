import { relations } from "drizzle-orm";
import { boolean, date, index, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { organization, user } from "../../auth/auth-schema.js";
import { clubMembers } from "./club-members.js";
import { departments } from "./departments.js";
import { meetings } from "./meetings.js";

/**
 * General assembly (Wave 11). All club-member references are `set null` or `cascade` of the row that is about the person,
 * never a hard cascade on person deletion of records the club has to keep (voter rolls, attendance, minutes): the erasure
 * contributor `assembly_data` pseudonymises them (`lib/privacy/contributors.ts`).
 */

export const VOTE_KINDS = ["none", "resolution", "election"] as const;
export const INVITATION_KINDS = ["einladung", "nachtrag"] as const;
export const DELIVERY_CHANNELS = ["email", "inapp", "post"] as const;
export const DELIVERY_STATUSES = ["queued", "sent", "failed", "bounced", "manual_posted"] as const;
export const CHECK_IN_METHODS = ["schriftfuehrer", "self_online", "vollmacht"] as const;
export const BALLOT_STATUSES = ["draft", "open", "closed", "counted", "finalized", "cancelled"] as const;
export const BALLOT_MODES = ["in_session", "circular"] as const;
export const BALLOT_KINDS = ["resolution", "election"] as const;
/** `yes`/`no`/`abstain` form a yes-no ballot; `choice` is a free option; `candidate` is a person of an election round. */
export const BALLOT_OPTION_KINDS = ["yes", "no", "abstain", "choice", "candidate"] as const;
/** Who votes in a circular resolution: every member with a voting right, or the board accounts. */
export const BALLOT_AUDIENCES = ["all_voting_members", "board"] as const;
export const MINUTES_STATUSES = ["entwurf", "zur_genehmigung", "genehmigt", "archiviert"] as const;
export const ELECTION_STATUSES = ["planned", "running", "decided", "closed"] as const;
export const CANDIDATE_STATUSES = ["proposed", "willing", "declined", "withdrawn", "elected", "accepted", "pending_account"] as const;

/** Structured agenda (Tagesordnung); `meetings.agenda` stays as free text for old meetings. */
export const meetingAgendaItems = pgTable(
  "meeting_agenda_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    meetingId: uuid("meeting_id")
      .notNull()
      .references(() => meetings.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    // One of VOTE_KINDS (Zod-validated).
    voteKind: text("vote_kind").notNull().default("none"),
    // Key of `assemblyRules.majorityByTopic`; decides which majority a ballot of this item needs.
    topic: text("topic").notNull().default("allgemein"),
    // The invitation (version) that announced this item; NULL = not announced yet.
    announcedInInvitationId: uuid("announced_in_invitation_id").references(() => meetingInvitations.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("meeting_agenda_items_meeting_idx").on(table.meetingId, table.position)],
);

/** One sent invitation (or Nachtrag) of a meeting with a frozen content snapshot and the result of the period check. */
export const meetingInvitations = pgTable(
  "meeting_invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    meetingId: uuid("meeting_id")
      .notNull()
      .references(() => meetings.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    // One of INVITATION_KINDS.
    kind: text("kind").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
    sentBy: text("sent_by").references(() => user.id, { onDelete: "set null" }),
    // Snapshot of what was sent: title, time, place, agenda items, free text. `content_hash` = SHA-256 of its canonical JSON.
    content: jsonb("content").$type<Record<string, unknown>>().notNull(),
    contentHash: text("content_hash").notNull(),
    rulesSnapshot: jsonb("rules_snapshot").$type<Record<string, unknown>>().notNull(),
    // Result of `checkInvitationPeriod` at sending time.
    periodCheck: jsonb("period_check").$type<Record<string, unknown>>().notNull(),
    // Set when the period was violated and `assembly:manage` sent anyway; shown in the minutes.
    exceptionReason: text("exception_reason"),
    recipientCount: integer("recipient_count").notNull().default(0),
  },
  (table) => [unique("meeting_invitations_meeting_version_uq").on(table.meetingId, table.version)],
);

/** Delivery of an invitation to one member over one channel. The address is never copied here. */
export const meetingInvitationDeliveries = pgTable(
  "meeting_invitation_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    invitationId: uuid("invitation_id")
      .notNull()
      .references(() => meetingInvitations.id, { onDelete: "cascade" }),
    // NULL once the person is erased (the proof that an invitation went out stays).
    clubMemberId: uuid("club_member_id").references(() => clubMembers.id, { onDelete: "set null" }),
    // One of DELIVERY_CHANNELS / DELIVERY_STATUSES.
    channel: text("channel").notNull(),
    status: text("status").notNull(),
    // Machine-readable reason of a failure (`no_address`, `smtp_rejected`, ...); never the address.
    errorCode: text("error_code"),
    statusAt: timestamp("status_at", { withTimezone: true }).notNull().defaultNow(),
    postedAt: timestamp("posted_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("meeting_invitation_deliveries_uidx").on(table.invitationId, table.clubMemberId, table.channel),
    index("meeting_invitation_deliveries_member_idx").on(table.clubMemberId),
  ],
);

/** The frozen list of voting members of a meeting (Stimmberechtigtenverzeichnis) with the reason for each entry. */
export const meetingVotingRoll = pgTable(
  "meeting_voting_roll",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    meetingId: uuid("meeting_id")
      .notNull()
      .references(() => meetings.id, { onDelete: "cascade" }),
    clubMemberId: uuid("club_member_id").references(() => clubMembers.id, { onDelete: "set null" }),
    eligible: boolean("eligible").notNull(),
    // Why: `category`, `status`, `min_age`, `rules_missing`, `override`, ... (codes from `deriveVotingRight`).
    basis: text("basis").notNull(),
    overrideReason: text("override_reason"),
    overriddenBy: text("overridden_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("meeting_voting_roll_meeting_member_uidx").on(table.meetingId, table.clubMemberId), index("meeting_voting_roll_member_idx").on(table.clubMemberId)],
);

/** Proxy (Vollmacht): the grantor lets the holder vote for them in this meeting. One holder per grantor and meeting. */
export const meetingProxies = pgTable(
  "meeting_proxies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    meetingId: uuid("meeting_id")
      .notNull()
      .references(() => meetings.id, { onDelete: "cascade" }),
    grantorClubMemberId: uuid("grantor_club_member_id").references(() => clubMembers.id, { onDelete: "set null" }),
    holderClubMemberId: uuid("holder_club_member_id").references(() => clubMembers.id, { onDelete: "set null" }),
    grantedBy: text("granted_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("meeting_proxies_meeting_grantor_uidx").on(table.meetingId, table.grantorClubMemberId), index("meeting_proxies_holder_idx").on(table.meetingId, table.holderClubMemberId)],
);

/** A vote, a Wahlgang or a Umlaufbeschluss. */
export const ballots = pgTable(
  "ballots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clubId: text("club_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    meetingId: uuid("meeting_id").references(() => meetings.id, { onDelete: "cascade" }),
    agendaItemId: uuid("agenda_item_id").references(() => meetingAgendaItems.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    description: text("description"),
    // One of BALLOT_MODES.
    mode: text("mode").notNull().default("in_session"),
    // One of BALLOT_KINDS.
    kind: text("kind").notNull().default("resolution"),
    // Circular resolutions only: one of BALLOT_AUDIENCES.
    audience: text("audience"),
    // Election rounds: the election and the number of the round (Wahlgang).
    electionId: uuid("election_id").references(() => elections.id, { onDelete: "set null" }),
    round: integer("round"),
    secret: boolean("secret").notNull().default(false),
    topic: text("topic").notNull().default("allgemein"),
    // Majority kind (`assemblyRules` MAJORITY_KINDS) frozen at opening time.
    majority: text("majority"),
    maxChoices: integer("max_choices").notNull().default(1),
    opensAt: timestamp("opens_at", { withTimezone: true }),
    closesAt: timestamp("closes_at", { withTimezone: true }),
    // One of BALLOT_STATUSES.
    status: text("status").notNull().default("draft"),
    rulesSnapshot: jsonb("rules_snapshot").$type<Record<string, unknown>>(),
    // What counted when the ballot was opened (quorum, number of eligible voters, reference day).
    opening: jsonb("opening").$type<Record<string, unknown>>(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    countedAt: timestamp("counted_at", { withTimezone: true }),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    // Frozen result at `finalized` plus its SHA-256.
    result: jsonb("result").$type<Record<string, unknown>>(),
    resultHash: text("result_hash"),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("ballots_club_status_idx").on(table.clubId, table.status), index("ballots_meeting_idx").on(table.meetingId), index("ballots_election_idx").on(table.electionId)],
);

export const ballotOptions = pgTable(
  "ballot_options",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ballotId: uuid("ballot_id")
      .notNull()
      .references(() => ballots.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    label: text("label").notNull(),
    // One of BALLOT_OPTION_KINDS.
    kind: text("kind").notNull().default("choice"),
    // Set for an election option that is a candidate.
    candidateClubMemberId: uuid("candidate_club_member_id").references(() => clubMembers.id, { onDelete: "set null" }),
  },
  (table) => [index("ballot_options_ballot_idx").on(table.ballotId, table.position), index("ballot_options_candidate_idx").on(table.candidateClubMemberId)],
);

/** Voter roll of a ballot. The unique pair stops double votes. `cast_by` is the proxy holder when the vote is cast for someone else. */
export const ballotVoters = pgTable(
  "ballot_voters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ballotId: uuid("ballot_id")
      .notNull()
      .references(() => ballots.id, { onDelete: "cascade" }),
    clubMemberId: uuid("club_member_id").references(() => clubMembers.id, { onDelete: "set null" }),
    castByClubMemberId: uuid("cast_by_club_member_id").references(() => clubMembers.id, { onDelete: "set null" }),
    eligible: boolean("eligible").notNull().default(true),
    basis: text("basis").notNull(),
    hasVoted: boolean("has_voted").notNull().default(false),
  },
  (table) => [
    uniqueIndex("ballot_voters_ballot_member_uidx").on(table.ballotId, table.clubMemberId),
    index("ballot_voters_member_idx").on(table.clubMemberId),
    index("ballot_voters_cast_by_idx").on(table.castByClubMemberId),
  ],
);

/** Open (named) vote. */
export const ballotVotesOpen = pgTable(
  "ballot_votes_open",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ballotId: uuid("ballot_id")
      .notNull()
      .references(() => ballots.id, { onDelete: "cascade" }),
    optionId: uuid("option_id")
      .notNull()
      .references(() => ballotOptions.id, { onDelete: "cascade" }),
    clubMemberId: uuid("club_member_id").references(() => clubMembers.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("ballot_votes_open_ballot_idx").on(table.ballotId), index("ballot_votes_open_member_idx").on(table.clubMemberId)],
);

/**
 * Secret vote (ADR option A). DELIBERATELY without a reference to a member or to the voter roll, without any timestamp and
 * with a random primary key (no sequence, no insertion order). Do not add columns that could link a row to a person.
 */
export const ballotVotesSecret = pgTable(
  "ballot_votes_secret",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ballotId: uuid("ballot_id")
      .notNull()
      .references(() => ballots.id, { onDelete: "cascade" }),
    optionId: uuid("option_id")
      .notNull()
      .references(() => ballotOptions.id, { onDelete: "cascade" }),
  },
  (table) => [index("ballot_votes_secret_ballot_idx").on(table.ballotId)],
);

/** An election of an office; the rounds are `ballots` (kind election). */
export const elections = pgTable(
  "elections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clubId: text("club_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    meetingId: uuid("meeting_id").references(() => meetings.id, { onDelete: "set null" }),
    roleType: text("role_type").notNull(),
    departmentId: uuid("department_id").references(() => departments.id, { onDelete: "set null" }),
    seats: integer("seats").notNull().default(1),
    termMonths: integer("term_months"),
    // The person who runs the election (must not be a candidate).
    electionLeadClubMemberId: uuid("election_lead_club_member_id").references(() => clubMembers.id, { onDelete: "set null" }),
    // One of ELECTION_STATUSES.
    status: text("status").notNull().default("planned"),
    // Who won the seats (candidate ids, a documented lot where votes tied); the roles follow from the acceptance.
    decision: jsonb("decision").$type<Record<string, unknown>>(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("elections_club_idx").on(table.clubId), index("elections_lead_idx").on(table.electionLeadClubMemberId)],
);

export const electionCandidates = pgTable(
  "election_candidates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    electionId: uuid("election_id")
      .notNull()
      .references(() => elections.id, { onDelete: "cascade" }),
    clubMemberId: uuid("club_member_id").references(() => clubMembers.id, { onDelete: "set null" }),
    proposedBy: uuid("proposed_by").references(() => clubMembers.id, { onDelete: "set null" }),
    // One of CANDIDATE_STATUSES.
    status: text("status").notNull().default("proposed"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("election_candidates_election_member_uidx").on(table.electionId, table.clubMemberId),
    index("election_candidates_member_idx").on(table.clubMemberId),
    index("election_candidates_proposed_by_idx").on(table.proposedBy),
  ],
);

/** History of terms of office; `club_roles` stays the effective assignment. */
export const clubRoleTerms = pgTable(
  "club_role_terms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clubId: text("club_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    clubMemberId: uuid("club_member_id").references(() => clubMembers.id, { onDelete: "set null" }),
    roleType: text("role_type").notNull(),
    departmentId: uuid("department_id").references(() => departments.id, { onDelete: "set null" }),
    startsOn: date("starts_on", { mode: "string" }).notNull(),
    endsOn: date("ends_on", { mode: "string" }),
    electionId: uuid("election_id").references(() => elections.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("club_role_terms_club_idx").on(table.clubId), index("club_role_terms_member_idx").on(table.clubMemberId)],
);

/** Minutes of a meeting, one row per version. Immutable once `genehmigt` (app check and trigger, package B9). */
export const meetingMinutes = pgTable(
  "meeting_minutes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    meetingId: uuid("meeting_id")
      .notNull()
      .references(() => meetings.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    // One of MINUTES_STATUSES.
    status: text("status").notNull().default("entwurf"),
    content: text("content").notNull().default(""),
    contentHash: text("content_hash").notNull(),
    approvedInMeetingId: uuid("approved_in_meeting_id").references(() => meetings.id, { onDelete: "set null" }),
    approvedResolutionId: uuid("approved_resolution_id"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("meeting_minutes_meeting_version_uq").on(table.meetingId, table.version), index("meeting_minutes_approved_in_idx").on(table.approvedInMeetingId)],
);

/** Berichtigungsvermerk on approved minutes. */
export const meetingMinutesAmendments = pgTable(
  "meeting_minutes_amendments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    minutesId: uuid("minutes_id")
      .notNull()
      .references(() => meetingMinutes.id, { onDelete: "cascade" }),
    note: text("note").notNull(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("meeting_minutes_amendments_minutes_idx").on(table.minutesId)],
);

export const meetingAgendaItemsRelations = relations(meetingAgendaItems, ({ one }) => ({
  meeting: one(meetings, { fields: [meetingAgendaItems.meetingId], references: [meetings.id] }),
}));

export const meetingInvitationsRelations = relations(meetingInvitations, ({ one, many }) => ({
  meeting: one(meetings, { fields: [meetingInvitations.meetingId], references: [meetings.id] }),
  deliveries: many(meetingInvitationDeliveries),
}));

export const ballotsRelations = relations(ballots, ({ many }) => ({
  options: many(ballotOptions),
  voters: many(ballotVoters),
}));

export type MeetingAgendaItemRow = typeof meetingAgendaItems.$inferSelect;
export type MeetingInvitationRow = typeof meetingInvitations.$inferSelect;
export type MeetingInvitationDeliveryRow = typeof meetingInvitationDeliveries.$inferSelect;
export type MeetingVotingRollRow = typeof meetingVotingRoll.$inferSelect;
export type MeetingProxyRow = typeof meetingProxies.$inferSelect;
export type BallotRow = typeof ballots.$inferSelect;
export type BallotOptionRow = typeof ballotOptions.$inferSelect;
export type ElectionRow = typeof elections.$inferSelect;
export type ElectionCandidateRow = typeof electionCandidates.$inferSelect;
