import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";

import { organization } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { clubExternalInvites, externalAccessAssignments } from "../db/schema/external-access.js";
import { locations } from "../db/schema/locations.js";
import { sponsorContacts, sponsors } from "../db/schema/sponsors.js";
import { writeAudit } from "../lib/audit.js";
import { EXTERNAL_ROLE_TYPES, hasClubPermission } from "../lib/club-permissions.js";
import { clubMailLanguage } from "../lib/club-settings.js";
import { APP_NAME, buildExternalInviteEmail, SITE_URL } from "../lib/emailTemplate.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import { acceptExternalInvite, createExternalInvite, currentAssignments, externalAccount, inviteStatus, isExternalOnly, listExternalAccounts, previewExternalInvite, removeExternalAccess, shapeAssignments, shapeInvites } from "../lib/external-access.js";
import { logger } from "../lib/logger.js";
import { signedMediaUrls } from "../lib/media.js";
import { todayBerlin } from "../lib/member-lifecycle.js";
import { notify } from "../lib/notify/dispatcher.js";
import { tr } from "../lib/notify/i18n.js";
import { shapeContact, SPONSOR_LOGO_OWNER, sponsorStatus } from "../lib/sponsors.js";
import { cleanText } from "../lib/text-policy.js";
import { clubGuard, type ClubEnv } from "../middleware/club-guard.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { sessionGuard } from "../middleware/session-guard.js";

/**
 * External logins (Wave 15 B2). Two routers:
 * - `/external-access`: the board (`roles:write`) invites sponsors and service providers by e-mail, revokes invitations, ends
 *   access and gives service providers time-boxed location assignments. `invites/preview` and `invites/accept` are session-only
 *   (the invitee is not a member yet) and registered before the club guard.
 * - `/external`: the self view of an external login (`GET /external/me`): own sponsor profile(s), current/upcoming assignments.
 *   It is the one area `clubGuard` lets an external-only account into (see `lib/external-access.ts`).
 */
export const externalAccessRoutes = new Hono<ClubEnv>();
export const externalRoutes = new Hono<ClubEnv>();

const hook = (result: { success: boolean; error?: { issues: unknown } }) => {
  if (!result.success) throw new ValidationError("Invalid request", { details: result.error?.issues });
};

externalAccessRoutes.use("*", rateLimit({ windowMs: 60_000, max: 60 }));

const tokenLimit = rateLimit({ windowMs: 60_000, max: 20, key: (c) => `external-invite-token:${c.get("user")?.id ?? "anonymous"}` });
const tokenBody = z.object({ token: z.string().min(16).max(200) });

externalAccessRoutes.post("/invites/preview", sessionGuard, tokenLimit, zValidator("json", tokenBody, hook), async (c) => {
  return c.json({ data: await previewExternalInvite(c.req.valid("json").token, c.get("user").email) });
});

externalAccessRoutes.post("/invites/accept", sessionGuard, tokenLimit, zValidator("json", tokenBody, hook), async (c) => {
  const u = c.get("user");
  return c.json({ data: await acceptExternalInvite(c.req.valid("json").token, { id: u.id, email: u.email, emailVerified: u.emailVerified }) });
});

externalAccessRoutes.use("/*", sessionGuard);
externalAccessRoutes.use("/*", clubGuard);
externalAccessRoutes.use("/*", async (c, next) => {
  if (!hasClubPermission(c.get("clubRoleTypes"), "roles:write")) throw new ForbiddenError("Missing roles:write permission");
  c.header("Cache-Control", "private, no-store");
  await next();
});

externalAccessRoutes.get("/", async (c) => {
  const clubId = c.get("clubId");
  const invites = await db.select().from(clubExternalInvites).where(eq(clubExternalInvites.clubId, clubId)).orderBy(desc(clubExternalInvites.createdAt)).limit(200);
  return c.json({ data: { invites: await shapeInvites(invites), accounts: await listExternalAccounts(clubId) } });
});

const ROLE_LABEL = { sponsor: ["Sponsor", "sponsor"], dienstleister: ["Dienstleister", "service provider"] } as const;

/** Mail problems never block an invite (`emailSent: false`, the board can resend); the link is wiped from the delivery row. */
async function sendExternalInviteMail(clubId: string, invite: typeof clubExternalInvites.$inferSelect, token: string): Promise<boolean> {
  try {
    const [club] = await db.select({ name: organization.name }).from(organization).where(eq(organization.id, clubId));
    const lang = await clubMailLanguage(db, clubId);
    const clubName = (club?.name ?? tr(lang, "dein Verein", "your club")).replace(/[\r\n]+/g, " ");
    const subject = tr(lang, `Einladung von ${clubName} zu ${APP_NAME}`, `Invitation from ${clubName} to ${APP_NAME}`);
    const label = ROLE_LABEL[invite.roleType as keyof typeof ROLE_LABEL] ?? ROLE_LABEL.sponsor;
    const result = await notify({
      clubId,
      class: "mandatory",
      eventKey: "external_invite.created",
      refId: invite.id,
      recipients: [{ name: invite.displayName, email: invite.email }],
      content: {
        title: subject,
        body: tr(lang, "Einladung zu einem externen Zugang", "Invitation to an external login"),
        lang,
        rendered: {
          subject,
          html: buildExternalInviteEmail({ name: invite.displayName, clubName, roleLabel: tr(lang, label[0], label[1]), url: `${SITE_URL}/einladung/extern?token=${encodeURIComponent(token)}`, expiresOn: invite.expiresAt.toLocaleDateString(tr(lang, "de-DE", "en-GB"), { timeZone: "Europe/Berlin" }), lang }),
        },
        sensitive: true,
      },
      channels: ["email"],
      immediate: true,
    });
    return result.sentEmail > 0;
  } catch (err) {
    logger.error({ errorName: err instanceof Error ? err.name : "unknown", inviteId: invite.id }, "[external-access] invite e-mail could not be sent");
    return false;
  }
}

const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().max(320).pipe(z.email()),
  roleType: z.enum(EXTERNAL_ROLE_TYPES),
  displayName: cleanText(z.string().trim().min(1).max(120)),
  sponsorId: z.uuid().nullable().optional(),
});
const inviteLimit = rateLimit({ windowMs: 3_600_000, max: 20, key: (c) => `external-invite-create:${c.get("user")?.id ?? "anonymous"}` });

externalAccessRoutes.post("/invites", inviteLimit, zValidator("json", inviteSchema, hook), async (c) => {
  const clubId = c.get("clubId");
  const body = c.req.valid("json");
  const { invite, token } = await createExternalInvite({ clubId, email: body.email, roleType: body.roleType, displayName: body.displayName, sponsorId: body.sponsorId ?? null, createdBy: c.get("membership").id });
  const emailSent = await sendExternalInviteMail(clubId, invite, token);
  return c.json({ data: { ...(await shapeInvites([invite]))[0]!, emailSent } }, 201);
});

async function loadInvite(c: Context<ClubEnv>) {
  const [row] = await db.select().from(clubExternalInvites).where(and(eq(clubExternalInvites.id, c.req.param("id") ?? ""), eq(clubExternalInvites.clubId, c.get("clubId"))));
  if (!row) throw new NotFoundError("Invitation not found");
  return row;
}

/** New token for an invite that is not accepted (also an expired one); the old token stops working. */
externalAccessRoutes.post("/invites/:id/resend", inviteLimit, async (c) => {
  const clubId = c.get("clubId");
  const old = await loadInvite(c);
  if (old.acceptedAt || old.revokedAt) throw new ConflictError("The invitation is no longer open", { details: { code: "invite_not_open" } });
  await db.update(clubExternalInvites).set({ revokedAt: new Date() }).where(and(eq(clubExternalInvites.id, old.id), isNull(clubExternalInvites.acceptedAt)));
  const { invite, token } = await createExternalInvite({ clubId, email: old.email, roleType: old.roleType as (typeof EXTERNAL_ROLE_TYPES)[number], displayName: old.displayName, sponsorId: old.sponsorId, createdBy: c.get("membership").id });
  await writeAudit(db, { eventType: "external_access.invite_resend", subjectId: invite.id, payload: { clubId, inviteId: invite.id, previousInviteId: old.id } });
  const emailSent = await sendExternalInviteMail(clubId, invite, token);
  return c.json({ data: { ...(await shapeInvites([invite]))[0]!, emailSent } }, 201);
});

externalAccessRoutes.delete("/invites/:id", async (c) => {
  const invite = await loadInvite(c);
  if (inviteStatus(invite) === "accepted" || invite.revokedAt) throw new ConflictError("The invitation is no longer open", { details: { code: "invite_not_open" } });
  await db.transaction(async (tx) => {
    await tx.update(clubExternalInvites).set({ revokedAt: new Date() }).where(eq(clubExternalInvites.id, invite.id));
    await writeAudit(tx, { eventType: "external_access.invite_revoke", subjectId: invite.id, payload: { clubId: invite.clubId, inviteId: invite.id } });
  });
  return c.body(null, 204);
});

externalAccessRoutes.delete("/accounts/:memberId", async (c) => {
  await removeExternalAccess(c.get("clubId"), c.req.param("memberId"));
  return c.body(null, 204);
});

const MAX_WINDOW_MS = 366 * 86_400_000;
const assignmentSchema = z
  .object({
    title: cleanText(z.string().trim().min(1).max(120)),
    note: z.union([cleanText(z.string().trim().max(1000), true), z.null()]).optional(),
    locationId: z.uuid().nullable().optional(),
    validFrom: z.iso.datetime({ offset: true }),
    validUntil: z.iso.datetime({ offset: true }),
  })
  .refine((v) => Date.parse(v.validUntil) > Date.parse(v.validFrom), { message: "validUntil must be after validFrom", path: ["validUntil"] })
  .refine((v) => Date.parse(v.validUntil) - Date.parse(v.validFrom) <= MAX_WINDOW_MS, { message: "The window covers at most 366 days", path: ["validUntil"] });

externalAccessRoutes.post("/accounts/:memberId/assignments", zValidator("json", assignmentSchema, hook), async (c) => {
  const clubId = c.get("clubId");
  const { member: account, roles } = await externalAccount(clubId, c.req.param("memberId"));
  if (!roles.includes("dienstleister")) throw new ValidationError("Assignments are only for service providers", { details: { code: "not_service_provider" } });
  const body = c.req.valid("json");
  if (body.locationId) {
    const [loc] = await db.select({ id: locations.id }).from(locations).where(and(eq(locations.id, body.locationId), eq(locations.clubId, clubId)));
    if (!loc) throw new ValidationError("Unknown location", { details: { code: "unknown_location" } });
  }
  const row = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(externalAccessAssignments)
      .values({ clubId, memberId: account.id, locationId: body.locationId ?? null, title: body.title, note: body.note || null, validFrom: new Date(body.validFrom), validUntil: new Date(body.validUntil), createdBy: c.get("membership").id })
      .returning();
    await writeAudit(tx, { eventType: "external_access.assignment_create", subjectId: created!.id, payload: { clubId, assignmentId: created!.id, memberId: account.id, locationId: body.locationId ?? undefined } });
    return created!;
  });
  return c.json({ data: (await shapeAssignments([row]))[0] }, 201);
});

externalAccessRoutes.delete("/accounts/:memberId/assignments/:assignmentId", async (c) => {
  const clubId = c.get("clubId");
  const memberId = c.req.param("memberId");
  const deleted = await db.transaction(async (tx) => {
    const rows = await tx
      .delete(externalAccessAssignments)
      .where(and(eq(externalAccessAssignments.id, c.req.param("assignmentId")), eq(externalAccessAssignments.clubId, clubId), eq(externalAccessAssignments.memberId, memberId)))
      .returning({ id: externalAccessAssignments.id });
    if (rows.length > 0) await writeAudit(tx, { eventType: "external_access.assignment_delete", subjectId: rows[0]!.id, payload: { clubId, assignmentId: rows[0]!.id, memberId } });
    return rows.length;
  });
  if (deleted === 0) throw new NotFoundError("Assignment not found");
  return c.body(null, 204);
});

// --- Self view ------------------------------------------------------------------------------------------------------------

externalRoutes.use("*", rateLimit({ windowMs: 60_000, max: 60 }));
externalRoutes.use("*", sessionGuard);
externalRoutes.use("*", clubGuard);

/** What an external login sees: own sponsor profile(s) without internal notes, current and upcoming assignments. */
externalRoutes.get("/me", async (c) => {
  const clubId = c.get("clubId");
  const membership = c.get("membership");
  const roleTypes = c.get("clubRoleTypes");
  const [club] = await db.select({ name: organization.name, slug: organization.slug }).from(organization).where(eq(organization.id, clubId));
  const own = await db.select().from(sponsors).where(and(eq(sponsors.clubId, clubId), eq(sponsors.linkedMemberId, membership.id)));
  const [urls, contacts] = await Promise.all([
    signedMediaUrls(clubId, own.map((s) => s.logoKey), SPONSOR_LOGO_OWNER),
    own.length ? db.select().from(sponsorContacts).where(inArray(sponsorContacts.sponsorId, own.map((s) => s.id))) : Promise.resolve([]),
  ]);
  const today = todayBerlin();
  c.header("Cache-Control", "private, no-store");
  return c.json({
    data: {
      clubId,
      clubName: club?.name ?? null,
      clubSlug: club?.slug ?? null,
      externalOnly: isExternalOnly(membership.role, roleTypes),
      roleTypes,
      sponsors: own.map((s) => ({
        id: s.id,
        name: s.name,
        website: s.website,
        description: s.description,
        consideration: s.consideration,
        startsOn: s.startsOn,
        endsOn: s.endsOn,
        status: sponsorStatus(s, today),
        logoUrl: s.logoKey ? (urls.get(s.logoKey) ?? null) : null,
        contacts: contacts.filter((x) => x.sponsorId === s.id).map(shapeContact),
      })),
      assignments: await currentAssignments(clubId, membership.id, true),
    },
  });
});
