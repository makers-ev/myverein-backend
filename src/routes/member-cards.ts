import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { organization } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { clubMembers, type ClubMemberRow } from "../db/schema/club-members.js";
import { clubSettings } from "../db/schema/club-settings.js";
import { type MemberCardRow } from "../db/schema/documents.js";
import { writeAudit } from "../lib/audit.js";
import { DEFAULT_ACCENT_COLOR, DEFAULT_PRIMARY_COLOR } from "../lib/branding.js";
import { isUuid } from "../lib/club-members.js";
import { hasClubPermission } from "../lib/club-permissions.js";
import { buildPrincipal, type DocumentPrincipal } from "../lib/document-access.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import { liveLinkOf } from "../lib/guardian-scope.js";
import { DOCUMENT_OWNER_TYPES, respondRenderedPdf, signedMediaUrl } from "../lib/media.js";
import { cardState, categoryNameOf, ensureCard, findCardOf, initialsOf, loadMemberRow, photoConsentGranted, reissueCard, revokeCard, signCardToken, type CardState } from "../lib/member-cards.js";
import { renderEphemeral } from "../lib/pdf/render.js";
import { registerBuiltinTemplates } from "../lib/pdf/templates/index.js";
import { clubGuard, type ClubEnv } from "../middleware/club-guard.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { sessionGuard } from "../middleware/session-guard.js";

/**
 * Digital membership card (Wave 13 B12, B13). Two routers:
 *  - `memberCardRoutes` (mounted at `/club-members`): the card of a person (`me`, a ward of the caller, or any member for
 *    `member_cards:manage`), its printable PDF, issuing / re-issuing / revoking;
 *  - `memberCardVerifyRoutes` (mounted at `/member-cards`): checking a scanned token (`member_cards:verify`) and printing sheets.
 * The QR holds only a signed opaque token (see `lib/member-cards.ts`); validity is derived live on every read and every check.
 */

registerBuiltinTemplates();

const isManager = (p: DocumentPrincipal): boolean => !p.isGuest && hasClubPermission(p.roleTypes, "member_cards:manage");
const requireManage = (c: { get(key: "clubRoleTypes"): string[]; get(key: "membership"): { role: string } }): void => {
  if (c.get("membership").role === "guest" || !hasClubPermission(c.get("clubRoleTypes"), "member_cards:manage")) throw new ForbiddenError("Missing member_cards:manage permission");
};
const invalid = (result: { success: boolean; error?: { issues: unknown } }) => {
  if (!result.success) throw new ValidationError("Invalid request", { details: result.error?.issues });
};

type Relation = "self" | "guardian" | "board";

/** The person a card route is about; strangers get the same `404` as for an unknown member. */
async function resolveSubject(p: DocumentPrincipal, idParam: string): Promise<{ person: ClubMemberRow; relation: Relation }> {
  let id: string;
  if (idParam === "me") {
    if (!p.clubMemberId || p.isGuest) throw new NotFoundError("Member not found");
    id = p.clubMemberId;
  } else {
    if (!isUuid(idParam)) throw new NotFoundError("Member not found");
    id = idParam;
  }
  const person = await loadMemberRow(p.clubId, id);
  if (!person) throw new NotFoundError("Member not found");
  if (p.clubMemberId === person.id && !p.isGuest) return { person, relation: "self" };
  if (await liveLinkOf(p.accountMemberId, person.id)) return { person, relation: "guardian" };
  if (isManager(p)) return { person, relation: "board" };
  throw new NotFoundError("Member not found");
}

async function clubLook(clubId: string) {
  const [[club], [settings]] = await Promise.all([db.select({ name: organization.name }).from(organization).where(eq(organization.id, clubId)).limit(1), db.select().from(clubSettings).where(eq(clubSettings.clubId, clubId)).limit(1)]);
  return {
    name: club?.name ?? "",
    primaryColor: settings?.brandPrimaryColor ?? DEFAULT_PRIMARY_COLOR,
    accentColor: settings?.brandAccentColor ?? DEFAULT_ACCENT_COLOR,
    logo: settings?.brandLogoKey ? { url: await signedMediaUrl(clubId, settings.brandLogoKey, DOCUMENT_OWNER_TYPES.branding) } : null,
  };
}

/** What a client needs to show the card. The token is only included while the card is valid. */
async function shapeCard(person: ClubMemberRow, card: MemberCardRow | null, opts: { includeHint: boolean }) {
  const consent = await photoConsentGranted(person.clubId, person.id);
  const photoUrl = consent && person.photoKey ? await signedMediaUrl(person.clubId, person.photoKey, "club_member") : null;
  const state: CardState | "nicht_ausgestellt" = card ? cardState(card, person).state : "nicht_ausgestellt";
  const hint = card ? cardState(card, person).hint : null;
  const signed = card && state === "gueltig" ? signCardToken(card) : null;
  return {
    clubMemberId: person.id,
    cardId: card?.id ?? null,
    issued: card !== null,
    state,
    ...(opts.includeHint ? { hint } : {}),
    validUntil: card?.validUntil ?? null,
    issuedAt: card?.issuedAt ?? null,
    token: signed?.token ?? null,
    tokenExpiresAt: signed?.expiresAt ?? null,
    member: { displayName: person.displayName, memberNumber: person.memberNumber, category: await categoryNameOf(person.categoryId), initials: initialsOf(person.displayName) },
    club: await clubLook(person.clubId),
    // The photo only appears with the person's (or the guardian's) consent; without it the app shows the initials.
    photo: photoUrl ? { url: photoUrl } : null,
    photoConsent: consent,
    checkedAt: new Date(),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The card of a person
// ---------------------------------------------------------------------------------------------------------------------

export const memberCardRoutes = new Hono<ClubEnv>();
memberCardRoutes.use("*", rateLimit({ windowMs: 60_000, max: 120 }));
memberCardRoutes.use("*", sessionGuard);
memberCardRoutes.use("*", clubGuard);

const pdfLimiter = rateLimit({ windowMs: 60_000, max: 20, key: (c) => `member-card-pdf:${c.get("user").id}` });
const manageLimiter = rateLimit({ windowMs: 60_000, max: 60, key: (c) => `member-card-manage:${c.get("user").id}` });

/** Self, guardian and the board read the card; a missing card of a person with a valid membership is issued on the first look by the person (or guardian). */
async function cardForView(p: DocumentPrincipal, person: ClubMemberRow, relation: Relation): Promise<MemberCardRow | null> {
  const existing = await findCardOf(person.id);
  if (existing || relation === "board") return existing;
  // Issued automatically once the person is a valid member: `ensureCard` is idempotent, the unique key wins a race.
  const probe = { status: "aktiv", revokedReason: null, validUntil: null } as const;
  if (cardState(probe, person).state !== "gueltig") return null;
  const card = await db.transaction((tx) => ensureCard(tx, p.clubId, person.id, null));
  await writeAudit(db, { eventType: "member_card.issue", subjectId: person.id, actorUserId: p.userId, clubId: p.clubId, payload: { clubId: p.clubId, cardId: card.id, via: "auto" } });
  return card;
}

memberCardRoutes.get("/me/card", async (c) => {
  const p = await buildPrincipal(c);
  const { person, relation } = await resolveSubject(p, "me");
  c.header("Cache-Control", "private, no-store");
  return c.json({ data: await shapeCard(person, await cardForView(p, person, relation), { includeHint: true }) });
});

memberCardRoutes.get("/me/card.pdf", pdfLimiter, async (c) => cardPdf(c, "me"));

memberCardRoutes.get("/:id/card", async (c) => {
  const p = await buildPrincipal(c);
  const { person, relation } = await resolveSubject(p, c.req.param("id"));
  c.header("Cache-Control", "private, no-store");
  return c.json({ data: await shapeCard(person, await cardForView(p, person, relation), { includeHint: true }) });
});

memberCardRoutes.get("/:id/card.pdf", pdfLimiter, async (c) => cardPdf(c, c.req.param("id")));

const layoutQuery = z.object({ layout: z.enum(["card", "a4"]).default("card") });

async function cardPdf(c: Parameters<typeof buildPrincipal>[0], idParam: string): Promise<Response> {
  const p = await buildPrincipal(c);
  const { person, relation } = await resolveSubject(p, idParam);
  const parsed = layoutQuery.safeParse({ layout: c.req.query("layout") });
  if (!parsed.success) throw new ValidationError("Invalid layout", { details: parsed.error.issues });
  const card = await cardForView(p, person, relation);
  if (!card || cardState(card, person).state !== "gueltig") throw new NotFoundError("No valid card");
  const { bytes, filename } = await renderEphemeral("mitgliedsausweis", p.clubId, { clubMemberId: person.id, layout: parsed.data.layout });
  await writeAudit(db, { eventType: "member_card.print", subjectId: person.id, actorUserId: p.userId, clubId: p.clubId, payload: { clubId: p.clubId, cardId: card.id, layout: parsed.data.layout } });
  return respondRenderedPdf(c, bytes, filename, "attachment");
}

const issueSchema = z.object({ validUntil: z.string().date().nullable().optional() }).strict();

/** Issues the card of a person (idempotent: an active card is returned unchanged; a revoked one needs `reissue`). */
memberCardRoutes.post("/:id/card", manageLimiter, zValidator("json", issueSchema, invalid), async (c) => {
  requireManage(c);
  const p = await buildPrincipal(c);
  const body = c.req.valid("json");
  const { person } = await resolveSubject(p, c.req.param("id"));
  const before = await findCardOf(person.id);
  const card = await db.transaction((tx) => ensureCard(tx, p.clubId, person.id, p.userId, body.validUntil ?? null));
  if (!before) await writeAudit(db, { eventType: "member_card.issue", subjectId: person.id, actorUserId: p.userId, clubId: p.clubId, payload: { clubId: p.clubId, cardId: card.id, via: "board" } });
  return c.json({ data: await shapeCard(person, card, { includeHint: true }) }, before ? 200 : 201);
});

/** New token version: every earlier token and printed QR stops working at once. Also brings a revoked card back. */
memberCardRoutes.post("/:id/card/reissue", manageLimiter, zValidator("json", issueSchema, invalid), async (c) => {
  requireManage(c);
  const p = await buildPrincipal(c);
  const body = c.req.valid("json");
  const { person } = await resolveSubject(p, c.req.param("id"));
  const card = await db.transaction(async (tx) => reissueCard(tx, await ensureCard(tx, p.clubId, person.id, p.userId), p.userId, body.validUntil));
  await writeAudit(db, { eventType: "member_card.reissue", subjectId: person.id, actorUserId: p.userId, clubId: p.clubId, payload: { clubId: p.clubId, cardId: card.id, via: "board" } });
  return c.json({ data: await shapeCard(person, card, { includeHint: true }) });
});

memberCardRoutes.post("/:id/card/revoke", manageLimiter, async (c) => {
  requireManage(c);
  const p = await buildPrincipal(c);
  const { person } = await resolveSubject(p, c.req.param("id"));
  const card = await findCardOf(person.id);
  if (!card) throw new NotFoundError("Card not found");
  const changed = await revokeCard(db, person.id, "manuell");
  if (changed) await writeAudit(db, { eventType: "member_card.revoke", subjectId: person.id, actorUserId: p.userId, clubId: p.clubId, payload: { clubId: p.clubId, cardId: card.id, via: "board" } });
  return c.json({ data: await shapeCard(person, await findCardOf(person.id), { includeHint: true }) });
});

// ---------------------------------------------------------------------------------------------------------------------
// Printing sheets
// ---------------------------------------------------------------------------------------------------------------------

export const memberCardSheetRoutes = new Hono<ClubEnv>();
memberCardSheetRoutes.use("*", rateLimit({ windowMs: 60_000, max: 120 }));
memberCardSheetRoutes.use("*", sessionGuard);
memberCardSheetRoutes.use("*", clubGuard);

const printSchema = z.object({ clubMemberIds: z.array(z.uuid()).min(1).max(40) });

/** Sheet with several cards (QR, name, number; no photo). Missing cards of valid members are issued; the PDF is not stored. */
memberCardSheetRoutes.post("/print", pdfLimiter, zValidator("json", printSchema, invalid), async (c) => {
  requireManage(c);
  const p = await buildPrincipal(c);
  const ids = [...new Set(c.req.valid("json").clubMemberIds)];
  const found = await db.select({ id: clubMembers.id }).from(clubMembers).where(eq(clubMembers.clubId, p.clubId));
  const known = new Set(found.map((f) => f.id));
  if (ids.some((id) => !known.has(id))) throw new NotFoundError("Member not found");
  const { bytes, filename } = await renderEphemeral("ausweis-sammeldruck", p.clubId, { clubMemberIds: ids });
  await writeAudit(db, { eventType: "member_card.print_sheet", subjectId: p.clubId, actorUserId: p.userId, clubId: p.clubId, payload: { clubId: p.clubId, count: ids.length } });
  return respondRenderedPdf(c, bytes, filename, "attachment");
});

