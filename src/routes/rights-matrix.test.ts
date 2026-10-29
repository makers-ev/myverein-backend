import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { organization, user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { ballotOptions, ballotVotesOpen, ballots } from "../db/schema/assembly.js";
import { clubMembers } from "../db/schema/club-members.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { clubSettings } from "../db/schema/club-settings.js";
import { inventoryItems, inventoryLoans } from "../db/schema/inventory.js";
import { calendars } from "../db/schema/calendars.js";
import { calendarVisibility } from "../db/schema/calendar-visibility.js";
import { events } from "../db/schema/events.js";
import { CLUB_ROLE_TYPES, clubPermissionsFor } from "../lib/club-permissions.js";
import { toAppError } from "../lib/errors.js";
import { adminClubRegistrationRoutes } from "./admin-club-registrations.js";
import { adminClubRoutes } from "./admin-clubs.js";
import { adminUserRoutes } from "./admin-users.js";
import { clubStatsRoutes } from "./club-stats.js";
import { clubOverviewRoutes } from "./club-overview.js";
import { clubExitRequestRoutes } from "./club-exit-requests.js";
import { clubAnnouncementRoutes, clubInboxRoutes } from "./club-announcements.js";
import { notificationPreferenceRoutes, unsubscribeRoutes } from "./notification-preferences.js";
import { absenceRoutes } from "./absences.js";
import { dataSubjectRequestRoutes } from "./data-subject-requests.js";
import { guardianRoutes, myWardsRoutes } from "./guardian.js";
import { consentOverviewRoutes, consentPurposeRoutes } from "./consent-purposes.js";
import { clubSettingsRoutes } from "./club-settings.js";
import { auditLogRoutes } from "./audit-log.js";
import { adminEmailRoutes } from "./admin-emails.js";
import { adminNotificationRoutes } from "./admin-notifications.js";
import { adminNotificationTemplateRoutes } from "./admin-notification-templates.js";
import { adminJobRoutes } from "./admin-jobs.js";
import { adminRetentionRoutes } from "./admin-retention.js";
import { adminDpaAcceptanceRoutes, adminDpaVersionRoutes } from "./admin-dpa.js";
import { dpaRoutes } from "./dpa.js";
import { clubNoticeBySlugRoutes, clubPrivacyNoticeRoutes } from "./club-privacy-notices.js";
import { retentionPolicyRoutes } from "./retention-policies.js";
import { adminStatsRoutes } from "./admin-stats.js";
import { adminStorageRoutes } from "./admin-storage.js";
import { clubStorageRoutes } from "./club-storage.js";
import { acknowledgementRoutes } from "./acknowledgements.js";
import { documentRoutes } from "./documents.js";
import { clubBrandingRoutes } from "./club-branding.js";
import { documentGenerationRoutes } from "./document-generation.js";
import { memberCardVerifyRoutes } from "./member-card-verify.js";
import { memberCardRoutes, memberCardSheetRoutes } from "./member-cards.js";
import { memberDocumentRoutes } from "./member-documents.js";
import { attendanceReportRoutes } from "./attendance-report.js";
import { availabilityRoutes } from "./availability.js";
import { calendarRoutes } from "./calendars.js";
import { clubApplicationRoutes } from "./club-applications.js";
import { clubFormRoutes } from "./club-forms.js";
import { clubInfoRoutes } from "./club-info.js";
import { clubRoleRoutes } from "./club-roles.js";
import { formRoutes } from "./forms.js";
import { formSubmissionRoutes } from "./form-submissions.js";
import { clubMemberRoutes } from "./club-members.js";
import { clubRegistrationRoutes } from "./club-registrations.js";
import { departmentRoutes } from "./departments.js";
import { calendarFeedRoutes, feedRoutes } from "./calendar-feeds.js";
import { eventSeriesRoutes } from "./event-series.js";
import { eventRoutes, icsRoutes } from "./events.js";
import { publicEventRoutes } from "./public-events.js";
import { healthRoutes } from "./health.js";
import { internalStatsRoutes } from "./internal-stats.js";
import { inventoryItemRoutes } from "./inventory-items.js";
import { locationRoutes } from "./locations.js";
import { mediaRoutes } from "./media.js";
import { memberFieldRoutes } from "./member-fields.js";
import { ballotRoutes } from "./ballots.js";
import { electionRoutes } from "./elections.js";
import { meetingRoutes } from "./meetings.js";
import { myClubRoutes } from "./my-clubs.js";
import { notificationRoutes } from "./notifications.js";
import { pushTokenRoutes } from "./push-tokens.js";
import { rateCardRoutes, timeEntryRoutes, timeReportRoutes } from "./time-tracking.js";

/**
 * Rights matrix (Wave 7 B12 part, deny-by-default): EVERY registered writing route (POST/PATCH/PUT/DELETE)
 * is called by an account member who holds ONLY the implicit role `mitglied` -- and once more by an external guest --
 * and must be denied with 403 (404 only where listed in MAY_BE_404; 401 is NOT accepted: a dead session would make
 * the whole matrix pass vacuously, so the sessions are verified first). Self-service routes are listed explicitly in
 * SELF_SERVICE. Handlers registered with `.all()` are not enumerated per method and therefore forbidden (test below).
 * A new route that is neither denied nor on the allowlist fails this test -- add a permission check or,
 * deliberately, an allowlist entry with a reason.
 */

// Mirrors the `app.route(...)` list of src/index.ts; the first test verifies that the two stay in sync.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- routers have different Env types
const MOUNTS: Array<[string, string, Hono<any>]> = [
  ["/", "healthRoutes", healthRoutes],
  ["/internal", "internalStatsRoutes", internalStatsRoutes],
  ["/admin", "adminStatsRoutes", adminStatsRoutes],
  ["/admin", "adminEmailRoutes", adminEmailRoutes],
  ["/admin", "adminStorageRoutes", adminStorageRoutes],
  ["/admin", "adminClubRoutes", adminClubRoutes],
  ["/club-stats", "clubStatsRoutes", clubStatsRoutes],
  ["/consent-purposes", "consentPurposeRoutes", consentPurposeRoutes],
  ["/consents", "consentOverviewRoutes", consentOverviewRoutes],
  ["/absences", "absenceRoutes", absenceRoutes],
  ["/data-subject-requests", "dataSubjectRequestRoutes", dataSubjectRequestRoutes],
  ["/my-wards", "myWardsRoutes", myWardsRoutes],
  ["/guardian", "guardianRoutes", guardianRoutes],
  ["/club-settings", "clubSettingsRoutes", clubSettingsRoutes],
  ["/club-storage", "clubStorageRoutes", clubStorageRoutes],
  ["/club-settings/branding", "clubBrandingRoutes", clubBrandingRoutes],
  ["/audit-log", "auditLogRoutes", auditLogRoutes],
  ["/club-exit-requests", "clubExitRequestRoutes", clubExitRequestRoutes],
  ["/club-announcements", "clubAnnouncementRoutes", clubAnnouncementRoutes],
  ["/club-inbox", "clubInboxRoutes", clubInboxRoutes],
  ["/notification-preferences", "notificationPreferenceRoutes", notificationPreferenceRoutes],
  ["/unsubscribe", "unsubscribeRoutes", unsubscribeRoutes],
  ["/push-tokens", "pushTokenRoutes", pushTokenRoutes],
  ["/notifications", "notificationRoutes", notificationRoutes],
  ["/admin/jobs", "adminJobRoutes", adminJobRoutes],
  ["/admin/retention-runs", "adminRetentionRoutes", adminRetentionRoutes],
  ["/admin/dpa-versions", "adminDpaVersionRoutes", adminDpaVersionRoutes],
  ["/admin/dpa-acceptances", "adminDpaAcceptanceRoutes", adminDpaAcceptanceRoutes],
  ["/dpa", "dpaRoutes", dpaRoutes],
  ["/admin", "adminUserRoutes", adminUserRoutes],
  ["/club-privacy-notices", "clubPrivacyNoticeRoutes", clubPrivacyNoticeRoutes],
  ["/clubs", "clubNoticeBySlugRoutes", clubNoticeBySlugRoutes],
  ["/clubs", "clubOverviewRoutes", clubOverviewRoutes],
  ["/retention-policies", "retentionPolicyRoutes", retentionPolicyRoutes],
  ["/admin/notifications", "adminNotificationRoutes", adminNotificationRoutes],
  ["/admin/notification-templates", "adminNotificationTemplateRoutes", adminNotificationTemplateRoutes],
  ["/admin/club-registrations", "adminClubRegistrationRoutes", adminClubRegistrationRoutes],
  ["/club-registrations", "clubRegistrationRoutes", clubRegistrationRoutes],
  ["/my-clubs", "myClubRoutes", myClubRoutes],
  ["/club-members", "clubMemberRoutes", clubMemberRoutes],
  ["/club-members", "memberCardRoutes", memberCardRoutes],
  ["/member-cards", "memberCardSheetRoutes", memberCardSheetRoutes],
  ["/member-cards", "memberCardVerifyRoutes", memberCardVerifyRoutes],
  ["/club-applications", "clubApplicationRoutes", clubApplicationRoutes],
  ["/forms", "formRoutes", formRoutes],
  ["/member-fields", "memberFieldRoutes", memberFieldRoutes],
  ["/club-forms", "clubFormRoutes", clubFormRoutes],
  ["/form-submissions", "formSubmissionRoutes", formSubmissionRoutes],
  ["/departments", "departmentRoutes", departmentRoutes],
  ["/club-info", "clubInfoRoutes", clubInfoRoutes],
  ["/documents", "documentRoutes", documentRoutes],
  ["/acknowledgements", "acknowledgementRoutes", acknowledgementRoutes],
  ["/document-generation", "documentGenerationRoutes", documentGenerationRoutes],
  ["/member-documents", "memberDocumentRoutes", memberDocumentRoutes],
  ["/club-roles", "clubRoleRoutes", clubRoleRoutes],
  ["/calendars", "calendarRoutes", calendarRoutes],
  ["/calendar-feeds", "calendarFeedRoutes", calendarFeedRoutes],
  ["/feeds", "feedRoutes", feedRoutes],
  ["/event-series", "eventSeriesRoutes", eventSeriesRoutes],
  ["/events", "eventRoutes", eventRoutes],
  ["/attendance", "attendanceReportRoutes", attendanceReportRoutes],
  ["/events.ics", "icsRoutes", icsRoutes],
  ["/public", "publicEventRoutes", publicEventRoutes],
  ["/time-entries", "timeEntryRoutes", timeEntryRoutes],
  ["/rate-cards", "rateCardRoutes", rateCardRoutes],
  ["/time-report", "timeReportRoutes", timeReportRoutes],
  ["/availability", "availabilityRoutes", availabilityRoutes],
  ["/meetings", "meetingRoutes", meetingRoutes],
  ["/ballots", "ballotRoutes", ballotRoutes],
  ["/elections", "electionRoutes", electionRoutes],
  ["/locations", "locationRoutes", locationRoutes],
  ["/inventory-items", "inventoryItemRoutes", inventoryItemRoutes],
  ["/media", "mediaRoutes", mediaRoutes],
];

const app = new Hono();
for (const [path, , router] of MOUNTS) app.route(path, router);
app.onError((err, c) => {
  const appError = toAppError(err);
  return c.json(appError.toJSON(), appError.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503);
});

const WRITE_METHODS = ["POST", "PATCH", "PUT", "DELETE"];

/** Self-service routes a plain `mitglied` may use. Not asserted as denied; each entry needs a reason. */
const SELF_SERVICE: Record<string, string> = {
  "POST /member-documents/:memberId": "own personal storage (self), a ward's (live guardian link) or - with documents:read_personal - any member's; everybody else gets 404 (resolvePersonalSubject), asserted in member-documents.test.ts",
  "POST /member-documents/:memberId/:docId/versions": "new version of an own upload (same subject rules; the member side only for its own uploads)",
  "DELETE /member-documents/:memberId/:docId": "removing an own upload (member side) or any document with a reason (documents:read_personal); retention blocks; other callers 404",
  "POST /member-documents/:memberId/:docId/hide": "hiding a receipt/generated document from the own list (self / guardian only; board and strangers 404)",
  "POST /member-documents/:memberId/:docId/unhide": "undoing the hide (same rules)",
  "POST /acknowledgements/:id/confirm": "the person asked (an adult) or a guardian with a live link answers the own request; strangers and managers who are not the person get 404, a minor with an account 403 guardian_required, asserted in acknowledgements.test.ts",
  "PATCH /club-members/me": "own profile",
  "POST /club-members/apply": "join request (the caller is not yet a member)",
  "POST /club-registrations": "found a club (user-level, own application)",
  "PATCH /club-registrations/:id": "own founding application (ownership checked)",
  "POST /club-registrations/:id/documents": "own founding application (ownership checked)",
  "DELETE /club-registrations/:id/documents/:docId": "own founding application (ownership checked)",
  "POST /club-registrations/:id/submit": "own founding application (ownership checked)",
  "POST /notifications/:id/read": "own notifications",
  "POST /notifications/:id/unread": "own notifications",
  "DELETE /notifications/:id": "own notifications",
  "POST /events/:id/rsvp": "own RSVP",
  "DELETE /events/:id/rsvp": "own RSVP",
  "POST /public/events/:token/registrations": "public guest registration: no session, the secret event link is the credential (unknown tokens are 404, rate limited per IP / token / address, honeypot)",
  "POST /public/registrations/confirm": "public double opt-in: no session, the confirmation code from the mail is the credential (unknown codes are 404)",
  "PATCH /public/registrations/:guestToken": "public: a guest changes the own registration with the management link (hash lookup; unknown tokens are 404)",
  "DELETE /public/registrations/:guestToken": "public: a guest cancels the own registration with the management link (unknown tokens are 404)",
  "POST /events/:id/helpers/shifts/:shiftId/signup": "helper sign-up: the target is the caller, a ward with a live guardian link, or - with helpers:write inside the event scope - any member; minors are never entered by themselves (403); foreign events and shifts are 404",
  "DELETE /events/:id/helpers/shifts/:shiftId/signup": "helper withdrawal: same target rules as the sign-up (only that person's own row is removed)",
  "POST /events/:id/helpers/shifts/:shiftId/swaps": "hand over the own shift (the signup of the resolved target only; 404 without own sign-up)",
  "POST /events/:id/helpers/swaps/:swapId/accept": "take over a shift as the resolved target (named person or anybody for an open request); one winner under lock",
  "POST /events/:id/helpers/swaps/:swapId/decline": "the named person declines (only the addressee, others 409)",
  "DELETE /events/:id/helpers/swaps/:swapId": "withdraw the own swap request (the owner of the signup, a guardian or an organiser)",
  "POST /events/:id/rides": "offer a ride (the driver is the caller or, for an adult ward / as organiser with calendars:write, somebody else; minors never drive; unknown events are 404)",
  "PATCH /events/:id/rides/:rideId": "the driver (or their guardian / an organiser) changes the own ride; everybody else gets 403, unknown rides 404",
  "DELETE /events/:id/rides/:rideId": "the driver (or their guardian / an organiser) cancels the own ride",
  "POST /events/:id/rides/:rideId/requests": "ask for a seat as the caller or a ward (live guardian link); minors only through their guardians",
  "PATCH /events/:id/rides/:rideId/requests/:requestId": "the driver decides about a request (seats counted under a lock on the ride); others 403",
  "DELETE /events/:id/rides/:rideId/requests/:requestId": "the passenger (or guardian) withdraws, or the driver removes a passenger; others 403",
  "POST /calendar-feeds": "own subscription link (bound to the caller's membership; external guests get 403)",
  "DELETE /calendar-feeds/:id": "revoking the own subscription link (foreign ids are 404)",
  "POST /calendar-feeds/:id/rotate": "rotating the own subscription link (foreign ids are 404)",
  "POST /availability/slots": "own availability",
  "PATCH /availability/slots/:id": "own availability (ownership checked)",
  "DELETE /availability/slots/:id": "own availability (ownership checked)",
  "POST /availability/exceptions": "own availability",
  "PATCH /availability/exceptions/:id": "own availability (ownership checked)",
  "DELETE /availability/exceptions/:id": "own availability (ownership checked)",
  "PATCH /meetings/:id/invitees/me": "own accept/decline of an invitation",
  "POST /meetings/:id/proxies": "a member gives their own proxy (a proxy for somebody else needs assembly:manage; the statute rules decide, unknown meetings and members are 404)",
  "DELETE /meetings/:id/proxies/:grantorClubMemberId": "a member withdraws their own proxy (somebody else's needs assembly:manage)",
  "POST /meetings/:id/online/join": "an invited account joins the online part by itself: decided in the route by the invitation, the mode and the check-in window; strangers get 404",
  "POST /meetings/:id/online/leave": "an invited account leaves the online part by itself (only its own self_online check-in)",
  "POST /ballots/:id/vote": "a member votes (own ballot or, as a proxy holder, for the grantor): decided in the route by the voter roll, check-in and the window; unknown ballots are 404, a non-voter 403 not_eligible",
  "PATCH /elections/:id/candidates/:candidateId": "the candidate declares willingness or withdraws (own candidacy only: another member is 403, unknown ids 404)",
  "POST /elections/:id/candidates/:candidateId/accept": "the elected person accepts or declines the office (own candidacy only; the board records it for others with assembly:manage)",
  "POST /inventory-items/:id/loans": "self-service borrowing (switchable via club_settings.allow_self_loans)",
  "PATCH /inventory-items/:id/loans/:loanId": "return of the own loan (borrower or inventory:write); WITHOUT a body only -- an extension ({ dueAt }) needs inventory:write even for the borrower, asserted in the allow_self_loans block",
  "POST /inventory-items/:id/damage-reports": "self-service damage report",
  "POST /media": "image upload for damage reports / location photos (central media layer: magic bytes, EXIF strip, quota; the file stays unattached until a feature route claims it)",
  "PATCH /club-members/me/custom-fields": "own custom field values (only fields with editable_by = self; others answer 403/422)",
  "PUT /club-members/me/photo": "own profile photo (minors are refused: the board sets them)",
  "DELETE /club-members/me/photo": "removing the own profile photo",
  "POST /club-members/invites/preview": "previewing an own invitation (session only; the secret token travels in the body, the response is masked)",
  "POST /club-members/invites/accept": "accepting an own invitation (session only; bound to the secret token and the account e-mail, no club membership needed)",
  "POST /club-exit-requests": "the member's own cancellation (recording a cancellation for others and exclusions need members:write, asserted in the B6 test)",
  "POST /form-submissions": "own application draft, also for a child (onBehalfOf=guardian, B8: verified e-mail, max 5 open child applications; session only; the applicant is not a member yet; refused for members for themself)",
  "PATCH /form-submissions/:id": "own draft (ownership checked, foreign ids are 404)",
  "POST /form-submissions/:id/files": "file upload into the own draft (central media layer; ownership checked)",
  "DELETE /form-submissions/:id/files/:fileId": "removing a file of the own draft (ownership checked)",
  "DELETE /form-submissions/:id": "discarding the own draft (ownership checked, foreign ids are 404; only status draft)",
  "POST /form-submissions/:id/submit": "submitting the own draft (ownership checked)",
  "POST /form-submissions/:id/withdraw": "withdrawing the own application (ownership checked)",
  "PUT /notification-preferences": "own notification preferences (user-level; mandatory classes are refused with 422)",
  "POST /unsubscribe/:token": "public one-click unsubscribe (RFC 8058): no session, authorized by the HMAC-signed token itself; invalid/expired tokens are 404",
  "POST /push-tokens": "own device token (bound to the caller's account; a token of another account is re-assigned, never read)",
  "DELETE /push-tokens/:token": "logout of an own device (only the caller's own token is removed)",
  "POST /club-inbox/:id/read": "own in-app message (bound to user and club; foreign ids are 404)",
  "POST /club-members/:id/consents/:purposeId": "consent of the person itself or of a linked guardian (decided in the route: foreign members are 403, unknown ones 404; the board needs privacy:manage and a paper proof)",
  "DELETE /club-members/:id/consents/:purposeId": "revocation by the person itself or a linked guardian (same rules as the grant)",
  "POST /absences": "own absence report (external guests get 403; the member row is the caller's own)",
  "PATCH /absences/:id": "own absence report (ownership checked, foreign ids are 404)",
  "DELETE /absences/:id": "withdrawing the own absence report (ownership checked)",
  "PUT /club-members/:id/visibility": "the person itself, a guardian with a live link and custody, or members:write; others 403, unknown ids 404",
  "PUT /guardian/wards/:wardId/events/:eventId/response": "guardian answers for a ward (guardianScope: a ward that is not the caller's, foreign club or expired link is 404)",
  "DELETE /guardian/wards/:wardId/events/:eventId/response": "guardian withdraws the answer for a ward (guardianScope, 404 otherwise)",
  "POST /guardian/wards/:wardId/absences": "guardian reports an absence for a ward (guardianScope + can_report_absence)",
  "PATCH /guardian/wards/:wardId/absences/:id": "guardian changes an absence of a ward (guardianScope + can_report_absence)",
  "DELETE /guardian/wards/:wardId/absences/:id": "guardian withdraws an absence of a ward (guardianScope + can_report_absence)",
  "POST /club-members/me/erasure-request": "the member's own erasure request (a request with a deadline for the board; nothing is erased by it)",
  "POST /guardian/wards/:wardId/erasure-request": "guardian files an erasure request for a ward (guardianScope: a ward that is not the caller's is 404)",
  "POST /club-exit-requests/:id/withdraw": "the requester withdraws the own request (the board may too; others get 403/404)",
};

/** Routes that may answer 404 instead of 403 (the resource is resolved/scoped before the permission check). */
const MAY_BE_404: Record<string, string> = {
  "PUT /documents/:id/legal-hold": "same as the document PATCH (needs verwalten on the folder)",
  "PUT /member-documents/:memberId/:docId/legal-hold": "the subject is resolved first (strangers 404); the person themselves and the board without documents:manage get 403",
  "POST /acknowledgements/requests": "the document is resolved first: one the caller cannot manage (schreiben) is 404, no existence leak; asserted in acknowledgements.test.ts",
  "POST /acknowledgements/remind": "same as the request",
  "POST /acknowledgements/:id/paper": "the acknowledgement is resolved first (the person, the guardian or the document manager see it); everybody else 404",
  "POST /document-generation/jobs/:id/retry": "the job is resolved first: a job of somebody else (or another club) is 404 by design; the template right is checked right after",
  "PATCH /documents/folders/:id": "the folder is resolved first: a folder the caller cannot see is 404 by design (no existence leak); a visible one without the right is 403",
  "DELETE /documents/folders/:id": "same as the folder PATCH",
  "PATCH /documents/:id": "documents the caller cannot see are 404 (not 403), asserted in documents.test.ts",
  "DELETE /documents/:id": "same as the document PATCH (trash needs schreiben on the folder)",
  "POST /documents/:id/restore": "same as the document PATCH",
  "POST /documents/:id/versions": "same as the document PATCH (new version needs schreiben on the folder)",
  "DELETE /documents/:id/permanent": "same as the document PATCH (needs verwalten on the folder)",
};

/** Read routes a plain mitglied may use but an external guest must NOT (guests: 403, or 404 where the resource is hidden). */
const GUEST_DENIED_READS: Array<[string, string]> = [
  ["GET", "/meetings"],
  ["GET", `/meetings/${"00000000-0000-4000-8000-000000000001"}`],
  ["GET", `/meetings/${"00000000-0000-4000-8000-000000000001"}/quorum`],
  ["GET", `/meetings/${"00000000-0000-4000-8000-000000000001"}/voting-roll/me`],
  ["GET", `/meetings/${"00000000-0000-4000-8000-000000000001"}/invitations/latest`],
  ["GET", `/meetings/${"00000000-0000-4000-8000-000000000001"}/agenda-items`],
  ["GET", `/meetings/${"00000000-0000-4000-8000-000000000001"}/proxies`],
  ["GET", "/ballots"],
  ["GET", "/elections"],
  ["GET", `/elections/${"00000000-0000-4000-8000-000000000001"}`],
  ["GET", `/ballots/${"00000000-0000-4000-8000-000000000001"}`],
  ["GET", "/club-members"],
  ["GET", "/club-members?status=aktiv"],
  ["GET", "/inventory-items"],
  ["GET", `/inventory-items/${"00000000-0000-4000-8000-000000000001"}`],
  ["GET", `/inventory-items/${"00000000-0000-4000-8000-000000000001"}/loans`],
  ["GET", `/inventory-items/${"00000000-0000-4000-8000-000000000001"}/damage-reports`],
  ["GET", "/departments"],
  ["GET", `/departments/${"00000000-0000-4000-8000-000000000001"}`],
];

/** Routes whose body validation runs before the permission check need a valid sample body. Default `{}`. */
const SOME_ID = "00000000-0000-4000-8000-000000000001";
const SAMPLE_BODIES: Record<string, unknown> = {
  "PUT /documents/:id/legal-hold": { active: true },
  "PUT /member-documents/:memberId/:docId/legal-hold": { active: true },
  "POST /member-cards/verify": { token: "mc1.x" },
  "POST /member-cards/print": { clubMemberIds: [SOME_ID] },
  "POST /acknowledgements/requests": { documentId: SOME_ID, audience: { all: true } },
  "POST /acknowledgements/remind": { documentId: SOME_ID },
  "POST /acknowledgements/:id/paper": { decision: "bestaetigt", proofDate: "2020-01-01", proofSource: "Liste" },
  "POST /club-members": { displayName: "Nobody", categoryKey: "aktiv" },
  "POST /club-members/:id/departments": { departmentId: SOME_ID },
  "POST /meetings/:id/agenda-items": { title: "Begrüßung" },
  "PATCH /meetings/:id/voting-roll/:clubMemberId": { eligible: true, reason: "Beschluss des Vorstands" },
  "POST /meetings/:id/proxies": { holderClubMemberId: SOME_ID },
  "PUT /meetings/:id/minutes": { content: "Protokoll" },
  "POST /meetings/:id/minutes/confirm": { role: "leitung" },
  "POST /meetings/:id/minutes/approve": { resolutionId: SOME_ID },
  "POST /meetings/:id/minutes/amendments": { note: "Berichtigung" },
  "POST /ballots": { title: "Abstimmung" },
  "PATCH /ballots/:id": { title: "Neuer Titel" },
  "POST /elections": { roleType: "kassenwart", seats: 1 },
  "PATCH /elections/:id": { seats: 1 },
  "POST /elections/:id/candidates": { clubMemberId: SOME_ID },
  "POST /club-members/categories": { name: "Neue Kategorie" },
  "POST /club-members/transition-suggestions/apply": { memberIds: [SOME_ID] },
  "POST /club-members/:id/transition": { toStatus: "aktiv" },
  "POST /club-members/:id/invite": { email: "nobody@example.com" },
  "POST /club-exit-requests/:id/reject": { note: "Nein" },
  "POST /club-members/:id/roles": { roleType: "kassenwart" },
  "POST /club-members/:id/guardians": { guardianMemberId: SOME_ID },
  "PATCH /club-members/:id/guardians/:guardianMemberId": { canConsent: true },
  "PUT /club-members/:id/visibility": { phone: "mitglieder" },
  "POST /absences": { kind: "krank", startsOn: "2030-01-01", endsOn: "2030-01-02" },
  "PATCH /absences/:id": { note: "kurz" },
  "PUT /guardian/wards/:wardId/events/:eventId/response": { status: "angemeldet" },
  "POST /guardian/wards/:wardId/absences": { kind: "krank", startsOn: "2030-01-01", endsOn: "2030-01-02" },
  "PATCH /guardian/wards/:wardId/absences/:id": { note: "kurz" },
  "POST /club-members/:id/consents/:purposeId": { textVersionId: SOME_ID },
  "POST /consent-purposes": { name: "Neuer Zweck" },
  "PATCH /consent-purposes/:id": { requested: true },
  "POST /consent-purposes/:id/texts": { body: "Ein Einwilligungstext von ausreichender Länge." },
  "POST /club-members/:id/data-export": { identityChecked: true },
  "POST /club-members/:id/erasure/execute": { planDigest: "a".repeat(64), confirm: true },
  "PUT /club-members/:id/legal-hold": { active: false },
  "POST /data-subject-requests": { clubMemberId: SOME_ID, kind: "access" },
  "PATCH /data-subject-requests/:id": { status: "in_progress" },
  "PUT /retention-policies/:category": { retainDays: 100 },
  "POST /dpa/accept": { dpaVersionId: SOME_ID, signerName: "Max Mustermann", authorized: true },
  "POST /departments": { name: "Abteilung" },
  "PUT /club-info/:slug": { title: "Titel" },
  "POST /documents/folders": { name: "Ordner" },
  "POST /document-generation": { templateId: "branding-test" },
  "PATCH /documents/folders/:id": { name: "Neu" },
  "PUT /documents/folders/:id/permissions": { entries: [] },
  "PATCH /documents/:id": { title: "Neu" },
  "POST /calendars": { name: "Kalender" },
  "POST /calendars/:id/visibility": { roleType: "trainer" },
  "POST /events": { calendarId: SOME_ID, title: "Termin", startsAt: "2030-01-01T10:00:00Z" },
  "POST /event-series": { calendarId: SOME_ID, title: "Training", startDate: "2030-01-07", startTime: "18:00", freq: "weekly" },
  "POST /event-series/preview": { title: "Training", startDate: "2030-01-07", startTime: "18:00", freq: "weekly" },
  "PATCH /event-series/:id": { scope: "all", title: "Neu" },
  "POST /meetings": { type: "sonstige", title: "Treffen" },
  "POST /meetings/:id/invitees": { memberId: SOME_ID },
  "PATCH /meetings/:id/attendance": [{ memberId: SOME_ID, present: true }],
  "POST /meetings/:id/resolutions": { description: "Beschluss", votesFor: 1, votesAgainst: 0, votesAbstain: 0, result: "angenommen" },
  "PATCH /meetings/:id/resolutions/:rid": { result: "angenommen", correctionNote: "Korrektur" },
  "POST /locations": { name: "Ort" },
  "POST /locations/:id/key-holders": { memberId: SOME_ID },
  "POST /locations/:id/wifi": { label: "WLAN", ssid: "ssid", password: "pw" },
  "POST /locations/:id/links": { title: "Link", url: "https://example.com" },
  "POST /inventory-items": { name: "Zelt", condition: "gut" },
  "PATCH /inventory-items/:id/damage-reports/:reportId": { status: "behoben" },
};

function fillParams(path: string) {
  return path.replace(/:(\w+)(\{[^}]*\})?/g, (_m, name: string) => (name === "slug" ? "about" : randomUUID()));
}

describe("rights matrix (deny-by-default for the implicit role mitglied)", () => {
  const suffix = Date.now();
  let clubId: string;
  let founderId: string;
  let plainId: string;
  let guestId: string;
  let adminMemberId: string;
  let plainMemberId: string;
  let guestMemberId: string;
  let itemId: string;
  let cookieFounder: string;
  let cookiePlain: string;
  let cookieGuest: string;

  const req = (path: string, cookie: string, init: { method?: string; body?: unknown } = {}) =>
    app.request(`${path}${path.includes("?") ? "&" : "?"}clubId=${clubId}`, {
      method: init.method ?? "GET",
      headers: { cookie, "x-forwarded-for": randomUUID(), "content-type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });

  async function signUp(label: string) {
    const email = `matrix-${label}-${suffix}@example.com`;
    const { user: created } = await auth.api.createUser({ body: { email, password: "test-password-123!", name: `Matrix ${label}` } });
    await db.update(user).set({ emailVerified: true }).where(eq(user.id, created.id));
    const signIn = await auth.api.signInEmail({ body: { email, password: "test-password-123!" }, asResponse: true });
    return { userId: created.id, cookie: (signIn.headers.get("set-cookie") ?? "").split(";")[0] };
  }

  beforeAll(async () => {
    const founder = await signUp("founder");
    const plain = await signUp("plain");
    const guest = await signUp("guest");
    founderId = founder.userId;
    plainId = plain.userId;
    guestId = guest.userId;
    cookieFounder = founder.cookie;
    cookiePlain = plain.cookie;
    cookieGuest = guest.cookie;

    const club = await auth.api.createOrganization({ body: { name: `Matrix Club ${suffix}`, slug: `matrix-club-${suffix}`, userId: founderId } });
    clubId = club!.id;
    await auth.api.addMember({ body: { userId: plainId, organizationId: clubId, role: "member" } });
    await auth.api.addMember({ body: { userId: guestId, organizationId: clubId, role: "guest" } });

    const find = (userId: string) => db.query.member.findFirst({ where: (m, { and, eq }) => and(eq(m.organizationId, clubId), eq(m.userId, userId)) });
    adminMemberId = (await find(founderId))!.id;
    plainMemberId = (await find(plainId))!.id;
    guestMemberId = (await find(guestId))!.id;
    await db.insert(clubRoles).values({ memberId: adminMemberId, roleType: "vorsitz" });

    const [item] = await db.insert(inventoryItems).values({ clubId, name: "Matrix Zelt", condition: "gut" }).returning();
    itemId = item.id;
  }, 30_000);

  afterAll(async () => {
    await db.delete(organization).where(eq(organization.id, clubId));
    for (const id of [founderId, plainId, guestId]) await db.delete(user).where(eq(user.id, id));
    await closeDatabase();
  });

  it("covers every router mounted in src/index.ts (the matrix cannot silently miss a router)", () => {
    const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    const mounted = [...source.matchAll(/app\.route\("([^"]+)",\s*(\w+)\)/g)].map((m) => `${m[1]} ${m[2]}`).sort();
    expect(MOUNTS.map(([path, name]) => `${path} ${name}`).sort()).toEqual(mounted);
  });

  it("only lists existing routes in the allowlists (no stale entries)", () => {
    const registered = new Set(app.routes.map((r) => `${r.method} ${r.path}`));
    for (const key of [...Object.keys(SELF_SERVICE), ...Object.keys(MAY_BE_404), ...Object.keys(SAMPLE_BODIES)]) {
      expect(registered.has(key), `stale entry: ${key}`).toBe(true);
    }
  });

  it("has valid sessions for every test account (otherwise a 401 wall would make the matrix vacuous)", async () => {
    for (const [label, cookie] of [["founder", cookieFounder], ["plain", cookiePlain], ["guest", cookieGuest]] as const) {
      const res = await req("/club-members/me", cookie);
      expect(res.status, label).toBe(200);
    }
  });

  it("has no .all() handlers (they would escape the per-method matrix); only middleware may use ALL", () => {
    const catchAll = app.routes.filter((r) => r.method === "ALL" && !/\*$/.test(r.path));
    expect(catchAll.map((r) => r.path)).toEqual([]);
  });

  async function denialProblems(cookie: string): Promise<{ problems: string[]; checked: number }> {
    const writes = [...new Set(app.routes.filter((r) => WRITE_METHODS.includes(r.method)).map((r) => `${r.method} ${r.path}`))];
    expect(writes.length).toBeGreaterThan(50);

    const problems: string[] = [];
    let checked = 0;
    for (const key of writes) {
      if (key in SELF_SERVICE) continue;
      const [method, path] = key.split(" ");
      const res = await req(fillParams(path), cookie, { method, body: SAMPLE_BODIES[key] ?? {} });
      checked += 1;
      // adminGuard (src/middleware/session-guard.ts) answers an authenticated NON-admin with 401 "Admin privileges
      // required" (legacy contract of the admin dashboard); the sessions were verified above, so 401 cannot be a dead session.
      const allowed = key in MAY_BE_404 ? [403, 404] : path.startsWith("/admin") ? [401, 403] : [403];
      if (!allowed.includes(res.status)) {
        problems.push(`${key} -> ${res.status}${res.status === 422 ? " (validation ran first: add a valid body to SAMPLE_BODIES)" : ""}`);
      }
    }
    return { problems, checked };
  }

  it("denies every non-self-service writing route to a plain mitglied (403 only)", async () => {
    const { problems, checked } = await denialProblems(cookiePlain);
    expect(checked).toBeGreaterThan(40);
    expect(problems, problems.join("\n")).toEqual([]);
  }, 120_000);

  it("denies every non-self-service writing route to an external guest too (403 only)", async () => {
    const { problems, checked } = await denialProblems(cookieGuest);
    expect(checked).toBeGreaterThan(40);
    expect(problems, problems.join("\n")).toEqual([]);
  }, 120_000);

  it("keeps the sensitive reads (meetings, member list) closed for an external guest", async () => {
    for (const [method, path] of GUEST_DENIED_READS) {
      const res = await req(path, cookieGuest, { method });
      expect([403, 404], `${method} ${path} -> ${res.status}`).toContain(res.status);
    }
    // ... while a plain member reads them, and the guest still reaches the own profile.
    expect((await req("/meetings", cookiePlain)).status).toBe(200);
    expect((await req("/club-members", cookiePlain)).status).toBe(200);
    expect((await req("/club-members/me", cookieGuest)).status).toBe(200);
  });

  it("answers an external guest 404 on the assembly self-service routes, and a member who is not on the voter roll 403 on a vote (review)", async () => {
    const some = randomUUID();
    for (const [method, path, body] of [
      ["POST", `/meetings/${some}/proxies`, { holderClubMemberId: some }],
      ["POST", `/meetings/${some}/online/join`, undefined],
      ["POST", `/meetings/${some}/online/leave`, undefined],
      ["PATCH", `/meetings/${some}/invitees/me`, { response: "zugesagt" }],
      ["POST", `/ballots/${some}/vote`, { optionIds: [some] }],
    ] as const) {
      const res = await req(path, cookieGuest, { method, body });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    // A running ballot whose voter roll does not contain the caller: 403 not_eligible, nothing is counted.
    const [ballot] = await db.insert(ballots).values({ clubId, title: "Matrix", status: "open", mode: "circular", kind: "resolution", audience: "board", topic: "allgemein", maxChoices: 1, opensAt: new Date(Date.now() - 60_000), closesAt: new Date(Date.now() + 3_600_000), createdBy: founderId }).returning({ id: ballots.id });
    const [option] = await db.insert(ballotOptions).values({ ballotId: ballot!.id, position: 1, label: "Ja", kind: "yes" }).returning({ id: ballotOptions.id });
    const vote = await req(`/ballots/${ballot!.id}/vote`, cookiePlain, { method: "POST", body: { optionIds: [option!.id] } });
    expect(vote.status).toBe(403);
    expect((await vote.json()).error.details.code).toBe("not_eligible");
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(ballotVotesOpen).where(eq(ballotVotesOpen.ballotId, ballot!.id));
    expect(n).toBe(0);
  });

  it("hides calendars and events without a grant from an external guest (no club-wide rule 1), shows granted ones", async () => {
    const [open] = await db.insert(calendars).values({ clubId, name: "Offen", createdBy: founderId }).returning();
    const [granted] = await db.insert(calendars).values({ clubId, name: "Freigegeben", createdBy: founderId }).returning();
    await db.insert(calendarVisibility).values({ calendarId: granted!.id, memberId: guestMemberId });
    const [openEvent] = await db.insert(events).values({ calendarId: open!.id, title: "Offener Termin", startsAt: new Date("2030-06-01T10:00:00Z"), createdBy: founderId }).returning();
    const [grantedEvent] = await db.insert(events).values({ calendarId: granted!.id, title: "Freigegebener Termin", startsAt: new Date("2030-06-02T10:00:00Z"), createdBy: founderId }).returning();
    const ids = async (path: string, cookie: string) => ((await (await req(path, cookie)).json()) as { data: Array<{ id: string }> }).data.map((r) => r.id);

    const guestCalendars = await ids("/calendars", cookieGuest);
    expect(guestCalendars).toContain(granted!.id);
    expect(guestCalendars).not.toContain(open!.id);
    const guestEvents = await ids("/events", cookieGuest);
    expect(guestEvents).toContain(grantedEvent!.id);
    expect(guestEvents).not.toContain(openEvent!.id);
    expect((await req(`/calendars/${open!.id}`, cookieGuest)).status).toBe(404);
    expect((await req(`/events/${openEvent!.id}`, cookieGuest)).status).toBe(404);
    expect((await req(`/events/${grantedEvent!.id}`, cookieGuest)).status).toBe(200);
    // A plain member still sees the club-wide ones.
    expect(await ids("/calendars", cookiePlain)).toContain(open!.id);
    expect(await ids("/events", cookiePlain)).toContain(openEvent!.id);
  });

  it("denies the board-only exit-request variants and settings changes to a plain mitglied", async () => {
    const other = (await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, adminMemberId) }))!;
    const asBoard = await req("/club-exit-requests", cookiePlain, { method: "POST", body: { clubMemberId: other.id, kind: "cancellation" } });
    expect(asBoard.status).toBe(403);
    const exclusion = await req("/club-exit-requests", cookiePlain, { method: "POST", body: { clubMemberId: other.id, kind: "exclusion", reason: "x" } });
    expect(exclusion.status).toBe(403);
    expect((await req("/club-exit-requests", cookiePlain)).status).toBe(403);
    expect((await req("/club-settings", cookiePlain, { method: "PATCH", body: { allowSelfLoans: false } })).status).toBe(403);
  });

  it("keeps the application review and the exit request reads closed to outsiders (board only; exit form for members)", async () => {
    const appId = "00000000-0000-4000-8000-0000000000aa";
    for (const cookie of [cookiePlain, cookieGuest]) {
      for (const path of ["/club-applications", `/club-applications/${appId}`, "/club-exit-requests"]) {
        const res = await req(path, cookie);
        expect(res.status, `${path} -> ${res.status}`).toBe(403);
      }
      // A request that exists for nobody the caller is involved in is a 404, never data.
      expect((await req(`/club-exit-requests/${appId}`, cookie)).status).toBe(404);
    }
    expect((await req("/club-exit-requests/form", cookiePlain)).status).toBe(200);
    expect((await req("/club-applications", cookieFounder)).status).toBe(200);
    expect((await req(`/club-applications/${appId}`, cookieFounder)).status).toBe(404);
  });

  it("keeps the audit log behind privacy:read (board allowed; mitglied and guest denied on every route)", async () => {
    const someMember = "00000000-0000-4000-8000-0000000000bb";
    for (const cookie of [cookiePlain, cookieGuest]) {
      for (const path of ["/audit-log", "/audit-log/export", "/audit-log/export.csv", `/audit-log/members/${someMember}`]) {
        const res = await req(path, cookie);
        expect(res.status, `${path} -> ${res.status}`).toBe(403);
      }
    }
    expect((await req("/audit-log", cookieFounder)).status).toBe(200);
    expect((await req(`/audit-log/members/${someMember}`, cookieFounder)).status).toBe(404);
  });

  it("keeps the form builder behind forms:write (board allowed, mitglied and guest denied, reads included)", async () => {
    expect((await req("/forms", cookieFounder)).status).toBe(200);
    for (const cookie of [cookiePlain, cookieGuest]) {
      expect((await req("/forms", cookie)).status).toBe(403);
      expect((await req("/forms", cookie, { method: "POST", body: { purpose: "umfrage", name: "Nope" } })).status).toBe(403);
    }
    const created = await req("/forms", cookieFounder, { method: "POST", body: { purpose: "umfrage", name: "Matrix control" } });
    expect(created.status).toBe(201);
  });

  it("is not vacuous: the same kind of request succeeds for a board role", async () => {
    const created = await req("/meetings", cookieFounder, { method: "POST", body: { type: "vorstandssitzung", title: "Matrix control" } });
    expect(created.status).toBe(201);
    const plainTry = await req("/meetings", cookiePlain, { method: "POST", body: { type: "vorstandssitzung", title: "Matrix control" } });
    expect(plainTry.status).toBe(403);
  });

  // --- implicit role mitglied -------------------------------------------------------------

  describe("implicit role mitglied", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed response helper
    const json = async (res: Response) => (await res.json()) as { data: any; implicit?: string[] };

    it("is part of CLUB_ROLE_TYPES with no permissions at all", () => {
      expect(CLUB_ROLE_TYPES).toContain("mitglied");
      expect(clubPermissionsFor(["mitglied"])).toEqual([]);
    });

    it("gives a plain member empty permissions and the board the new read permissions in /club-members/me", async () => {
      const plain = await json(await req("/club-members/me", cookiePlain));
      expect(plain.data.permissions).toEqual([]);
      const board = (await json(await req("/club-members/me", cookieFounder))).data.permissions as string[];
      expect(board).toEqual(expect.arrayContaining(["meetings:write", "meetings:read_board", "locations:write", "locations:read_access", "club_stats:read"]));
    });

    it("gives read permissions along the agreed roles", () => {
      for (const role of ["vorsitz", "stellv_vorsitz", "schriftfuehrer", "beisitzer"]) expect(clubPermissionsFor([role])).toContain("meetings:read_board");
      for (const role of ["kassenwart", "abteilungsleitung", "trainer", "erziehungsberechtigt"]) expect(clubPermissionsFor([role])).not.toContain("meetings:read_board");
      for (const role of ["vorsitz", "stellv_vorsitz", "schriftfuehrer", "abteilungsleitung"]) expect(clubPermissionsFor([role])).toContain("locations:read_access");
      for (const role of ["kassenwart", "beisitzer", "trainer", "erziehungsberechtigt"]) expect(clubPermissionsFor([role])).not.toContain("locations:read_access");
    });

    it("grants the announcement permissions deny-by-default along the agreed roles (Wave 9 B7)", () => {
      for (const role of ["vorsitz", "stellv_vorsitz", "schriftfuehrer"]) expect(clubPermissionsFor([role])).toContain("announcements:write");
      for (const role of ["mitglied", "kassenwart", "beisitzer", "abteilungsleitung", "trainer", "erziehungsberechtigt"]) expect(clubPermissionsFor([role])).not.toContain("announcements:write");
      for (const role of ["abteilungsleitung", "trainer"]) expect(clubPermissionsFor([role])).toContain("announcements:write_department");
      for (const role of ["mitglied", "vorsitz", "kassenwart", "beisitzer", "erziehungsberechtigt"]) expect(clubPermissionsFor([role])).not.toContain("announcements:write_department");
    });

    it("grants the Wave 10 privacy permissions deny-by-default (B2)", () => {
      for (const role of ["vorsitz", "stellv_vorsitz"]) expect(clubPermissionsFor([role])).toEqual(expect.arrayContaining(["privacy:read", "privacy:manage", "absences:read"]));
      for (const role of ["mitglied", "schriftfuehrer", "kassenwart", "beisitzer", "erziehungsberechtigt"]) expect(clubPermissionsFor([role])).not.toEqual(expect.arrayContaining(["privacy:read"]));
      for (const role of ["abteilungsleitung", "trainer"]) {
        expect(clubPermissionsFor([role])).toContain("absences:read");
        expect(clubPermissionsFor([role])).not.toContain("privacy:read");
      }
    });

    it("cannot be assigned (422) or revoked (409) and is listed as implicit, not as a deletable row", async () => {
      const assign = await req(`/club-members/${plainMemberId}/roles`, cookieFounder, { method: "POST", body: { roleType: "mitglied" } });
      expect(assign.status).toBe(422);

      const roles = await json(await req(`/club-members/${plainMemberId}/roles`, cookieFounder));
      expect(roles.data).toEqual([]);
      expect(roles.implicit).toEqual(["mitglied"]);

      // Even a stray DB row (should never exist) cannot be revoked through the API, and is not double-counted.
      const [stray] = await db.insert(clubRoles).values({ memberId: plainMemberId, roleType: "mitglied" }).returning();
      try {
        const revoke = await req(`/club-members/${plainMemberId}/roles/${stray.id}`, cookieFounder, { method: "DELETE" });
        expect(revoke.status).toBe(409);
        expect((await json(await req("/club-members/me", cookiePlain))).data.permissions).toEqual([]);
      } finally {
        await db.delete(clubRoles).where(eq(clubRoles.id, stray.id));
      }
    });

    it("does not apply to external guests but they stay without write permissions", async () => {
      const denied = await req("/meetings", cookieGuest, { method: "POST", body: { type: "sonstige", title: "Guest" } });
      expect(denied.status).toBe(403);
      expect(guestMemberId).toBeTruthy();
    });
  });

  // --- allow_self_loans (B8c) ------------------------------------------------------------------

  describe("allow_self_loans", () => {
    it("allows borrowing by default, rejects it with 403 when switched off, and exempts inventory:write", async () => {
      const ok = await req(`/inventory-items/${itemId}/loans`, cookiePlain, { method: "POST", body: {} });
      expect(ok.status).toBe(201);

      await db.insert(clubSettings).values({ clubId, allowSelfLoans: false });
      try {
        const denied = await req(`/inventory-items/${itemId}/loans`, cookiePlain, { method: "POST", body: {} });
        expect(denied.status).toBe(403);
        const board = await req(`/inventory-items/${itemId}/loans`, cookieFounder, { method: "POST", body: {} });
        expect(board.status).toBe(201);
        // Damage reports stay available.
        const damage = await req(`/inventory-items/${itemId}/damage-reports`, cookiePlain, { method: "POST", body: { description: "Loch im Zelt" } });
        expect(damage.status).toBe(201);
      } finally {
        await db.delete(clubSettings).where(eq(clubSettings.clubId, clubId));
      }
      const again = await req(`/inventory-items/${itemId}/loans`, cookiePlain, { method: "POST", body: {} });
      expect(again.status).toBe(201);
    });

    it("lets only the borrower or inventory:write return a loan", async () => {
      const loans = (await (await req(`/inventory-items/${itemId}/loans`, cookieFounder)).json()) as { data: Array<{ id: string; memberId: string; returnedAt: string | null }> };
      const open = loans.data.find((l) => l.memberId === plainMemberId && !l.returnedAt)!;
      const other = await signUp("other");
      await auth.api.addMember({ body: { userId: other.userId, organizationId: clubId, role: "member" } });
      try {
        const denied = await req(`/inventory-items/${itemId}/loans/${open.id}`, other.cookie, { method: "PATCH", body: {} });
        expect(denied.status).toBe(403);
        const own = await req(`/inventory-items/${itemId}/loans/${open.id}`, cookiePlain, { method: "PATCH", body: {} });
        expect(own.status).toBe(200);
      } finally {
        await db.delete(user).where(eq(user.id, other.userId));
      }
    });
  });

  describe("loan extension ({ dueAt }) needs inventory:write", () => {
    const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
    const loanPath = (item: string, loan: string) => `/inventory-items/${item}/loans/${loan}`;
    const dueOf = async (loanId: string) => (await db.query.inventoryLoans.findFirst({ where: eq(inventoryLoans.id, loanId) }))!;
    const openLoan = async (cookie: string) => {
      const res = await req(`/inventory-items/${itemId}/loans`, cookie, { method: "POST", body: { dueAt: future(2) } });
      expect(res.status).toBe(201);
      return ((await res.json()) as { data: { id: string } }).data.id;
    };

    it("denies the borrower and a plain member (403, loan untouched), allows the board, refuses returned loans with 409", async () => {
      const loanId = await openLoan(cookiePlain);
      const before = (await dueOf(loanId)).dueAt!.getTime();
      const other = await signUp("ext-other");
      await auth.api.addMember({ body: { userId: other.userId, organizationId: clubId, role: "member" } });
      try {
        // the borrower may return their own loan, but not extend it
        expect((await req(loanPath(itemId, loanId), cookiePlain, { method: "PATCH", body: { dueAt: future(30) } })).status).toBe(403);
        // a plain member who is not the borrower
        expect((await req(loanPath(itemId, loanId), other.cookie, { method: "PATCH", body: { dueAt: future(30) } })).status).toBe(403);
        // an external guest
        expect((await req(loanPath(itemId, loanId), cookieGuest, { method: "PATCH", body: { dueAt: future(30) } })).status).toBe(403);
        expect((await dueOf(loanId)).dueAt!.getTime()).toBe(before);

        const extended = await req(loanPath(itemId, loanId), cookieFounder, { method: "PATCH", body: { dueAt: future(30) } });
        expect(extended.status).toBe(200);
        expect((await dueOf(loanId)).dueAt!.getTime()).toBeGreaterThan(before);

        // returned loans cannot be extended (board) -- and the denial still comes first for a plain member
        expect((await req(loanPath(itemId, loanId), cookiePlain, { method: "PATCH", body: {} })).status).toBe(200);
        expect((await req(loanPath(itemId, loanId), cookieFounder, { method: "PATCH", body: { dueAt: future(60) } })).status).toBe(409);
        expect((await req(loanPath(itemId, loanId), cookiePlain, { method: "PATCH", body: { dueAt: future(60) } })).status).toBe(403);
      } finally {
        await db.delete(user).where(eq(user.id, other.userId));
      }
    });

    it("answers 404 for a foreign item, a foreign loan and a foreign club (no existence leak across clubs)", async () => {
      const ownLoan = await openLoan(cookiePlain);
      const foreignOwner = await signUp("ext-foreign");
      const foreignClub = (await auth.api.createOrganization({ body: { name: `Matrix Foreign ${suffix}`, slug: `matrix-foreign-${suffix}`, userId: foreignOwner.userId } }))!;
      try {
        const foreignMember = (await db.query.member.findFirst({ where: (m, { and: a, eq: e }) => a(e(m.organizationId, foreignClub.id), e(m.userId, foreignOwner.userId)) }))!;
        await db.insert(clubRoles).values({ memberId: foreignMember.id, roleType: "vorsitz" });
        const [foreignItem] = await db.insert(inventoryItems).values({ clubId: foreignClub.id, name: "Fremdes Zelt", condition: "gut" }).returning();
        const [foreignLoan] = await db.insert(inventoryLoans).values({ itemId: foreignItem!.id, memberId: foreignMember.id, dueAt: new Date(Date.now() + 86_400_000) }).returning();

        // the club's board with a foreign item id / foreign loan id (valid permission, wrong club): 404, nothing changed
        expect((await req(loanPath(foreignItem!.id, foreignLoan!.id), cookieFounder, { method: "PATCH", body: { dueAt: future(30) } })).status).toBe(404);
        expect((await req(loanPath(foreignItem!.id, ownLoan), cookieFounder, { method: "PATCH", body: { dueAt: future(30) } })).status).toBe(404);
        expect((await req(loanPath(itemId, foreignLoan!.id), cookieFounder, { method: "PATCH", body: { dueAt: future(30) } })).status).toBe(404);
        expect((await dueOf(foreignLoan!.id)).dueAt!.getTime()).toBe(foreignLoan!.dueAt!.getTime());

        // the foreign club's own board, addressing our item in their club: the item does not exist there
        const foreignReq = (path: string) =>
          app.request(`${path}?clubId=${foreignClub.id}`, {
            method: "PATCH",
            headers: { cookie: foreignOwner.cookie, "x-forwarded-for": randomUUID(), "content-type": "application/json" },
            body: JSON.stringify({ dueAt: future(30) }),
          });
        expect((await foreignReq(loanPath(itemId, ownLoan))).status).toBe(404);
        // our board addressing the foreign club: not a member there, nothing is revealed or changed
        const crossClub = await app.request(`${loanPath(foreignItem!.id, foreignLoan!.id)}?clubId=${foreignClub.id}`, {
          method: "PATCH",
          headers: { cookie: cookieFounder, "x-forwarded-for": randomUUID(), "content-type": "application/json" },
          body: JSON.stringify({ dueAt: future(30) }),
        });
        expect(crossClub.status).toBe(404);
        expect((await dueOf(foreignLoan!.id)).dueAt!.getTime()).toBe(foreignLoan!.dueAt!.getTime());
      } finally {
        await db.delete(organization).where(eq(organization.id, foreignClub.id));
        await db.delete(user).where(eq(user.id, foreignOwner.userId));
      }
    });
  });

  it("keeps the event cancellation preview (it lists who would be reached) behind calendars:write, before any lookup", async () => {
    const path = `/events/${randomUUID()}/cancel-preview`;
    expect((await req(path, cookiePlain)).status).toBe(403);
    expect((await req(path, cookieGuest)).status).toBe(403);
    expect((await req(path, cookieFounder)).status).toBe(404); // board passes the check; the unknown event is the only reason left
  });

  it("keeps application decisions, custom field definitions and foreign custom field values behind their rights (Wave 8 B6/B7)", async () => {
    const target = (await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, adminMemberId) }))!;
    const own = (await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, plainMemberId) }))!;
    for (const cookie of [cookiePlain, cookieGuest]) {
      expect((await req("/club-applications", cookie)).status).toBe(403);
      expect((await req(`/club-applications/${randomUUID()}/approve`, cookie, { method: "POST", body: { categoryKey: "aktiv" } })).status).toBe(403);
      expect((await req(`/club-applications/${randomUUID()}/reject`, cookie, { method: "POST", body: { note: "x" } })).status).toBe(403);
      // Definitions: managing needs forms:write, archived ones are not even listed.
      expect((await req("/member-fields?includeArchived=true", cookie)).status).toBe(403);
      expect((await req("/member-fields", cookie, { method: "POST", body: { key: "nope", label: "Nope", type: "text" } })).status).toBe(403);
      // Writing other people's values needs members:write -- even for the person's own row.
      expect((await req(`/club-members/${own.id}/custom-fields`, cookie, { method: "PUT", body: { values: { nope: "x" } } })).status).toBe(403);
    }
    // The board reads and manages them.
    expect((await req("/member-fields", cookieFounder)).status).toBe(200);
    expect((await req(`/club-members/${target.id}/custom-fields`, cookieFounder)).status).toBe(200);
    // A guest cannot read a member's values (404, like the member detail), a plain member can (only the visible slice).
    expect((await req(`/club-members/${target.id}/custom-fields`, cookieGuest)).status).toBe(404);
    expect((await req(`/club-members/${target.id}/custom-fields`, cookiePlain)).status).toBe(200);
  });

  // --- B16 bugfixes (verification) -----------------------------------------------------------------

  describe("B16 bug fixes", () => {
    it("rejects the founding role schriftfuehrer (it lacks roles:write, so the approval would fail)", async () => {
      const res = await req("/club-registrations", cookiePlain, {
        method: "POST",
        body: {
          clubName: "Schrift Verein",
          legalForm: "nicht_eingetragen",
          street: "Weg 1",
          postalCode: "63571",
          city: "Gelnhausen",
          claimedRole: "schriftfuehrer",
        },
      });
      expect(res.status).toBe(422);
    });

    it("keeps the member number when a Schriftführer (members:write, no read_sensitive) saves a member", async () => {
      const secretary = await signUp("secretary");
      const account = (await auth.api.addMember({ body: { userId: secretary.userId, organizationId: clubId, role: "member" } }))!;
      await db.insert(clubRoles).values({ memberId: account.id, roleType: "schriftfuehrer" });
      try {
        const before = await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, plainMemberId) });
        expect(before!.memberNumber).toBeTruthy();
        const res = await req(`/club-members/${before!.id}`, secretary.cookie, { method: "PATCH", body: { city: "Neustadt" } });
        expect(res.status).toBe(200);
        const after = await db.query.clubMembers.findFirst({ where: and(eq(clubMembers.id, before!.id)) });
        expect(after!.memberNumber).toBe(before!.memberNumber);
        expect(after!.city).toBe("Neustadt");
      } finally {
        await db.delete(user).where(eq(user.id, secretary.userId));
      }
    });

    it("does not return e-mail addresses of other members to a plain member in GET /club-members", async () => {
      const res = await req("/club-members", cookiePlain);
      expect(res.status).toBe(200);
      const rows = ((await res.json()) as { data: Array<Record<string, unknown>> }).data;
      expect(rows.length).toBeGreaterThan(1);
      const founderEmail = `matrix-founder-${suffix}@example.com`;
      expect(JSON.stringify(rows)).not.toContain(founderEmail);
    });
  });
});
