import { zValidator } from "@hono/zod-validator";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";

import { db } from "../db/client.js";
import { VOTE_KINDS, meetingAgendaItems, meetingInvitationDeliveries, meetingInvitations, meetingProxies, meetingVotingRoll } from "../db/schema/assembly.js";
import { meetings } from "../db/schema/meetings.js";
import { clubMembers } from "../db/schema/club-members.js";
import { writeAudit } from "../lib/audit.js";
import { MAJORITY_TOPICS } from "../lib/assembly-rules.js";
import { computeQuorum, freezeVotingRoll, grantProxy, loadEligibility, overrideVotingRight } from "../lib/assembly-attendance.js";
import { deliverySummary, previewInvitation, sendInvitation, syncInvitationDeliveries } from "../lib/assembly-invitation.js";
import { loadClubSettings } from "../lib/club-settings.js";
import { hasClubPermission } from "../lib/club-permissions.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import { buildCsv } from "../lib/member-csv.js";
import { callerClubMemberId, clubMembersByIds, resolveClubMember } from "../lib/meeting-members.js";
import { tr } from "../lib/notify/i18n.js";
import { cleanText } from "../lib/text-policy.js";
import type { ClubEnv } from "../middleware/club-guard.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { loadClubMeeting } from "../lib/meeting-access.js";
import { scheduleInvitationPdf } from "../lib/member-document-triggers.js";

/**
 * General assembly on top of `/meetings` (Wave 11): structured agenda and the formal invitation with period check and proof of
 * delivery (B3). Mounted into `meetingRoutes` (`meetingRoutes.route("/", ...)`), so it runs behind the same rate limit, session and
 * club guards; read scoping as everywhere in `/meetings` (`loadClubMeeting`: 404, never 403).
 */
export const meetingAssemblyRoutes = new Hono<ClubEnv>();

const validate = <T extends z.ZodType>(schema: T) =>
  zValidator("json", schema, (result) => {
    if (!result.success) throw new ValidationError("Invalid request body", { details: result.error.issues });
  });

const roles = (c: Context<ClubEnv>) => c.get("clubRoleTypes");
const canManage = (c: Context<ClubEnv>) => hasClubPermission(roles(c), "assembly:manage") || hasClubPermission(roles(c), "meetings:write");

function requireAssemblyManage(c: Context<ClubEnv>) {
  if (!hasClubPermission(roles(c), "assembly:manage")) throw new ForbiddenError("Missing assembly:manage permission");
}

const uuid = z.string().uuid();
function paramId(c: Context<ClubEnv>, name: string): string {
  const raw = c.req.param(name) ?? "";
  if (!uuid.safeParse(raw).success) throw new NotFoundError("Not found");
  return raw;
}

// --- Agenda items ---------------------------------------------------------------------------------------------------

type AgendaItem = typeof meetingAgendaItems.$inferSelect;

const shapeItem = (a: AgendaItem) => ({
  id: a.id,
  meetingId: a.meetingId,
  position: a.position,
  title: a.title,
  description: a.description,
  voteKind: a.voteKind,
  topic: a.topic,
  announced: a.announcedInInvitationId !== null,
  announcedInInvitationId: a.announcedInInvitationId,
});

async function itemsOf(meetingId: string): Promise<AgendaItem[]> {
  return db.select().from(meetingAgendaItems).where(eq(meetingAgendaItems.meetingId, meetingId)).orderBy(asc(meetingAgendaItems.position), asc(meetingAgendaItems.createdAt));
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Writes positions 1..n in the given order. */
async function renumber(tx: Tx, orderedIds: string[]) {
  for (const [i, id] of orderedIds.entries()) await tx.update(meetingAgendaItems).set({ position: i + 1 }).where(eq(meetingAgendaItems.id, id));
}

meetingAssemblyRoutes.get("/:id/agenda-items", async (c) => {
  const meeting = await loadClubMeeting(c, paramId(c, "id"));
  const items = await itemsOf(meeting.id);
  // The draft agenda is for the people who prepare it; everybody else sees what an invitation announced.
  return c.json({ data: (canManage(c) ? items : items.filter((a) => a.announcedInInvitationId !== null)).map(shapeItem) });
});

const itemFields = {
  title: cleanText(z.string().trim().min(1).max(300)),
  description: z
    .union([cleanText(z.string().trim().max(4000), true), z.null()])
    .transform((v) => (v === "" ? null : v))
    .optional(),
  voteKind: z.enum(VOTE_KINDS).optional(),
  topic: z.enum(MAJORITY_TOPICS).optional(),
  position: z.number().int().min(1).max(500).optional(),
};
const createItemSchema = z.object(itemFields);
const updateItemSchema = z.object({ ...itemFields, title: itemFields.title.optional() });

function requireAgendaWrite(c: Context<ClubEnv>) {
  if (!canManage(c)) throw new ForbiddenError("Missing assembly:manage or meetings:write permission");
}

meetingAssemblyRoutes.post("/:id/agenda-items", validate(createItemSchema), async (c) => {
  requireAgendaWrite(c);
  const meeting = await loadClubMeeting(c, paramId(c, "id"));
  const body = c.req.valid("json");
  const created = await db.transaction(async (tx) => {
    // Serialise reorderings of one agenda.
    await tx.execute(sql`select id from meetings where id = ${meeting.id} for update`);
    const existing = await tx.select({ id: meetingAgendaItems.id }).from(meetingAgendaItems).where(eq(meetingAgendaItems.meetingId, meeting.id)).orderBy(asc(meetingAgendaItems.position), asc(meetingAgendaItems.createdAt));
    const [row] = await tx
      .insert(meetingAgendaItems)
      .values({
        meetingId: meeting.id,
        position: existing.length + 1,
        title: body.title,
        description: body.description ?? null,
        voteKind: body.voteKind ?? "none",
        topic: body.topic ?? (body.voteKind === "election" ? "wahl" : "allgemein"),
      })
      .returning();
    const order = existing.map((e) => e.id);
    order.splice(Math.min((body.position ?? order.length + 1) - 1, order.length), 0, row!.id);
    await renumber(tx, order);
    await writeAudit(tx, { eventType: "meeting_agenda_item.create", subjectId: row!.id, payload: { clubId: c.get("clubId"), meetingId: meeting.id } });
    return row!.id;
  });
  const item = await db.query.meetingAgendaItems.findFirst({ where: eq(meetingAgendaItems.id, created) });
  return c.json({ data: shapeItem(item!) }, 201);
});

async function loadItem(meetingId: string, itemId: string): Promise<AgendaItem> {
  const item = await db.query.meetingAgendaItems.findFirst({ where: and(eq(meetingAgendaItems.id, itemId), eq(meetingAgendaItems.meetingId, meetingId)) });
  if (!item) throw new NotFoundError("Agenda item not found");
  return item;
}

/** An announced item is what the members were invited to: it changes only through a Nachtrag, never silently. */
function refuseAnnounced(item: AgendaItem) {
  if (item.announcedInInvitationId !== null) throw new ConflictError("This agenda item was announced in an invitation and can no longer be changed", { details: { code: "agenda_item_announced" } });
}

meetingAssemblyRoutes.patch("/:id/agenda-items/:itemId", validate(updateItemSchema), async (c) => {
  requireAgendaWrite(c);
  const meeting = await loadClubMeeting(c, paramId(c, "id"));
  const body = c.req.valid("json");
  const itemId = paramId(c, "itemId");
  await db.transaction(async (tx) => {
    await tx.execute(sql`select id from meetings where id = ${meeting.id} for update`);
    const item = await loadItem(meeting.id, itemId);
    refuseAnnounced(item);
    const { position, ...fields } = body;
    const set = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
    if (Object.keys(set).length > 0) await tx.update(meetingAgendaItems).set(set).where(eq(meetingAgendaItems.id, itemId));
    if (position !== undefined) {
      const order = (await tx.select({ id: meetingAgendaItems.id }).from(meetingAgendaItems).where(eq(meetingAgendaItems.meetingId, meeting.id)).orderBy(asc(meetingAgendaItems.position), asc(meetingAgendaItems.createdAt))).map((r) => r.id);
      order.splice(order.indexOf(itemId), 1);
      order.splice(Math.min(position - 1, order.length), 0, itemId);
      await renumber(tx, order);
    }
    await writeAudit(tx, { eventType: "meeting_agenda_item.update", subjectId: itemId, payload: { clubId: c.get("clubId"), meetingId: meeting.id, changedFields: Object.keys(body) } });
  });
  return c.json({ data: shapeItem(await loadItem(meeting.id, itemId)) });
});

meetingAssemblyRoutes.delete("/:id/agenda-items/:itemId", async (c) => {
  requireAgendaWrite(c);
  const meeting = await loadClubMeeting(c, paramId(c, "id"));
  const itemId = paramId(c, "itemId");
  await db.transaction(async (tx) => {
    await tx.execute(sql`select id from meetings where id = ${meeting.id} for update`);
    const item = await loadItem(meeting.id, itemId);
    refuseAnnounced(item);
    await tx.delete(meetingAgendaItems).where(eq(meetingAgendaItems.id, itemId));
    const rest = await tx.select({ id: meetingAgendaItems.id }).from(meetingAgendaItems).where(eq(meetingAgendaItems.meetingId, meeting.id)).orderBy(asc(meetingAgendaItems.position), asc(meetingAgendaItems.createdAt));
    await renumber(tx, rest.map((r) => r.id));
    await writeAudit(tx, { eventType: "meeting_agenda_item.delete", subjectId: itemId, payload: { clubId: c.get("clubId"), meetingId: meeting.id } });
  });
  return c.body(null, 204);
});

// --- Invitations ----------------------------------------------------------------------------------------------------

type InvitationRow = typeof meetingInvitations.$inferSelect;

/** Invitation without the recipient list: what a member may read (content, version, hash). */
const shapePublic = (i: InvitationRow) => ({ id: i.id, version: i.version, kind: i.kind, sentAt: i.sentAt, content: i.content, contentHash: i.contentHash });

const shapeManaged = (i: InvitationRow) => ({
  ...shapePublic(i),
  sentBy: i.sentBy,
  recipientCount: i.recipientCount,
  periodCheck: i.periodCheck,
  rulesSnapshot: i.rulesSnapshot,
  exceptionReason: i.exceptionReason,
});

meetingAssemblyRoutes.get("/:id/invitations/preview", async (c) => {
  requireAssemblyManage(c);
  const meeting = await loadClubMeeting(c, paramId(c, "id"));
  const audience = z.enum(["all_members", "voting_members"]).default("all_members").safeParse(c.req.query("audience"));
  if (!audience.success) throw new ValidationError("Invalid query", { details: audience.error.issues });
  return c.json({ data: await previewInvitation(c.get("clubId"), meeting, new Date(), audience.data) });
});

const sendSchema = z.object({
  /** Optional personal note above the agenda. */
  message: z.union([cleanText(z.string().trim().max(4000), true), z.null()]).optional(),
  /** Needed to send although the invitation period is not met; recorded and shown in the minutes. */
  exceptionReason: cleanText(z.string().trim().min(5).max(1000), true).optional(),
  /** Who is invited: every member (default) or only the members with a voting right on the meeting day. */
  audience: z.enum(["all_members", "voting_members"]).optional(),
});

meetingAssemblyRoutes.post(
  "/:id/invitations",
  rateLimit({ windowMs: 60_000, max: 20, key: (c) => `meeting-invitation:${c.get("user")?.id ?? "anonymous"}` }),
  validate(sendSchema),
  async (c) => {
    requireAssemblyManage(c);
    const meeting = await loadClubMeeting(c, paramId(c, "id"));
    const body = c.req.valid("json");
    const { invitation, summary } = await sendInvitation({ clubId: c.get("clubId"), meeting, actorUserId: c.get("user").id, message: body.message, exceptionReason: body.exceptionReason, audience: body.audience });
    await scheduleInvitationPdf({ clubId: c.get("clubId"), meetingId: meeting.id, version: invitation.version });
    return c.json({ data: { ...shapeManaged(invitation), deliveries: summary, summary: await deliverySummary(invitation.id) } }, 201);
  },
);

meetingAssemblyRoutes.get("/:id/invitations", async (c) => {
  requireAssemblyManage(c);
  const meeting = await loadClubMeeting(c, paramId(c, "id"));
  const rows = await db.select().from(meetingInvitations).where(eq(meetingInvitations.meetingId, meeting.id)).orderBy(asc(meetingInvitations.version));
  for (const row of rows) await syncInvitationDeliveries(row.id);
  const data = [];
  for (const row of rows) data.push({ ...shapeManaged(row), summary: await deliverySummary(row.id) });
  return c.json({ data });
});

/** The newest invitation as the members received it (agenda, time, place); no recipients, no exception reason. */
meetingAssemblyRoutes.get("/:id/invitations/latest", async (c) => {
  const meeting = await loadClubMeeting(c, paramId(c, "id"));
  const [row] = await db.select().from(meetingInvitations).where(eq(meetingInvitations.meetingId, meeting.id)).orderBy(desc(meetingInvitations.version)).limit(1);
  if (!row) throw new NotFoundError("No invitation sent yet");
  return c.json({ data: shapePublic(row) });
});

async function loadInvitation(meetingId: string, invitationId: string): Promise<InvitationRow> {
  const row = await db.query.meetingInvitations.findFirst({ where: and(eq(meetingInvitations.id, invitationId), eq(meetingInvitations.meetingId, meetingId)) });
  if (!row) throw new NotFoundError("Invitation not found");
  return row;
}

const listQuerySchema = z.object({
  channel: z.enum(["email", "inapp", "post"]).optional(),
  status: z.enum(["queued", "sent", "failed", "bounced", "manual_posted"]).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});

/** Proof of delivery: the invitation, the counts per channel and status and the delivery rows (paged, filterable). */
meetingAssemblyRoutes.get("/:id/invitations/:invId", async (c) => {
  requireAssemblyManage(c);
  const meeting = await loadClubMeeting(c, paramId(c, "id"));
  const invitation = await loadInvitation(meeting.id, paramId(c, "invId"));
  const query = listQuerySchema.safeParse(c.req.query());
  if (!query.success) throw new ValidationError("Invalid query", { details: query.error.issues });
  await syncInvitationDeliveries(invitation.id);
  const { channel, status, limit, offset } = query.data;
  const where = and(eq(meetingInvitationDeliveries.invitationId, invitation.id), channel ? eq(meetingInvitationDeliveries.channel, channel) : undefined, status ? eq(meetingInvitationDeliveries.status, status) : undefined);
  const deliveries = await db
    .select({
      id: meetingInvitationDeliveries.id,
      clubMemberId: meetingInvitationDeliveries.clubMemberId,
      displayName: clubMembers.displayName,
      channel: meetingInvitationDeliveries.channel,
      status: meetingInvitationDeliveries.status,
      errorCode: meetingInvitationDeliveries.errorCode,
      statusAt: meetingInvitationDeliveries.statusAt,
      postedAt: meetingInvitationDeliveries.postedAt,
    })
    .from(meetingInvitationDeliveries)
    .leftJoin(clubMembers, eq(clubMembers.id, meetingInvitationDeliveries.clubMemberId))
    .where(where)
    .orderBy(asc(clubMembers.displayName), asc(meetingInvitationDeliveries.channel), asc(meetingInvitationDeliveries.id))
    .limit(limit)
    .offset(offset);
  return c.json({ data: { ...shapeManaged(invitation), summary: await deliverySummary(invitation.id), deliveries } });
});

/** Names and addresses of the members who get the invitation by post. Sensitive: needs `members:read_sensitive`, audited. */
meetingAssemblyRoutes.get("/:id/invitations/:invId/post-list.csv", async (c) => {
  if (!hasClubPermission(roles(c), "members:read_sensitive")) throw new ForbiddenError("Missing members:read_sensitive permission");
  const clubId = c.get("clubId");
  const meeting = await loadClubMeeting(c, paramId(c, "id"));
  const invitation = await loadInvitation(meeting.id, paramId(c, "invId"));
  await syncInvitationDeliveries(invitation.id);
  const all = c.req.query("status") === "all";
  const lang = (await loadClubSettings(db, clubId)).mailLanguage;
  const rows = await db
    .select({
      name: clubMembers.displayName,
      street: clubMembers.street,
      postalCode: clubMembers.postalCode,
      city: clubMembers.city,
      errorCode: meetingInvitationDeliveries.errorCode,
      status: meetingInvitationDeliveries.status,
    })
    .from(meetingInvitationDeliveries)
    .innerJoin(clubMembers, and(eq(clubMembers.id, meetingInvitationDeliveries.clubMemberId), eq(clubMembers.clubId, clubId)))
    .where(and(eq(meetingInvitationDeliveries.invitationId, invitation.id), eq(meetingInvitationDeliveries.channel, "post"), all ? undefined : eq(meetingInvitationDeliveries.status, "queued")))
    .orderBy(asc(clubMembers.displayName), asc(clubMembers.id));
  const reason = (code: string | null) =>
    code === "no_address" ? tr(lang, "Keine E-Mail-Adresse", "No e-mail address") : code === "email_failed" ? tr(lang, "E-Mail nicht zugestellt", "E-mail not delivered") : tr(lang, "Schriftform laut Satzung", "Written form required by the statute");
  const csv = buildCsv(
    [tr(lang, "Name", "Name"), tr(lang, "Straße", "Street"), tr(lang, "PLZ", "Postal code"), tr(lang, "Ort", "City"), tr(lang, "Grund", "Reason"), "Status"],
    rows.map((r) => [r.name, r.street, r.postalCode, r.city, reason(r.errorCode), r.status]),
  );
  await writeAudit(db, { eventType: "meeting_invitation.export", subjectId: invitation.id, payload: { clubId, meetingId: meeting.id, invitationId: invitation.id, rows: rows.length } });
  return c.body(csv, 200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="einladung-${invitation.version}-postliste.csv"`,
    "Cache-Control": "private, no-store",
  });
});

const markPostedSchema = z.object({ clubMemberIds: z.array(uuid).min(1).max(5000).optional() });

/** The board posted the letters: queued post rows become `manual_posted` (all of them, or the listed members). */
meetingAssemblyRoutes.post("/:id/invitations/:invId/deliveries/mark-posted", validate(markPostedSchema), async (c) => {
  requireAssemblyManage(c);
  const meeting = await loadClubMeeting(c, paramId(c, "id"));
  const invitation = await loadInvitation(meeting.id, paramId(c, "invId"));
  const { clubMemberIds } = c.req.valid("json");
  await syncInvitationDeliveries(invitation.id);
  const now = new Date();
  const updated = await db
    .update(meetingInvitationDeliveries)
    .set({ status: "manual_posted", postedAt: now, statusAt: now })
    .where(and(eq(meetingInvitationDeliveries.invitationId, invitation.id), eq(meetingInvitationDeliveries.channel, "post"), eq(meetingInvitationDeliveries.status, "queued"), clubMemberIds ? inArray(meetingInvitationDeliveries.clubMemberId, clubMemberIds) : undefined))
    .returning({ id: meetingInvitationDeliveries.id });
  await writeAudit(db, { eventType: "meeting_invitation.mark_posted", subjectId: invitation.id, payload: { clubId: c.get("clubId"), meetingId: meeting.id, invitationId: invitation.id, count: updated.length } });
  return c.json({ data: { marked: updated.length, summary: await deliverySummary(invitation.id) } });
});

// --- Voting roll, proxies, quorum (B4) -------------------------------------------------------------------------------

// The roll shows WHY somebody may not vote (age, status, manual override with reason): assembly:manage only, `meetings:write` is not enough.
const manageRoll = (c: Context<ClubEnv>) => requireAssemblyManage(c);

const rollQuerySchema = z.object({ eligible: z.enum(["true", "false"]).optional() });

/** The voting roll: frozen entries with the basis, or the live derivation while it is not frozen. */
meetingAssemblyRoutes.get("/:id/voting-roll", async (c) => {
  manageRoll(c);
  const clubId = c.get("clubId");
  const meeting = await loadClubMeeting(c, paramId(c, "id"));
  const query = rollQuerySchema.safeParse(c.req.query());
  if (!query.success) throw new ValidationError("Invalid query", { details: query.error.issues });
  const eligibility = await loadEligibility(db, clubId, meeting);
  const people = await db.select({ id: clubMembers.id, displayName: clubMembers.displayName }).from(clubMembers).where(eq(clubMembers.clubId, clubId)).orderBy(asc(clubMembers.displayName), asc(clubMembers.id));
  const overrides = eligibility.frozen
    ? new Map((await db.select({ id: meetingVotingRoll.clubMemberId, reason: meetingVotingRoll.overrideReason }).from(meetingVotingRoll).where(eq(meetingVotingRoll.meetingId, meeting.id))).map((r) => [r.id, r.reason]))
    : new Map<string | null, string | null>();
  const wanted = query.data.eligible === undefined ? undefined : query.data.eligible === "true";
  const entries = people
    .flatMap((p) => {
      const e = eligibility.byMember.get(p.id);
      // Frozen: only who is on the roll. Live: members who have not left before the reference day (their basis says why not).
      if (!e || (!eligibility.frozen && e.basis === "left")) return [];
      return wanted === undefined || wanted === e.eligible ? [{ clubMemberId: p.id, displayName: p.displayName, eligible: e.eligible, basis: e.basis, overrideReason: overrides.get(p.id) ?? null }] : [];
    });
  const eligibleTotal = [...eligibility.byMember.values()].filter((e) => e.eligible).length;
  return c.json({ data: { frozen: eligibility.frozen, frozenAt: meeting.votingRollFrozenAt, asOf: eligibility.asOf, eligibleTotal, entries } });
});

/** The caller's own entry (every member who may read the meeting): "am I on the voting roll, and why / why not". */
meetingAssemblyRoutes.get("/:id/voting-roll/me", async (c) => {
  const clubId = c.get("clubId");
  const meeting = await loadClubMeeting(c, paramId(c, "id"));
  const me = await callerClubMemberId(db, clubId, c.get("membership").id);
  const eligibility = await loadEligibility(db, clubId, meeting);
  const own = me ? eligibility.byMember.get(me) : undefined;
  return c.json({ data: { frozen: eligibility.frozen, asOf: eligibility.asOf, eligible: own?.eligible ?? false, basis: own?.basis ?? "none" } });
});

meetingAssemblyRoutes.post("/:id/voting-roll/freeze", async (c) => {
  requireAssemblyManage(c);
  const meeting = await loadClubMeeting(c, paramId(c, "id"));
  const result = await freezeVotingRoll(c.get("clubId"), meeting.id, c.get("user").id);
  return c.json({ data: { frozen: true, ...result } }, 201);
});

const overrideSchema = z.object({ eligible: z.boolean(), reason: cleanText(z.string().trim().min(5).max(500), true) });

meetingAssemblyRoutes.patch("/:id/voting-roll/:clubMemberId", validate(overrideSchema), async (c) => {
  requireAssemblyManage(c);
  const clubId = c.get("clubId");
  const meeting = await loadClubMeeting(c, paramId(c, "id"));
  const person = await resolveClubMember(db, clubId, { clubMemberId: paramId(c, "clubMemberId") });
  if (!person) throw new NotFoundError("Member not found in this club");
  const body = c.req.valid("json");
  await overrideVotingRight({ clubId, meetingId: meeting.id, clubMemberId: person.id, eligible: body.eligible, reason: body.reason, actorUserId: c.get("user").id });
  return c.json({ data: { clubMemberId: person.id, eligible: body.eligible, basis: "override", overrideReason: body.reason } });
});

const proxySchema = z.object({
  holderClubMemberId: uuid,
  grantorClubMemberId: uuid.optional(),
  /** Mandatory when the board records the proxy for somebody else, e.g. "Vollmacht per E-Mail vom 3.3."; stays on the proxy and in the audit. */
  proofSource: cleanText(z.string().trim().min(1).max(500)).optional(),
});

/** Proxies of the meeting: managers see all with names, a member only the proxies they gave or hold. */
meetingAssemblyRoutes.get("/:id/proxies", async (c) => {
  const clubId = c.get("clubId");
  const meeting = await loadClubMeeting(c, paramId(c, "id"));
  const me = await callerClubMemberId(db, clubId, c.get("membership").id);
  const all = await db.select().from(meetingProxies).where(eq(meetingProxies.meetingId, meeting.id));
  const rows = hasClubPermission(roles(c), "assembly:manage") ? all : all.filter((p) => me !== null && (p.grantorClubMemberId === me || p.holderClubMemberId === me));
  const people = await clubMembersByIds(db, clubId, rows.flatMap((p) => [p.grantorClubMemberId, p.holderClubMemberId]).filter((v): v is string => v !== null));
  return c.json({
    data: rows.map((p) => ({
      id: p.id,
      grantorClubMemberId: p.grantorClubMemberId,
      grantorName: p.grantorClubMemberId ? (people.get(p.grantorClubMemberId)?.displayName ?? null) : null,
      holderClubMemberId: p.holderClubMemberId,
      holderName: p.holderClubMemberId ? (people.get(p.holderClubMemberId)?.displayName ?? null) : null,
      createdAt: p.createdAt,
      ...(hasClubPermission(roles(c), "assembly:manage") ? { proofSource: p.proofSource } : {}),
    })),
  });
});

/**
 * Gives a proxy. Without `grantorClubMemberId` the caller gives their own (self-service, any member who may read the
 * meeting); for somebody else the board (`assembly:manage`) records it. The statute rules apply either way.
 */
meetingAssemblyRoutes.post("/:id/proxies", validate(proxySchema), async (c) => {
  const clubId = c.get("clubId");
  const meeting = await loadClubMeeting(c, paramId(c, "id"));
  if (meeting.type !== "mitgliederversammlung") throw new ValidationError("Proxies exist for the general assembly only", { details: { code: "proxy_not_supported" } });
  const body = c.req.valid("json");
  const me = await callerClubMemberId(db, clubId, c.get("membership").id);
  const grantorId = body.grantorClubMemberId ?? me;
  if (!grantorId) throw new NotFoundError("Member not found in this club");
  const byBoard = grantorId !== me;
  if (byBoard) requireAssemblyManage(c);
  const [grantor, holder] = await Promise.all([resolveClubMember(db, clubId, { clubMemberId: grantorId }), resolveClubMember(db, clubId, { clubMemberId: body.holderClubMemberId })]);
  if (!grantor || !holder) throw new NotFoundError("Member not found in this club");
  await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(meetings).where(eq(meetings.id, meeting.id)).for("update");
    await grantProxy(tx, { clubId, meeting: locked!, grantorClubMemberId: grantor.id, holderClubMemberId: holder.id, grantedBy: c.get("user").id, byBoard, proofSource: body.proofSource });
  });
  return c.json({ data: { grantorClubMemberId: grantor.id, holderClubMemberId: holder.id } }, 201);
});

/** Withdraws a proxy: the giver themselves, or the board. */
meetingAssemblyRoutes.delete("/:id/proxies/:grantorClubMemberId", async (c) => {
  const clubId = c.get("clubId");
  const meeting = await loadClubMeeting(c, paramId(c, "id"));
  const grantorId = paramId(c, "grantorClubMemberId");
  const me = await callerClubMemberId(db, clubId, c.get("membership").id);
  const byBoard = grantorId !== me;
  if (byBoard) requireAssemblyManage(c);
  if (!byBoard && ["abgehalten", "protokolliert", "abgesagt"].includes(meeting.status)) throw new ConflictError("The meeting is over", { details: { code: "meeting_closed" } });
  const removed = await db.delete(meetingProxies).where(and(eq(meetingProxies.meetingId, meeting.id), eq(meetingProxies.grantorClubMemberId, grantorId))).returning({ id: meetingProxies.id });
  if (removed.length === 0) throw new NotFoundError("Proxy not found");
  await writeAudit(db, { eventType: "meeting_proxy.revoke", subjectId: meeting.id, payload: { clubId, meetingId: meeting.id, grantorClubMemberId: grantorId, byBoard } });
  return c.body(null, 204);
});

/** Live quorum (aggregated numbers, no names). B5 checks it again whenever a vote is opened. */
meetingAssemblyRoutes.get("/:id/quorum", async (c) => {
  const meeting = await loadClubMeeting(c, paramId(c, "id"));
  return c.json({ data: await computeQuorum(db, c.get("clubId"), meeting) });
});
