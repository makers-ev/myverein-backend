import { zValidator } from "@hono/zod-validator";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";

import { db } from "../db/client.js";
import { clubMembers } from "../db/schema/club-members.js";
import { eventAttendees } from "../db/schema/event-attendees.js";
import { eventRegistrationSettings } from "../db/schema/event-extras.js";
import { events, type EventRow } from "../db/schema/events.js";
import { forms, formVersions } from "../db/schema/forms.js";
import { writeAudit } from "../lib/audit.js";
import { hasClubPermission } from "../lib/club-permissions.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import { loadClubEvent, loadVisibleEvent, needsPermission } from "../lib/event-access.js";
import { notifyPromoted } from "../lib/event-notify.js";
import { cancelRegistration, describeRegistration, effectiveSettings, loadRegistration, loadSettings, saveRegistration, MAX_PARTY_SIZE, type Identity } from "../lib/event-registration.js";
import { hashToken, newToken, publicEventUrl } from "../lib/event-guests.js";
import { liveLinkOf } from "../lib/guardian-scope.js";
import { effectiveStatus, isLeftStatus, todayBerlin } from "../lib/member-lifecycle.js";
import { wardCalendarIds } from "../lib/ward-events.js";
import type { ClubEnv } from "../middleware/club-guard.js";

/**
 * Registration for events (Wave 12 B13): the RSVP routes with party size, form answers and "for somebody else"
 * (guardian for a ward without account, board for any member), plus the registration settings of an event.
 * Mounted into `eventRoutes` (session + club guard come from there).
 */
export const eventRegistrationRoutes = new Hono<ClubEnv>();

const hook = (result: { success: boolean; error?: { issues: unknown } }) => {
  if (!result.success) throw new ValidationError("Invalid request body", { details: result.error?.issues });
};

const MAX_ANSWERS_BYTES = 64 * 1024;

const rsvpSchema = z.object({
  partySize: z.number().int().min(1).max(MAX_PARTY_SIZE).optional(),
  answers: z.record(z.string(), z.unknown()).optional(),
  /** Register a club member without account (guardian of the ward) or any member (board, `members:write`) instead of oneself. */
  forClubMemberId: z.uuid().optional(),
});

/** Optional JSON body: old clients send none. */
async function readOptionalBody(c: Context): Promise<unknown> {
  const text = await c.req.text();
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ValidationError("Invalid JSON body");
  }
}

interface Registrant {
  event: EventRow;
  identity: Identity;
  registeredByMemberId: string | null;
  onBehalfOf: "self" | "guardian";
}

/** Who is being registered: the caller, a ward of the caller (live guardian link) or - with `members:write` - any active member. */
async function resolveRegistrant(c: Context<ClubEnv>, eventId: string, forClubMemberId: string | undefined): Promise<Registrant> {
  const clubId = c.get("clubId");
  const membership = c.get("membership");
  const roles = c.get("clubRoleTypes");
  const own = forClubMemberId ? (await db.select({ id: clubMembers.id }).from(clubMembers).where(and(eq(clubMembers.memberId, membership.id), eq(clubMembers.clubId, clubId))))[0] : undefined;
  if (!forClubMemberId || own?.id === forClubMemberId) {
    const { event } = await loadVisibleEvent(eventId, clubId, membership.id, roles);
    return { event, identity: { kind: "account", memberId: membership.id }, registeredByMemberId: null, onBehalfOf: "self" };
  }

  const [target] = await db.select().from(clubMembers).where(and(eq(clubMembers.id, forClubMemberId), eq(clubMembers.clubId, clubId)));
  if (!target) throw new NotFoundError("Member not found");

  const link = await liveLinkOf(membership.id, target.id);
  if (link) {
    if (target.memberId !== null) throw new ConflictError("The ward has an own account and responds there", { details: { code: "ward_has_account" } });
    // A guardian sees the events of the ward's calendars, not of the club (Wave 10 B4).
    const calendarIds = await wardCalendarIds(target);
    const [event] = await db.select().from(events).where(eq(events.id, eventId));
    if (!event || !calendarIds.includes(event.calendarId)) throw new NotFoundError("Event not found");
    return { event, identity: { kind: "member", clubMemberId: target.id }, registeredByMemberId: membership.id, onBehalfOf: "guardian" };
  }
  if (!hasClubPermission(roles, "members:write")) throw new ForbiddenError("Registering somebody else needs a linked guardian relation or members:write");
  const { event } = await loadVisibleEvent(eventId, clubId, membership.id, roles);
  if (isLeftStatus(effectiveStatus(target, todayBerlin()))) throw new ValidationError("The member has left the club", { details: { code: "member_left" } });
  return { event, identity: target.memberId ? { kind: "account", memberId: target.memberId } : { kind: "member", clubMemberId: target.id }, registeredByMemberId: membership.id, onBehalfOf: "self" };
}

eventRegistrationRoutes.post("/:id/rsvp", async (c) => {
  const parsed = rsvpSchema.safeParse(await readOptionalBody(c));
  if (!parsed.success) throw new ValidationError("Invalid request body", { details: parsed.error.issues });
  if (parsed.data.answers && JSON.stringify(parsed.data.answers).length > MAX_ANSWERS_BYTES) throw new ValidationError("Answers are too large", { details: { code: "answers_too_large" } });
  // Like GET and DELETE, the target may also come as query parameter.
  const queryTarget = z.uuid().optional().safeParse(c.req.query("forClubMemberId"));
  if (!queryTarget.success) throw new ValidationError("forClubMemberId must be a uuid");
  const target = await resolveRegistrant(c, c.req.param("id"), parsed.data.forClubMemberId ?? queryTarget.data);
  if (target.event.cancelledAt !== null) throw new ConflictError("Event is cancelled");

  const result = await saveRegistration({
    clubId: c.get("clubId"),
    eventId: target.event.id,
    identity: target.identity,
    partySize: parsed.data.partySize ?? 1,
    answers: parsed.data.answers,
    actorUserId: c.get("user").id,
    registeredByMemberId: target.registeredByMemberId,
    onBehalfOf: target.onBehalfOf,
  });
  await notifyPromoted({ clubId: c.get("clubId"), event: target.event, promoted: result.promoted });
  return c.json({ data: { status: result.status, partySize: result.partySize, attendeeId: result.attendeeId } });
});

/** The own (or the ward's) registration with its answers, for editing. `data: null` when there is none. */
eventRegistrationRoutes.get("/:id/rsvp", async (c) => {
  const forClubMemberId = z.uuid().optional().safeParse(c.req.query("forClubMemberId"));
  if (!forClubMemberId.success) throw new ValidationError("forClubMemberId must be a uuid");
  const target = await resolveRegistrant(c, c.req.param("id"), forClubMemberId.data);
  return c.json({ data: await loadRegistration(target.event.id, target.identity) });
});

eventRegistrationRoutes.delete("/:id/rsvp", async (c) => {
  const forClubMemberId = z.uuid().optional().safeParse(c.req.query("forClubMemberId"));
  if (!forClubMemberId.success) throw new ValidationError("forClubMemberId must be a uuid");
  const target = await resolveRegistrant(c, c.req.param("id"), forClubMemberId.data);
  const promoted = await cancelRegistration({ clubId: c.get("clubId"), eventId: target.event.id, identity: target.identity });
  // After the commit: tell the people who moved up (best effort, in addition to the audit entries).
  await notifyPromoted({ clubId: c.get("clubId"), event: target.event, promoted });
  return c.body(null, 204);
});

// --- Registration settings -------------------------------------------------------------------------------------------

/** What the caller needs to render the registration of an event: rules, form, and (for managers) the settings. */
eventRegistrationRoutes.get("/:id/registration", async (c) => {
  const clubId = c.get("clubId");
  const { event, calendar } = await loadVisibleEvent(c.req.param("id"), clubId, c.get("membership").id, c.get("clubRoleTypes"));
  const view = await describeRegistration(clubId, event);
  const canManage = hasClubPermission(c.get("clubRoleTypes"), "calendars:write");
  let manage: Record<string, unknown> | undefined;
  if (canManage) {
    const settings = effectiveSettings(await loadSettings(event.id));
    const pinned = settings.formVersionId ? (await db.select({ formId: formVersions.formId, version: formVersions.version }).from(formVersions).where(eq(formVersions.id, settings.formVersionId)))[0] : undefined;
    manage = { formId: pinned?.formId ?? null, formVersion: pinned?.version ?? null, guestRetentionDays: settings.guestRetentionDays, publicLinkActive: event.publicRegistrationTokenHash !== null };
  }
  return c.json({ data: { eventId: event.id, calendarId: calendar.id, ...view, canManage, ...(manage ? { manage } : {}) } });
});

const settingsSchema = z.object({
  enabled: z.boolean(),
  /** A form of purpose `veranstaltungsanmeldung`; its currently published version is pinned. `null` = no form. */
  formId: z.uuid().nullable().optional(),
  deadlineAt: z.string().datetime({ offset: true }).nullable().optional(),
  allowGuests: z.boolean().optional(),
  maxCompanions: z.number().int().min(0).max(MAX_PARTY_SIZE - 1).optional(),
  guestRetentionDays: z.number().int().min(1).max(365).optional(),
});

eventRegistrationRoutes.put("/:id/registration", needsPermission("calendars:write"), zValidator("json", settingsSchema, hook), async (c) => {
  const clubId = c.get("clubId");
  const { event } = await loadClubEvent(c.req.param("id"), clubId);
  const body = c.req.valid("json");

  let formVersionId: string | null | undefined;
  if (body.formId === null) formVersionId = null;
  else if (body.formId !== undefined) {
    const [form] = await db.select().from(forms).where(and(eq(forms.id, body.formId), eq(forms.clubId, clubId), eq(forms.purpose, "veranstaltungsanmeldung"), isNull(forms.archivedAt)));
    if (!form) throw new NotFoundError("Form not found");
    const [version] = await db.select().from(formVersions).where(and(eq(formVersions.formId, form.id), eq(formVersions.status, "published")));
    if (!version) throw new ConflictError("The form has no published version", { details: { code: "form_not_published" } });
    formVersionId = version.id;
  }

  await db.transaction(async (tx) => {
    const [current] = await tx.select().from(eventRegistrationSettings).where(eq(eventRegistrationSettings.eventId, event.id)).for("update");
    if (formVersionId !== undefined && current?.formVersionId && formVersionId !== current.formVersionId) {
      const [oldForm] = await tx.select({ formId: formVersions.formId }).from(formVersions).where(eq(formVersions.id, current.formVersionId));
      const [newForm] = formVersionId ? await tx.select({ formId: formVersions.formId }).from(formVersions).where(eq(formVersions.id, formVersionId)) : [undefined];
      const [answered] = await tx.select({ id: eventAttendees.id }).from(eventAttendees).where(and(eq(eventAttendees.eventId, event.id), isNotNull(eventAttendees.formSubmissionId))).limit(1);
      // Switching to a different form (or removing it) would orphan the answers already given; a newer version of the same form is fine.
      if (answered && oldForm?.formId !== newForm?.formId) throw new ConflictError("Registrations with answers exist: the form cannot be replaced", { details: { code: "form_locked" } });
    }
    const values = {
      enabled: body.enabled,
      ...(formVersionId !== undefined ? { formVersionId } : {}),
      ...(body.deadlineAt !== undefined ? { deadlineAt: body.deadlineAt === null ? null : new Date(body.deadlineAt) } : {}),
      ...(body.allowGuests !== undefined ? { allowGuests: body.allowGuests } : {}),
      ...(body.maxCompanions !== undefined ? { maxCompanions: body.maxCompanions } : {}),
      ...(body.guestRetentionDays !== undefined ? { guestRetentionDays: body.guestRetentionDays } : {}),
      updatedAt: new Date(),
    };
    const [saved] = await tx.insert(eventRegistrationSettings).values({ eventId: event.id, ...values }).onConflictDoUpdate({ target: eventRegistrationSettings.eventId, set: values }).returning();
    await writeAudit(tx, { eventType: "event_registration.settings", subjectId: event.id, payload: { clubId, eventId: event.id, enabled: saved!.enabled, changedFields: Object.keys(body) } });
  });
  const view = await describeRegistration(clubId, event);
  return c.json({ data: { eventId: event.id, ...view } });
});

// --- Public registration link for guests (B14) ---------------------------------------------------------------------

/**
 * Creates (or replaces) the public link of the event. The plain token is returned ONCE; only its SHA-256 is stored. Guests
 * must be allowed in the registration settings. Replacing the link kills the old one at once.
 */
eventRegistrationRoutes.post("/:id/public-link", needsPermission("calendars:write"), async (c) => {
  const clubId = c.get("clubId");
  const { event } = await loadClubEvent(c.req.param("id"), clubId);
  const settings = effectiveSettings(await loadSettings(event.id));
  if (!settings.enabled || !settings.allowGuests) throw new ConflictError("Enable the registration and allow guests first", { details: { code: "guests_not_allowed" } });
  if (event.cancelledAt !== null) throw new ConflictError("Event is cancelled");
  const token = newToken();
  await db.update(events).set({ publicRegistrationTokenHash: hashToken(token), updatedAt: new Date() }).where(eq(events.id, event.id));
  await writeAudit(db, { eventType: "event_registration.public_link", subjectId: event.id, payload: { clubId, eventId: event.id, action: event.publicRegistrationTokenHash ? "rotate" : "create" } });
  return c.json({ data: { token, url: publicEventUrl(token), active: true } }, 201);
});

/** Revokes the public link (the URL stops working at once; existing guest registrations stay). */
eventRegistrationRoutes.delete("/:id/public-link", needsPermission("calendars:write"), async (c) => {
  const clubId = c.get("clubId");
  const { event } = await loadClubEvent(c.req.param("id"), clubId);
  await db.update(events).set({ publicRegistrationTokenHash: null, updatedAt: new Date() }).where(eq(events.id, event.id));
  await writeAudit(db, { eventType: "event_registration.public_link", subjectId: event.id, payload: { clubId, eventId: event.id, action: "revoke" } });
  return c.body(null, 204);
});
