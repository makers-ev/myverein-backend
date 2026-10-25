import { AsyncLocalStorage } from "node:async_hooks";

import { db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { logger } from "./logger.js";

/**
 * The ONE way to write the audit trail (Wave 10 B2). Every event type is registered below with the payload keys it may
 * carry; everything else is dropped, so a new field can never leak into the log by accident (no free text, no passwords,
 * no master data values -- ids, field names and counts only). `eventType` is typed from this registry, so an unregistered
 * type does not compile. A direct `insert(auditLog)` is forbidden by ESLint (`no-restricted-syntax`).
 *
 * `member` names where the club member the event is about comes from: "subject" = `subjectId` is the `club_members.id`,
 * otherwise the payload key that holds it. It fills `audit_log.subject_member_id` for the member-centric view.
 */
interface AuditEventSpec {
  keys: readonly string[];
  member?: string;
}

const spec = <const K extends readonly string[]>(keys: K, member?: string): { keys: K; member?: string } => ({ keys, member });

export const AUDIT_EVENTS = {
  "absence.create": spec(["absenceId", "clubId", "clubMemberId", "reportedByKind"], "clubMemberId"),
  "absence.update": spec(["absenceId", "changedFields", "clubId", "clubMemberId"], "clubMemberId"),
  "absence.withdraw": spec(["absenceId", "clubId", "clubMemberId"], "clubMemberId"),
  "admin.job_retry": spec(["actor", "type"]),
  "admin.user_remove": spec(["userId"]),
  "audit_log.export": spec(["clubId", "filters", "rows"]),
  "ballot.cancel": spec(["clubId", "previousStatus", "reason"]),
  "ballot.close": spec(["by", "clubId", "eligible", "participants"]),
  "ballot.count": spec(["clubId", "outcome"]),
  "ballot.create": spec(["anonymous", "clubId", "kind", "meetingId", "mode"]),
  "ballot.finalize": spec(["clubId", "outcome", "resultHash"]),
  "ballot.open": spec(["anonymous", "clubId", "eligible", "mode", "quorum"]),
  "ballot.update": spec(["changedFields", "clubId"]),
  "calendar.create": spec(["calendarId", "clubId"]),
  "calendar.default_create": spec(["calendarId", "clubId", "promoted", "source"]),
  "calendar.delete": spec(["clubId"]),
  "calendar.update": spec(["changedFields", "clubId"]),
  "calendar_feed.create": spec(["calendarId", "clubId", "feedId", "rotated"]),
  "calendar_feed.revoke": spec(["clubId", "feedId", "rotated"]),
  "calendar_visibility.create": spec(["clubId", "departmentId", "memberId", "roleType"]),
  "calendar_visibility.delete": spec(["clubId", "visibilityId"]),
  "club_announcement.cancel": spec(["actor", "clubId"]),
  "club_announcement.delete": spec(["actor", "clubId", "status"]),
  "club_announcement.deliveries_read": spec(["actor", "clubId", "page"]),
  "club_announcement.limit_exceeded": spec(["actor", "clubId", "limit", "mode", "recipients", "rule", "windowMinutes"]),
  "club_announcement.resend_failed": spec(["actor", "clubId", "requeued"]),
  "club_announcement.schedule": spec(["actor", "clubId", "publishAt"]),
  "club_announcement.send": spec(["actor", "alreadyDelivered", "channels", "clubId", "inApp", "queuedEmail", "queuedPush", "recipients", "scheduled", "sentEmail", "skippedNoAddress", "skippedOptout", "urgent"]),
  "club_announcement.send_denied": spec(["clubId", "reason"]),
  "club_announcement.withdraw": spec(["actor", "clubId"]),
  "club_application.approve": spec(["clubId", "clubMemberId", "consent", "decidedBy", "formSubmissionId", "formVersionId", "guardianCreated", "guardianLinked", "guardianMemberId", "mapped", "memberId", "memberNumber", "onBehalfOf", "promotedGuest", "readmission", "userId"], "clubMemberId"),
  "club_application.reject": spec(["clubId", "decidedBy", "formSubmissionId", "hasApplicantMessage", "hasNote", "userId"]),
  "club_application.sensitive_read": spec(["clubId", "fieldKeys", "formSubmissionId", "readBy"]),
  "club_exit_request.approve": spec(["clubId", "clubMemberId", "decidedBy", "effectiveOn", "kind", "transitionKind"], "clubMemberId"),
  "club_exit_request.create": spec(["clubId", "clubMemberId", "decidedBy", "desiredEffectiveOn", "effectiveOn", "formSubmissionId", "formVersionId", "kind", "requestedBy", "status"], "clubMemberId"),
  "club_exit_request.reject": spec(["clubId", "clubMemberId", "decidedBy", "kind"], "clubMemberId"),
  "club_exit_request.sensitive_read": spec(["clubId", "fieldKeys", "formSubmissionId", "readBy"]),
  "club_exit_request.withdraw": spec(["clubId", "clubMemberId", "kind", "previousStatus", "withdrawnBy"], "clubMemberId"),
  "club_info_page.create": spec(["clubId", "slug"]),
  "club_info_page.delete": spec(["clubId", "slug"]),
  "club_info_page.update": spec(["clubId", "slug"]),
  "club_member.age_transition": spec(["automatic", "changedBy", "clubId", "count", "memberIds"]),
  "club_member.apply": spec(["category", "clubId", "formSubmissionId", "formVersionId", "legacy", "onBehalfOf", "userId"]),
  "club_member.create": spec(["categoryId", "clubId", "createdBy", "memberNumber", "status"], "subject"),
  "club_member.department_assign": spec(["clubId", "departmentId"], "subject"),
  "club_member.department_remove": spec(["clubId", "departmentId", "until"], "subject"),
  "club_member.export": spec(["clubId", "columns", "customFieldIds", "exportedBy", "filters", "rows", "sensitiveCustomFieldIds"]),
  "club_member.import": spec(["clubId", "created", "fileSha256", "importedBy", "rows", "skippedDuplicates", "tokenId"]),
  "club_member.invite": spec(["clubId", "createdBy", "expiresAt", "inviteId"], "subject"),
  "club_member.invite_accept": spec(["clubId", "inviteId", "memberId", "merged", "userId"], "subject"),
  "club_member.invite_resend": spec(["clubId", "inviteId", "previousInviteId", "resentBy"], "subject"),
  "club_member.invite_revoke": spec(["clubId", "revokedBy"], "subject"),
  "club_member.majority": spec(["clubId", "links", "majority"], "subject"),
  "club_member.privacy_notice_sent": spec(["clubId", "version"], "subject"),
  "club_member.merge": spec(["clubId", "inviteId", "keptClubMemberId", "memberId", "ownNumberDiscarded", "retiredClubMemberId", "userId"], "subject"),
  "club_member.photo_remove": spec(["changedBy", "clubId"], "subject"),
  "club_member.photo_set": spec(["changedBy", "clubId", "replaced"], "subject"),
  "club_member.sensitive_read": spec(["clubId", "count", "fields", "scope"], "subject"),
  "club_member.transition": spec(["changedBy", "clubId", "effectiveOn", "fromCategoryId", "fromStatus", "kind", "toCategoryId", "toStatus"], "subject"),
  "club_member.unlink": spec(["accountMemberId", "changedBy", "clubId", "departmentsLed", "eventRsvps", "forced", "guardianLinks", "keys", "meetingInvites", "openLoans", "roles", "userId"], "subject"),
  "club_member.update": spec(["changedBy", "changedFields", "clubId"], "subject"),
  "club_member.update_self": spec(["changedFields", "clubId"], "subject"),
  "club_registration.approve": spec(["claimedRole", "clubId", "clubMemberId", "decidedBy", "memberId", "memberNumber", "slug", "userId"], "clubMemberId"),
  "club_registration.create": spec(["clubName", "userId"]),
  "club_registration.document_access": spec(["accessedBy", "documentId", "kind"]),
  "club_registration.document_add": spec(["documentId", "kind", "userId"]),
  "club_registration.document_remove": spec(["documentId", "kind", "userId"]),
  "club_registration.reject": spec(["decidedBy", "note", "userId"]),
  "club_registration.request_info": spec(["decidedBy", "note", "userId"]),
  "club_registration.submit": spec(["from", "slugSuggestion", "userId"]),
  "club_role.assign": spec(["clubId", "clubMemberId", "departmentId", "roleType"], "clubMemberId"),
  "club_role.revoke": spec(["clubId", "clubMemberId", "roleId", "roleType"], "clubMemberId"),
  "club_settings.assembly_update": spec(["changedBy", "changedFields", "clubId"]),
  "club_settings.update": spec(["changedBy", "changedFields", "clubId"]),
  "consent.grant": spec(["clubId", "clubMemberId", "givenBy", "purposeId", "textVersionId", "via"], "clubMemberId"),
  "consent.revoke": spec(["clubId", "clubMemberId", "givenBy", "purposeId", "textVersionId", "via"], "clubMemberId"),
  "consent_purpose.create": spec(["clubId", "key"]),
  "consent_purpose.update": spec(["changedFields", "clubId"]),
  "consent_text.publish": spec(["clubId", "purposeId", "sha256", "version"]),
  "data_subject_request.create": spec(["clubId", "clubMemberId", "kind"], "clubMemberId"),
  "data_subject_request.update": spec(["changedFields", "clubId", "clubMemberId", "kind", "status"], "clubMemberId"),
  "department.create": spec(["clubId", "name"]),
  "department.delete": spec(["clubId"]),
  "department.update": spec(["changedFields", "clubId"]),
  "dpa.accept": spec(["clubId", "dpaVersionId", "version"]),
  "dpa_version.create": spec(["version"]),
  "dpa_version.delete": spec(["version"]),
  "dpa_version.publish": spec(["requiredFrom", "sha256", "version"]),
  "dpa_version.update": spec(["changedFields", "version"]),
  "election.accept": spec(["clubId", "clubMemberId", "onBehalf", "pendingAccount"], "clubMemberId"),
  "election.candidate": spec(["action", "clubId", "clubMemberId", "status"], "clubMemberId"),
  "election.create": spec(["clubId", "roleType", "seats"]),
  "election.decide": spec(["clubId", "electedCount", "lot", "round"]),
  "election.role_end": spec(["clubId", "clubMemberId", "electionId", "roleType"], "clubMemberId"),
  "election.role_grant": spec(["clubId", "clubMemberId", "electionId", "roleType", "termEndsAt"], "clubMemberId"),
  "election.update": spec(["changedFields", "clubId"]),
  "event.cancel": spec(["clubId", "hasReason", "notify"]),
  "event.create": spec(["calendarId", "clubId"]),
  "event.delete": spec(["clubId", "notify"]),
  "event.notify_suppressed": spec(["actor", "cancelled", "clubId"]),
  "event.update": spec(["changedFields", "clubId", "notify"]),
  "event_series.create": spec(["calendarId", "clubId", "occurrences"]),
  "event_series.extend": spec(["clubId", "created"]),
  "event_series.delete": spec(["cancelled", "clubId", "deleted", "scope", "seriesDeleted"]),
  "event_series.update": spec(["cancelled", "changedFields", "clubId", "created", "removed", "scope", "split", "updated"]),
  "event_attendee.cancel": spec(["clubId", "memberId"]),
  "event_attendee.promote": spec(["clubId", "memberId"]),
  "event_attendee.rsvp": spec(["clubId", "memberId", "status"]),
  "form.archive": spec(["archivedBy", "clubId", "purpose"]),
  "form.create": spec(["clubId", "createdBy", "purpose"]),
  "form.draft_discard": spec(["clubId", "discardedBy", "version"]),
  "form.draft_save": spec(["clubId", "fieldCount", "savedBy", "version"]),
  "form.publish": spec(["clubId", "previousVersion", "publishedBy", "purpose", "version"]),
  "form_submission.answers_erased": spec(["clubId", "reason"]),
  "form_submission.create": spec(["clubId", "formId", "formVersionId", "onBehalfOf", "userId"]),
  "form_submission.delete": spec(["clubId", "fileCount", "formId", "formVersionId", "userId"]),
  "form_submission.draft_swept": spec(["clubId", "fileCount", "userId"]),
  "form_submission.erased": spec(["clubId", "clubMemberId", "erasedBy", "fileCount", "reason"], "clubMemberId"),
  "form_submission.file_access": spec(["accessedBy", "fileId", "reason"]),
  "form_submission.file_add": spec(["fieldKey", "fileId", "userId", "via"]),
  "form_submission.file_remove": spec(["fieldKey", "fileId", "userId"]),
  "form_submission.files_expired": spec(["clubId", "fileCount", "reason"]),
  "form_submission.submit": spec(["applicationId", "clubId", "fileCount", "formId", "formVersionId", "onBehalfOf", "userId", "warnings"]),
  "form_submission.withdraw": spec(["clubId", "previousStatus", "userId"]),
  "guardian_link.create": spec(["clubId", "decidedBy", "guardianMemberId", "via"], "subject"),
  "guardian_link.delete": spec(["clubId", "guardianMemberId"], "subject"),
  "guardian_link.update": spec(["changedFields", "clubId", "guardianMemberId"], "subject"),
  "inventory_damage_report.create": spec(["clubId", "itemId", "memberId"]),
  "inventory_damage_report.update": spec(["clubId", "itemId", "status"]),
  "inventory_item.create": spec(["clubId", "name"]),
  "inventory_item.delete": spec(["clubId"]),
  "inventory_item.update": spec(["changedFields", "clubId"]),
  "inventory_loan.create": spec(["clubId", "itemId", "memberId"]),
  "inventory_loan.extend": spec(["clubId", "from", "itemId", "memberId", "to"]),
  "inventory_loan.return": spec(["clubId", "itemId", "memberId"]),
  "location.create": spec(["clubId", "name"]),
  "location.delete": spec(["clubId"]),
  "location.update": spec(["changedFields", "clubId"]),
  "location_key_holder.create": spec(["clubId", "locationId", "memberId"]),
  "location_key_holder.delete": spec(["clubId", "locationId", "memberId"]),
  "location_link.create": spec(["clubId", "locationId", "title"]),
  "location_link.delete": spec(["clubId", "locationId"]),
  "location_link.update": spec(["changedFields", "clubId", "locationId"]),
  "location_wifi.create": spec(["clubId", "label", "locationId"]),
  "location_wifi.delete": spec(["clubId", "locationId"]),
  "location_wifi.update": spec(["clubId", "label", "locationId"]),
  "media.sensitive_access": spec(["accessedBy", "mediaId", "ownerId", "ownerType", "reason"]),
  "member_data.export": spec(["bytes", "clubId", "exportedBy", "format", "via"], "subject"),
  "member_erasure.execute": spec(["anonymized", "clubId", "deleted", "kept", "via"], "subject"),
  "member_erasure.plan": spec(["blockers", "clubId", "requestedBy"], "subject"),
  "member_legal_hold.update": spec(["active", "changedBy", "clubId"], "subject"),
  "member_field_visibility.update": spec(["changedBy", "clubId", "fields"], "subject"),
  "meeting.create": spec(["clubId", "type"]),
  "meeting.delete": spec(["clubId", "notify"]),
  "meeting.notify_suppressed": spec(["actor", "cancelled", "clubId"]),
  "meeting.update": spec(["changedFields", "clubId", "notify"]),
  "meeting_agenda_item.create": spec(["clubId", "meetingId"]),
  "meeting_agenda_item.delete": spec(["clubId", "meetingId"]),
  "meeting_agenda_item.update": spec(["changedFields", "clubId", "meetingId"]),
  "meeting_voting_roll.freeze": spec(["clubId", "eligible", "meetingId", "total"]),
  "meeting_voting_roll.override": spec(["clubId", "clubMemberId", "eligible", "meetingId"], "clubMemberId"),
  "meeting_proxy.grant": spec(["byBoard", "clubId", "grantorClubMemberId", "holderClubMemberId", "meetingId", "proofSource"], "grantorClubMemberId"),
  "meeting_proxy.revoke": spec(["byBoard", "clubId", "grantorClubMemberId", "meetingId"], "grantorClubMemberId"),
  "meeting_attendance.self_online": spec(["clubId", "join", "meetingId"]),
  "meeting_attendance.record": spec(["clubId", "count", "meetingId"]),
  "meeting_invitation.export": spec(["clubId", "invitationId", "meetingId", "rows"]),
  "meeting_invitation.mark_posted": spec(["clubId", "count", "invitationId", "meetingId"]),
  "meeting_invitation.send": spec(["clubId", "kind", "meetingId", "periodException", "recipients", "version"]),
  "meeting_invitee.add": spec(["clubId", "memberId", "notify"]),
  "meeting_invitee.remove": spec(["clubId", "memberId"]),
  "meeting_invitee.respond": spec(["clubId", "memberId", "response"]),
  "meeting_minutes.amend": spec(["clubId", "meetingId", "version"]),
  "meeting_minutes.approve": spec(["approvedInMeetingId", "clubId", "meetingId", "version"]),
  "meeting_minutes.archive": spec(["clubId", "meetingId", "version"]),
  "meeting_minutes.confirm": spec(["clubId", "meetingId", "role", "version"]),
  "meeting_minutes.export": spec(["clubId", "format", "meetingId", "version"]),
  "meeting_minutes.reopen": spec(["clubId", "meetingId", "version"]),
  "meeting_minutes.save": spec(["clubId", "meetingId", "version"]),
  "meeting_minutes.submit": spec(["clubId", "meetingId", "version"]),
  "meeting_resolution.correct": spec(["changedFields", "clubId", "meetingId"]),
  "meeting_resolution.create": spec(["clubId", "meetingId"]),
  "member_category.archive": spec(["changedBy", "clearedAutoTransitions", "clubId", "key", "movedMembers", "movedTo"]),
  "member_category.create": spec(["clubId", "createdBy", "key"]),
  "member_category.update": spec(["changedBy", "changedFields", "clubId"]),
  "member_field.archive": spec(["clubId", "deletedBy", "key"]),
  "member_field.create": spec(["clubId", "createdBy", "key", "sensitive"]),
  "member_field.delete": spec(["clubId", "deletedBy", "key"]),
  "member_field.sensitive_read": spec(["clubId", "clubMemberId", "clubMemberIds", "fieldIds", "readBy", "via"], "clubMemberId"),
  "member_field.unarchive": spec(["clubId", "key", "restoredBy"]),
  "member_field.update": spec(["changed", "clubId", "flags", "key", "updatedBy"]),
  "member_field.write": spec(["changedBy", "clubId", "clubMemberId", "fieldIds", "via"], "clubMemberId"),
  "privacy_notice.publish": spec(["clubId", "sha256", "version"]),
  "profile_module.activate": spec(["by", "clubId", "moduleId", "reactivated", "sensitive"]),
  "profile_module.deactivate": spec(["by", "clubId", "moduleId"]),
  "rate_limit.exceeded": spec(["limit", "rule", "windowSeconds"]),
  "ward_event_response.set": spec(["clubId", "eventId", "status", "wardClubMemberId"], "wardClubMemberId"),
  "retention_policy.reset": spec(["category", "changedBy", "clubId"]),
  "retention_policy.update": spec(["category", "changedBy", "clubId", "retainDays"]),
  "session.create": spec(["ipAddress", "sessionId", "userAgent"]),
} as const satisfies Record<string, AuditEventSpec>;

export type AuditEventType = keyof typeof AUDIT_EVENTS;

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Who is acting in the current request, set by the session/club guards; absent for jobs and the scheduler. */
export const auditContext = new AsyncLocalStorage<{ userId: string; clubId?: string }>();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AuditInput {
  eventType: AuditEventType;
  subjectId?: string | null;
  /** Club of the event. Omitted: `payload.clubId`, then the club of the current request; pass `null` for platform events. */
  clubId?: string | null;
  /** Account that caused the event. Omitted: the account of the current request; pass `null` for system events. */
  actorUserId?: string | null;
  /** `club_members.id` the event is about; normally derived from the event registry. */
  subjectMemberId?: string | null;
  payload?: Record<string, unknown>;
}

/** Keeps only the whitelisted keys of the event type (exported for tests). */
export function whitelistPayload(eventType: AuditEventType, payload: Record<string, unknown> | undefined): Record<string, unknown> {
  const allowed = AUDIT_EVENTS[eventType].keys as readonly string[];
  const out: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(payload ?? {})) {
    if (value === undefined) continue;
    if (allowed.includes(key)) out[key] = value;
    else dropped.push(key);
  }
  if (dropped.length > 0) {
    // Tests must fail on a forgotten key; production keeps running without the key.
    if (process.env.VITEST) throw new Error(`audit event ${eventType}: payload keys not whitelisted: ${dropped.join(", ")}`);
    logger.warn({ eventType, dropped }, "[audit] dropped payload keys that are not whitelisted");
  }
  return out;
}

export async function writeAudit(executor: Executor, input: AuditInput): Promise<void> {
  const entry = AUDIT_EVENTS[input.eventType] as AuditEventSpec;
  const payload = whitelistPayload(input.eventType, input.payload);
  const store = auditContext.getStore();
  const payloadClub = typeof payload.clubId === "string" ? payload.clubId : undefined;
  const clubId = input.clubId !== undefined ? input.clubId : (payloadClub ?? store?.clubId ?? null);
  const actorUserId = input.actorUserId !== undefined ? input.actorUserId : (store?.userId ?? null);
  let subjectMemberId = input.subjectMemberId;
  if (subjectMemberId === undefined) {
    const candidate = entry.member === "subject" ? input.subjectId : entry.member ? payload[entry.member] : null;
    subjectMemberId = typeof candidate === "string" && UUID.test(candidate) ? candidate : null;
  }
  await executor.insert(auditLog).values({ eventType: input.eventType, subjectId: input.subjectId ?? null, clubId, actorUserId, subjectMemberId, payload });
}

/** Event types that record someone LOOKING at data (read access, export, download); everything else is a change. */
export const READ_EVENT_PATTERN = "\\.(sensitive_read|sensitive_access|file_access|document_access|deliveries_read|export)$";

/** "read" = somebody saw data, "change" = somebody changed or decided something (member-centric view: seen / changed). */
export function auditKindOf(eventType: string): "read" | "change" {
  return new RegExp(READ_EVENT_PATTERN).test(eventType) ? "read" : "change";
}
