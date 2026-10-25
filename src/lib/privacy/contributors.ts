import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";

import { absenceReports, wardEventResponses } from "../../db/schema/absences.js";
import { availabilityExceptions, availabilitySlots } from "../../db/schema/availability.js";
import { calendarVisibility } from "../../db/schema/calendar-visibility.js";
import { clubApplications } from "../../db/schema/club-applications.js";
import { clubExitRequests } from "../../db/schema/club-exit-requests.js";
import { clubMemberInvites } from "../../db/schema/club-member-invites.js";
import { clubMemberDepartments, clubMembers, clubMemberStatusHistory, memberCategories } from "../../db/schema/club-members.js";
import { clubMemberships } from "../../db/schema/club-memberships.js";
import { clubRoles } from "../../db/schema/club-roles.js";
import { clubAnnouncements, messageDeliveries, notificationPreferences } from "../../db/schema/communication.js";
import { departments } from "../../db/schema/departments.js";
import { events } from "../../db/schema/events.js";
import { formSubmissions, memberFieldDefinitions, memberFieldValues } from "../../db/schema/forms.js";
import { guardianLinks } from "../../db/schema/guardian-links.js";
import { inventoryDamageReports, inventoryItems, inventoryLoans } from "../../db/schema/inventory.js";
import { locationKeyHistory, locationKeyHolders } from "../../db/schema/locations.js";
import { mediaFiles } from "../../db/schema/media-files.js";
import { ballotOptions, ballotVoters, ballotVotesOpen, clubRoleTerms, electionCandidates, elections, meetingInvitationDeliveries, meetingProxies, meetingVotingRoll } from "../../db/schema/assembly.js";
import { meetingAttendance, meetingInvitees } from "../../db/schema/meetings.js";
import { consentPurposes, consentRecords, consentTexts, memberFieldVisibility } from "../../db/schema/privacy.js";
import type { DbExecutor } from "../club-members.js";
import { eraseFormDataOfMember } from "../form-retention.js";
import { markMediaDeleted } from "../media.js";
import { todayBerlin } from "../member-lifecycle.js";
import { eventParticipation } from "./contributors-events.js";
import type { PrivacyContributor, PrivacySubject } from "./registry.js";

/** Text that replaces the name of an erased person wherever a name snapshot has to stay readable. */
export const ERASED_NAME = "Gelöschtes Mitglied";

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

async function rowCount(result: Promise<{ rowCount: number | null }>): Promise<number> {
  return (await result).rowCount ?? 0;
}

/** Master data of the person and the rows that hang directly on it. */
const memberCore: PrivacyContributor = {
  key: "member_core",
  tables: ["club_members", "club_member_departments", "club_member_status_history", "club_member_invites", "member_field_values", "member_field_visibility"],
  async exportSubject(ex, s) {
    const [row] = await ex.select().from(clubMembers).where(and(eq(clubMembers.id, s.clubMemberId), eq(clubMembers.clubId, s.clubId)));
    if (!row) return {};
    const [category] = row.categoryId ? await ex.select({ name: memberCategories.name }).from(memberCategories).where(eq(memberCategories.id, row.categoryId)) : [];
    const deps = await ex
      .select({ department: departments.name, since: clubMemberDepartments.since, until: clubMemberDepartments.until })
      .from(clubMemberDepartments)
      .innerJoin(departments, eq(departments.id, clubMemberDepartments.departmentId))
      .where(eq(clubMemberDepartments.clubMemberId, s.clubMemberId))
      .orderBy(asc(clubMemberDepartments.since));
    const history = await ex
      .select({ fromStatus: clubMemberStatusHistory.fromStatus, toStatus: clubMemberStatusHistory.toStatus, effectiveOn: clubMemberStatusHistory.effectiveOn, reason: clubMemberStatusHistory.reason })
      .from(clubMemberStatusHistory)
      .where(eq(clubMemberStatusHistory.clubMemberId, s.clubMemberId))
      .orderBy(asc(clubMemberStatusHistory.effectiveOn), asc(clubMemberStatusHistory.createdAt));
    const fields = await ex
      .select({ label: memberFieldDefinitions.label, value: memberFieldValues.value, enteredVia: memberFieldValues.enteredVia, updatedAt: memberFieldValues.updatedAt })
      .from(memberFieldValues)
      .innerJoin(memberFieldDefinitions, eq(memberFieldDefinitions.id, memberFieldValues.fieldId))
      .where(eq(memberFieldValues.clubMemberId, s.clubMemberId))
      .orderBy(asc(memberFieldDefinitions.sortOrder));
    const visibility = await ex.select({ field: memberFieldVisibility.field, level: memberFieldVisibility.level }).from(memberFieldVisibility).where(eq(memberFieldVisibility.clubMemberId, s.clubMemberId));
    const [invite] = await ex
      .select({ email: clubMemberInvites.email, expiresAt: clubMemberInvites.expiresAt })
      .from(clubMemberInvites)
      .where(and(eq(clubMemberInvites.clubMemberId, s.clubMemberId), isNull(clubMemberInvites.acceptedAt)));
    return {
      masterData: {
        displayName: row.displayName,
        firstName: row.firstName,
        lastName: row.lastName,
        birthDate: row.birthDate,
        street: row.street,
        postalCode: row.postalCode,
        city: row.city,
        phone: row.phone,
        contactEmail: row.contactEmail,
        emergencyContactName: row.emergencyContactName,
        emergencyContactPhone: row.emergencyContactPhone,
        memberNumber: row.memberNumber,
        category: category?.name ?? null,
        status: row.status,
        joinedAt: row.joinedAt,
        leftAt: row.leftAt,
        exitReason: row.exitReason,
        hasAccount: row.memberId !== null,
        hasPhoto: row.photoKey !== null,
        privacyNoticeSentAt: iso(row.privacyNoticeSentAt),
        createdAt: iso(row.createdAt),
      },
      departments: deps,
      statusHistory: history,
      customFields: fields.map((f) => ({ ...f, updatedAt: iso(f.updatedAt) })),
      fieldVisibility: visibility,
      openAccountInvitation: invite ? { email: invite.email, expiresAt: iso(invite.expiresAt) } : null,
    };
  },
  async eraseSubject(tx, s) {
    const [row] = await tx.select().from(clubMembers).where(and(eq(clubMembers.id, s.clubMemberId), eq(clubMembers.clubId, s.clubId))).for("update");
    if (!row) return { deleted: 0, anonymized: 0, kept: 0 };
    const purge: string[] = [];
    if (row.photoKey && (await markMediaDeleted(row.photoKey, tx, s.clubId))) purge.push(row.photoKey);
    const today = todayBerlin();
    const left = ["ausgetreten", "ausgeschlossen", "verstorben"].includes(row.status) || (row.leftAt !== null && row.leftAt <= today);
    await tx
      .update(clubMembers)
      .set({
        displayName: ERASED_NAME,
        firstName: null,
        lastName: null,
        birthDate: null,
        street: null,
        postalCode: null,
        city: null,
        phone: null,
        contactEmail: null,
        emergencyContactName: null,
        emergencyContactPhone: null,
        memberNumber: null,
        exitReason: null,
        photoKey: null,
        privacyNoticeSentAt: null,
        privacyNoticeVersionId: null,
        // The record stays for counts (join date, category), but the person is out of the club.
        ...(left ? {} : { status: "ausgetreten", leftAt: today }),
        // Never matched for a re-join or an account link again.
        lastUserId: null,
        accountUnlinkedAt: row.memberId !== null ? new Date() : row.accountUnlinkedAt,
        updatedAt: new Date(),
      })
      .where(eq(clubMembers.id, row.id));
    const history = await rowCount(tx.update(clubMemberStatusHistory).set({ reason: null }).where(and(eq(clubMemberStatusHistory.clubMemberId, row.id), sql`${clubMemberStatusHistory.reason} IS NOT NULL`)));
    const invites = await rowCount(tx.delete(clubMemberInvites).where(eq(clubMemberInvites.clubMemberId, row.id)));
    const fields = await rowCount(tx.delete(memberFieldValues).where(eq(memberFieldValues.clubMemberId, row.id)));
    const visibility = await rowCount(tx.delete(memberFieldVisibility).where(eq(memberFieldVisibility.clubMemberId, row.id)));
    return {
      deleted: invites + fields + visibility + (purge.length > 0 ? 1 : 0),
      anonymized: 1 + history,
      kept: 1,
      keptReason: "Join date, category, status and department periods stay in the anonymised record for club statistics",
      purge,
    };
  },
};

/** Consent events: the proof that a consent was given or revoked (Art. 7(1)) stays. */
const consents: PrivacyContributor = {
  key: "consents",
  tables: ["consent_records"],
  async exportSubject(ex, s) {
    const rows = await ex
      .select({ purpose: consentPurposes.name, version: consentTexts.version, action: consentRecords.action, givenBy: consentRecords.givenBy, proofDate: consentRecords.proofDate, proofSource: consentRecords.proofSource, createdAt: consentRecords.createdAt })
      .from(consentRecords)
      .innerJoin(consentPurposes, eq(consentPurposes.id, consentRecords.purposeId))
      .innerJoin(consentTexts, eq(consentTexts.id, consentRecords.textVersionId))
      .where(eq(consentRecords.clubMemberId, s.clubMemberId))
      .orderBy(asc(consentRecords.createdAt));
    return { events: rows.map((r) => ({ ...r, createdAt: iso(r.createdAt) })) };
  },
  async eraseSubject(tx, s) {
    const [n] = await tx.select({ n: sql<number>`count(*)::int` }).from(consentRecords).where(eq(consentRecords.clubMemberId, s.clubMemberId));
    return { deleted: 0, anonymized: 0, kept: n?.n ?? 0, keptReason: "Proof of consent and revocation (burden of proof, Art. 7(1)); contains no master data and is removed by the retention rule" };
  },
};

const absences: PrivacyContributor = {
  key: "absences",
  tables: ["absence_reports", "ward_event_responses"],
  async exportSubject(ex, s) {
    const reports = await ex
      .select({ kind: absenceReports.kind, startsOn: absenceReports.startsOn, endsOn: absenceReports.endsOn, note: absenceReports.note, reportedBy: absenceReports.reportedByKind, withdrawnAt: absenceReports.withdrawnAt })
      .from(absenceReports)
      .where(eq(absenceReports.clubMemberId, s.clubMemberId))
      .orderBy(asc(absenceReports.startsOn));
    const responses = await ex
      .select({ event: events.title, startsAt: events.startsAt, status: wardEventResponses.status, respondedAt: wardEventResponses.respondedAt })
      .from(wardEventResponses)
      .innerJoin(events, eq(events.id, wardEventResponses.eventId))
      .where(eq(wardEventResponses.wardClubMemberId, s.clubMemberId))
      .orderBy(asc(events.startsAt));
    return {
      absences: reports.map((r) => ({ ...r, withdrawnAt: iso(r.withdrawnAt) })),
      eventResponses: responses.map((r) => ({ ...r, startsAt: iso(r.startsAt), respondedAt: iso(r.respondedAt) })),
    };
  },
  async eraseSubject(tx, s) {
    const reports = await rowCount(tx.delete(absenceReports).where(eq(absenceReports.clubMemberId, s.clubMemberId)));
    const responses = await rowCount(tx.delete(wardEventResponses).where(eq(wardEventResponses.wardClubMemberId, s.clubMemberId)));
    return { deleted: reports + responses, anonymized: 0, kept: 0 };
  },
};

/** Guardian links where the person is the child, or (with an account) the guardian. */
const guardianship: PrivacyContributor = {
  key: "guardianship",
  tables: ["guardian_links"],
  async exportSubject(ex, s) {
    const asWard = await ex
      .select({ relationship: guardianLinks.relationship, hasCustody: guardianLinks.hasCustody, canConsent: guardianLinks.canConsent, canReportAbsence: guardianLinks.canReportAbsence, validFrom: guardianLinks.validFrom, validUntil: guardianLinks.validUntil })
      .from(guardianLinks)
      .where(eq(guardianLinks.wardClubMemberId, s.clubMemberId));
    const asGuardian = s.accountMemberId
      ? await ex
          .select({ relationship: guardianLinks.relationship, validFrom: guardianLinks.validFrom, validUntil: guardianLinks.validUntil, wardFirstName: clubMembers.firstName })
          .from(guardianLinks)
          .innerJoin(clubMembers, eq(clubMembers.id, guardianLinks.wardClubMemberId))
          .where(eq(guardianLinks.guardianMemberId, s.accountMemberId))
      : [];
    // The wards are named by first name only: their data is exported with their own record, not with the guardian's.
    return { guardiansOfThisMember: asWard, wardsOfThisMember: asGuardian };
  },
  async eraseSubject(tx, s) {
    const asWard = await tx.delete(guardianLinks).where(eq(guardianLinks.wardClubMemberId, s.clubMemberId)).returning({ guardian: guardianLinks.guardianMemberId });
    // A guest guardian whose last link is gone loses the guardian role with it (as DELETE /club-members/:id/guardians/:gid does).
    for (const guardianId of new Set(asWard.map((r) => r.guardian))) {
      const remaining = await tx.select({ id: guardianLinks.id }).from(guardianLinks).where(eq(guardianLinks.guardianMemberId, guardianId)).limit(1);
      if (remaining.length === 0) await tx.delete(clubRoles).where(and(eq(clubRoles.memberId, guardianId), eq(clubRoles.roleType, "erziehungsberechtigt")));
    }
    const asGuardian = s.accountMemberId ? await rowCount(tx.delete(guardianLinks).where(eq(guardianLinks.guardianMemberId, s.accountMemberId))) : 0;
    return { deleted: asWard.length + asGuardian, anonymized: 0, kept: 0 };
  },
};

/** Applications and form submissions: the answers are erased, the fact that a submission existed stays. */
const formsAndApplications: PrivacyContributor = {
  key: "forms_and_applications",
  tables: ["club_applications", "form_submissions"],
  async exportSubject(ex, s) {
    const apps = await ex
      .select({ status: clubApplications.status, category: clubApplications.category, birthDate: clubApplications.birthDate, onBehalfOf: clubApplications.onBehalfOf, createdAt: clubApplications.createdAt, decidedAt: clubApplications.decidedAt, privacyNoticeAcknowledgedAt: clubApplications.privacyNoticeAcknowledgedAt, submissionId: clubApplications.formSubmissionId })
      .from(clubApplications)
      .where(and(eq(clubApplications.clubId, s.clubId), eq(clubApplications.clubMemberId, s.clubMemberId)));
    const subIds = apps.map((a) => a.submissionId).filter((id): id is string => id !== null);
    const subs = await ex
      .select({ id: formSubmissions.id, status: formSubmissions.status, answers: formSubmissions.answers, submittedAt: formSubmissions.submittedAt, decisionNote: formSubmissions.decisionNote })
      .from(formSubmissions)
      .where(and(eq(formSubmissions.clubId, s.clubId), or(eq(formSubmissions.subjectClubMemberId, s.clubMemberId), subIds.length > 0 ? inArray(formSubmissions.id, subIds) : undefined)));
    return {
      applications: apps.map(({ submissionId: _id, ...a }) => ({ ...a, createdAt: iso(a.createdAt), decidedAt: iso(a.decidedAt), privacyNoticeAcknowledgedAt: iso(a.privacyNoticeAcknowledgedAt) })),
      formSubmissions: subs.map((r) => ({ ...r, submittedAt: iso(r.submittedAt) })),
    };
  },
  async eraseSubject(tx, s) {
    const out = await eraseFormDataOfMember(tx, { clubId: s.clubId, clubMemberId: s.clubMemberId, erasedBy: null });
    return { deleted: out.files, anonymized: out.submissions, kept: 0, purge: out.purge };
  },
};

const exitRequests: PrivacyContributor = {
  key: "exit_requests",
  tables: ["club_exit_requests"],
  async exportSubject(ex, s) {
    const rows = await ex
      .select({ kind: clubExitRequests.kind, status: clubExitRequests.status, requestedOn: clubExitRequests.requestedOn, effectiveOn: clubExitRequests.effectiveOn, reason: clubExitRequests.reason, decisionNote: clubExitRequests.decisionNote })
      .from(clubExitRequests)
      .where(eq(clubExitRequests.clubMemberId, s.clubMemberId))
      .orderBy(asc(clubExitRequests.requestedOn));
    return { exitRequests: rows };
  },
  async eraseSubject(tx, s) {
    const n = await rowCount(tx.update(clubExitRequests).set({ reason: null, decisionNote: null }).where(eq(clubExitRequests.clubMemberId, s.clubMemberId)));
    return { deleted: 0, anonymized: n, kept: n, keptReason: "Dates, kind and decision stay as proof of the membership end; reasons and notes are removed" };
  },
};

/** Notifications and preferences. */
const communication: PrivacyContributor = {
  key: "communication",
  tables: ["message_deliveries", "notification_preferences", "club_announcements"],
  async exportSubject(ex, s) {
    const deliveries = await ex
      .select({ channel: messageDeliveries.channel, status: messageDeliveries.status, eventKey: messageDeliveries.eventKey, sentAt: messageDeliveries.sentAt, readAt: messageDeliveries.readAt, createdAt: messageDeliveries.createdAt })
      .from(messageDeliveries)
      .where(and(eq(messageDeliveries.clubMemberId, s.clubMemberId), eq(messageDeliveries.clubId, s.clubId)))
      .orderBy(asc(messageDeliveries.createdAt))
      .limit(1000);
    const prefs = await ex
      .select({ category: notificationPreferences.category, channel: notificationPreferences.channel, enabled: notificationPreferences.enabled })
      .from(notificationPreferences)
      .where(eq(notificationPreferences.clubMemberId, s.clubMemberId));
    const authored = await ex
      .select({ title: clubAnnouncements.title, status: clubAnnouncements.status, createdAt: clubAnnouncements.createdAt })
      .from(clubAnnouncements)
      .where(and(eq(clubAnnouncements.clubId, s.clubId), eq(clubAnnouncements.authorMemberId, s.clubMemberId)));
    return {
      notifications: deliveries.map((d) => ({ ...d, sentAt: iso(d.sentAt), readAt: iso(d.readAt), createdAt: iso(d.createdAt) })),
      notificationSettings: prefs,
      announcementsAuthored: authored.map((a) => ({ ...a, createdAt: iso(a.createdAt) })),
    };
  },
  async eraseSubject(tx, s) {
    const deliveries = await rowCount(
      tx.execute(sql`
        UPDATE message_deliveries
        SET address = NULL,
            content = CASE WHEN content IS NULL THEN NULL ELSE jsonb_strip_nulls(jsonb_build_object('title', content->'title', 'template', content->'template', 'category', content->'category', 'class', content->'class', 'scrubbed', true)) END
        WHERE club_member_id = ${s.clubMemberId} AND (address IS NOT NULL OR (content IS NOT NULL AND content->>'scrubbed' IS NULL))`),
    );
    const prefs = await rowCount(tx.delete(notificationPreferences).where(eq(notificationPreferences.clubMemberId, s.clubMemberId)));
    const authored = await rowCount(tx.update(clubAnnouncements).set({ authorMemberId: null }).where(and(eq(clubAnnouncements.clubId, s.clubId), eq(clubAnnouncements.authorMemberId, s.clubMemberId))));
    return { deleted: prefs, anonymized: deliveries + authored, kept: 0 };
  },
};

/** Data bound to the login-side membership (`member`); only present while the person has an account in this club. */
const accountData: PrivacyContributor = {
  key: "account_data",
  tables: [
    "availability_slots",
    "availability_exceptions",
    "calendar_visibility",
    "club_memberships",
    "club_roles",
    "inventory_loans",
    "inventory_damage_reports",
    "location_key_holders",
    "location_key_history",
  ],
  async exportSubject(ex, s) {
    const m = s.accountMemberId;
    if (!m) return { account: null };
    const roles = await ex.select({ roleType: clubRoles.roleType, termEndsAt: clubRoles.termEndsAt }).from(clubRoles).where(eq(clubRoles.memberId, m));
    const slots = await ex.select({ weekday: availabilitySlots.weekday, startTime: availabilitySlots.startTime, endTime: availabilitySlots.endTime, note: availabilitySlots.note }).from(availabilitySlots).where(eq(availabilitySlots.memberId, m));
    const exceptions = await ex.select({ date: availabilityExceptions.date, isAvailable: availabilityExceptions.isAvailable, note: availabilityExceptions.note }).from(availabilityExceptions).where(eq(availabilityExceptions.memberId, m));
    const loans = await ex
      .select({ item: inventoryItems.name, borrowedAt: inventoryLoans.borrowedAt, dueAt: inventoryLoans.dueAt, returnedAt: inventoryLoans.returnedAt, status: inventoryLoans.status })
      .from(inventoryLoans)
      .innerJoin(inventoryItems, eq(inventoryItems.id, inventoryLoans.itemId))
      .where(eq(inventoryLoans.memberId, m));
    const damage = await ex
      .select({ item: inventoryItems.name, description: inventoryDamageReports.description, status: inventoryDamageReports.status, createdAt: inventoryDamageReports.createdAt })
      .from(inventoryDamageReports)
      .innerJoin(inventoryItems, eq(inventoryItems.id, inventoryDamageReports.itemId))
      .where(eq(inventoryDamageReports.reportedBy, m));
    const keys = await ex.select({ keyLabel: locationKeyHolders.keyLabel }).from(locationKeyHolders).where(eq(locationKeyHolders.memberId, m));
    const [legacy] = await ex.select({ category: clubMemberships.category, joinedAt: clubMemberships.joinedAt, leftAt: clubMemberships.leftAt }).from(clubMemberships).where(eq(clubMemberships.memberId, m));
    const visibleTo = await ex.select({ calendarId: calendarVisibility.calendarId }).from(calendarVisibility).where(eq(calendarVisibility.memberId, m));
    return {
      account: {
        roles,
        availability: { slots, exceptions },
        loans: loans.map((l) => ({ ...l, borrowedAt: iso(l.borrowedAt), dueAt: iso(l.dueAt), returnedAt: iso(l.returnedAt) })),
        damageReports: damage.map((d) => ({ ...d, createdAt: iso(d.createdAt) })),
        keysHeld: keys,
        calendarGrants: visibleTo.length,
        legacyMembership: legacy ?? null,
      },
    };
  },
  async eraseSubject(tx, s) {
    const m = s.accountMemberId;
    if (!m) return { deleted: 0, anonymized: 0, kept: 0 };
    const purge: string[] = [];
    const damage = await tx.select({ photoKey: inventoryDamageReports.photoKey }).from(inventoryDamageReports).where(eq(inventoryDamageReports.reportedBy, m));
    for (const d of damage) if (d.photoKey && (await markMediaDeleted(d.photoKey, tx, s.clubId))) purge.push(d.photoKey);
    let deleted = 0;
    for (const t of [
      tx.delete(clubRoles).where(eq(clubRoles.memberId, m)),
      tx.delete(availabilitySlots).where(eq(availabilitySlots.memberId, m)),
      tx.delete(availabilityExceptions).where(eq(availabilityExceptions.memberId, m)),
      tx.delete(calendarVisibility).where(eq(calendarVisibility.memberId, m)),
      tx.delete(inventoryLoans).where(eq(inventoryLoans.memberId, m)),
      tx.delete(inventoryDamageReports).where(eq(inventoryDamageReports.reportedBy, m)),
      tx.delete(locationKeyHolders).where(eq(locationKeyHolders.memberId, m)),
      tx.delete(clubMemberships).where(eq(clubMemberships.memberId, m)),
    ]) {
      deleted += await rowCount(t);
    }
    // The key log keeps who-held-what for the club's records, but not the name.
    const keyLog = await rowCount(tx.update(locationKeyHistory).set({ memberName: ERASED_NAME, memberId: null }).where(eq(locationKeyHistory.memberId, m)));
    const keyLogRecorded = await rowCount(tx.update(locationKeyHistory).set({ recordedByName: ERASED_NAME, recordedBy: null }).where(eq(locationKeyHistory.recordedBy, m)));
    return {
      deleted,
      anonymized: keyLog + keyLogRecorded,
      kept: 0,
      purge,
    };
  },
};

/**
 * General assembly (Wave 11): invitations, attendance, proxies, the voting roll, ballots and elections. The club has to keep
 * the records (attendance and voting rights belong to the minutes, voter rolls and votes to the result of a ballot), so the
 * reference to the person is removed and the counts stay: no hard cascade. Secret votes carry no reference at all.
 */
const assemblyData: PrivacyContributor = {
  key: "assembly_data",
  tables: [
    "meeting_invitees",
    "meeting_attendance",
    "meeting_proxies",
    "meeting_voting_roll",
    "meeting_invitation_deliveries",
    "ballot_voters",
    "ballot_votes_open",
    "ballot_options",
    // Minutes and secret votes carry no reference to a club member (accounts only as creator/confirmer, set null on erasure).
    "ballot_votes_secret",
    "meeting_minutes",
    "meeting_minutes_amendments",
    "meeting_minutes_confirmations",
    "elections",
    "election_candidates",
    "club_role_terms",
  ],
  async exportSubject(ex, s) {
    const c = s.clubMemberId;
    const invitees = await ex.select({ meetingId: meetingInvitees.meetingId, response: meetingInvitees.response }).from(meetingInvitees).where(eq(meetingInvitees.clubMemberId, c));
    const attendance = await ex
      .select({ meetingId: meetingAttendance.meetingId, present: meetingAttendance.present, hasVotingRight: meetingAttendance.hasVotingRight, checkedInAt: meetingAttendance.checkedInAt, leftAt: meetingAttendance.leftAt })
      .from(meetingAttendance)
      .where(eq(meetingAttendance.clubMemberId, c));
    const proxies = await ex
      .select({ meetingId: meetingProxies.meetingId, grantor: eq(meetingProxies.grantorClubMemberId, c), createdAt: meetingProxies.createdAt })
      .from(meetingProxies)
      .where(or(eq(meetingProxies.grantorClubMemberId, c), eq(meetingProxies.holderClubMemberId, c)));
    const roll = await ex.select({ meetingId: meetingVotingRoll.meetingId, eligible: meetingVotingRoll.eligible, basis: meetingVotingRoll.basis }).from(meetingVotingRoll).where(eq(meetingVotingRoll.clubMemberId, c));
    const deliveries = await ex
      .select({ invitationId: meetingInvitationDeliveries.invitationId, channel: meetingInvitationDeliveries.channel, status: meetingInvitationDeliveries.status, statusAt: meetingInvitationDeliveries.statusAt })
      .from(meetingInvitationDeliveries)
      .where(eq(meetingInvitationDeliveries.clubMemberId, c));
    // Only whether the person took part, never how they voted in a secret ballot (and that is not stored anyway).
    const voted = await ex.select({ ballotId: ballotVoters.ballotId, eligible: ballotVoters.eligible, hasVoted: ballotVoters.hasVoted }).from(ballotVoters).where(eq(ballotVoters.clubMemberId, c));
    const openVotes = await ex.select({ ballotId: ballotVotesOpen.ballotId, createdAt: ballotVotesOpen.createdAt }).from(ballotVotesOpen).where(eq(ballotVotesOpen.clubMemberId, c));
    const candidacies = await ex.select({ electionId: electionCandidates.electionId, status: electionCandidates.status }).from(electionCandidates).where(eq(electionCandidates.clubMemberId, c));
    const terms = await ex.select({ roleType: clubRoleTerms.roleType, startsOn: clubRoleTerms.startsOn, endsOn: clubRoleTerms.endsOn }).from(clubRoleTerms).where(eq(clubRoleTerms.clubMemberId, c));
    return {
      assembly: {
        meetingInvitations: invitees,
        meetingAttendance: attendance.map((a) => ({ ...a, checkedInAt: iso(a.checkedInAt), leftAt: iso(a.leftAt) })),
        proxies: proxies.map((p) => ({ meetingId: p.meetingId, role: p.grantor ? "grantor" : "holder", createdAt: p.createdAt.toISOString() })),
        votingRoll: roll,
        invitationDeliveries: deliveries.map((d) => ({ ...d, statusAt: d.statusAt.toISOString() })),
        ballotParticipation: voted,
        openVotes: openVotes.map((v) => ({ ballotId: v.ballotId, createdAt: v.createdAt.toISOString() })),
        candidacies,
        terms,
      },
    };
  },
  async eraseSubject(tx, s) {
    const c = s.clubMemberId;
    const deleted = await rowCount(tx.delete(meetingInvitees).where(eq(meetingInvitees.clubMemberId, c)));
    // A candidate's name is part of the option label; the label of an erased person reads as the erased name.
    const labels = await rowCount(tx.update(ballotOptions).set({ label: ERASED_NAME, candidateClubMemberId: null }).where(eq(ballotOptions.candidateClubMemberId, c)));
    let anonymized = labels;
    for (const t of [
      tx.update(meetingAttendance).set({ clubMemberId: null }).where(eq(meetingAttendance.clubMemberId, c)),
      tx.update(meetingProxies).set({ grantorClubMemberId: null }).where(eq(meetingProxies.grantorClubMemberId, c)),
      tx.update(meetingProxies).set({ holderClubMemberId: null }).where(eq(meetingProxies.holderClubMemberId, c)),
      tx.update(meetingVotingRoll).set({ clubMemberId: null }).where(eq(meetingVotingRoll.clubMemberId, c)),
      tx.update(meetingInvitationDeliveries).set({ clubMemberId: null }).where(eq(meetingInvitationDeliveries.clubMemberId, c)),
      tx.update(ballotVoters).set({ clubMemberId: null }).where(eq(ballotVoters.clubMemberId, c)),
      tx.update(ballotVoters).set({ castByClubMemberId: null }).where(eq(ballotVoters.castByClubMemberId, c)),
      tx.update(ballotVotesOpen).set({ clubMemberId: null }).where(eq(ballotVotesOpen.clubMemberId, c)),
      tx.update(electionCandidates).set({ clubMemberId: null }).where(eq(electionCandidates.clubMemberId, c)),
      tx.update(electionCandidates).set({ proposedBy: null }).where(eq(electionCandidates.proposedBy, c)),
      tx.update(elections).set({ electionLeadClubMemberId: null }).where(eq(elections.electionLeadClubMemberId, c)),
      tx.update(clubRoleTerms).set({ clubMemberId: null }).where(eq(clubRoleTerms.clubMemberId, c)),
    ]) {
      anonymized += await rowCount(t);
    }
    return {
      deleted,
      anonymized,
      kept: anonymized,
      keptReason: "Attendance, voting roll, proxies, ballots and elections stay as records of the assembly; the reference to the person is removed, counts and results are unchanged",
    };
  },
};

/** Files registered for the person (listed in the export; removal happens through the contributors above). */
export async function listFilesOf(ex: DbExecutor, s: PrivacySubject): Promise<Array<{ kind: string; filename: string; mimeType: string; sizeBytes: number; uploadedAt: string }>> {
  const [row] = await ex.select({ photoKey: clubMembers.photoKey }).from(clubMembers).where(and(eq(clubMembers.id, s.clubMemberId), eq(clubMembers.clubId, s.clubId)));
  const subs = await ex.select({ id: formSubmissions.id }).from(formSubmissions).where(and(eq(formSubmissions.clubId, s.clubId), eq(formSubmissions.subjectClubMemberId, s.clubMemberId)));
  const rows = await ex
    .select({ kind: mediaFiles.kind, filename: mediaFiles.originalFilename, mimeType: mediaFiles.mimeType, sizeBytes: mediaFiles.sizeBytes, createdAt: mediaFiles.createdAt })
    .from(mediaFiles)
    .where(
      and(
        eq(mediaFiles.clubId, s.clubId),
        isNull(mediaFiles.deletedAt),
        or(row?.photoKey ? eq(mediaFiles.storageKey, row.photoKey) : undefined, subs.length > 0 ? and(eq(mediaFiles.ownerType, "form_submission"), inArray(mediaFiles.ownerId, subs.map((x) => x.id))) : undefined),
      ),
    );
  return rows.map((r) => ({ kind: r.kind, filename: r.filename, mimeType: r.mimeType, sizeBytes: r.sizeBytes, uploadedAt: r.createdAt.toISOString() }));
}

/** Registration order = erasure order: form data first (lock order submission -> member row), master data last of the member rows. */
export const BUILT_IN_CONTRIBUTORS: PrivacyContributor[] = [formsAndApplications, exitRequests, absences, guardianship, consents, communication, accountData, assemblyData, eventParticipation, memberCore];
