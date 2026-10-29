import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { db } from "../db/client.js";
import { memberCards, type MemberCardRow } from "../db/schema/documents.js";
import { writeAudit } from "../lib/audit.js";
import { hasClubPermission } from "../lib/club-permissions.js";
import { buildPrincipal } from "../lib/document-access.js";
import { ForbiddenError, ValidationError } from "../lib/errors.js";
import { signedMediaUrl } from "../lib/media.js";
import { cardState, categoryNameOf, initialsOf, loadMemberRow, parseCardToken, photoConsentGranted } from "../lib/member-cards.js";
import { clubGuard, type ClubEnv } from "../middleware/club-guard.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { sessionGuard } from "../middleware/session-guard.js";

/**
 * Checking a membership card (Wave 13 B13), mounted at `/member-cards`: the checker (a signed-in member of the SAME club with
 * `member_cards:verify`) sends the scanned token; the answer is `gueltig`, `abgelaufen`, `ausgetreten` or `ungueltig` and, for
 * a valid card only, what is needed to compare the person (name, category, photo only with consent). Anything that is not a
 * genuine card of this club (forged, malformed, another club, replaced by a re-issue) is the same `ungueltig`, so the answer
 * never tells whether a card exists. Every check is audited (who checked whom).
 */
export const memberCardVerifyRoutes = new Hono<ClubEnv>();
memberCardVerifyRoutes.use("*", rateLimit({ windowMs: 60_000, max: 120 }));
memberCardVerifyRoutes.use("*", sessionGuard);
memberCardVerifyRoutes.use("*", clubGuard);

const invalid = (result: { success: boolean; error?: { issues: unknown } }) => {
  if (!result.success) throw new ValidationError("Invalid request", { details: result.error?.issues });
};

// Per checker: a forged token cannot be found by trying (128-bit signature), the limit keeps a stolen session from probing at all.
const verifyLimiter = rateLimit({ windowMs: 60_000, max: 30, key: (c) => `member-card-verify:${c.get("user").id}` });
const verifyClubLimiter = rateLimit({ windowMs: 60_000, max: 300, key: (c) => `member-card-verify-club:${c.get("clubId")}` });

const verifySchema = z.object({ token: z.string().max(400) });

/** The one answer for everything that is not a genuine card of THIS club: no hint what is wrong with it. */
const INVALID = { result: "ungueltig" as const };

memberCardVerifyRoutes.post("/verify", verifyLimiter, verifyClubLimiter, zValidator("json", verifySchema, invalid), async (c) => {
  if (c.get("membership").role === "guest" || !hasClubPermission(c.get("clubRoleTypes"), "member_cards:verify")) throw new ForbiddenError("Missing member_cards:verify permission");
  const p = await buildPrincipal(c);
  c.header("Cache-Control", "private, no-store");
  const checkedAt = new Date();
  const parsed = parseCardToken(c.req.valid("json").token);
  const card = parsed ? await findCardById(parsed.cardId) : null;
  // A token of another club, a version that was replaced by a re-issue, a forged or malformed one: all the same answer.
  if (!parsed || !card || card.clubId !== p.clubId || card.tokenVersion !== parsed.version) {
    await writeAudit(db, { eventType: "member_card.verify_failed", subjectId: p.clubId, actorUserId: p.userId, clubId: p.clubId, payload: { clubId: p.clubId } });
    return c.json({ data: { ...INVALID, checkedAt } });
  }
  const person = await loadMemberRow(p.clubId, card.clubMemberId);
  if (!person) return c.json({ data: { ...INVALID, checkedAt } });
  let { state } = cardState(card, person);
  if (state === "gueltig" && parsed.expiresAt.getTime() < checkedAt.getTime()) state = "abgelaufen";
  // Only a valid card shows who it is, so that the checker can compare the person; the other states reveal nothing about the person.
  let member: { displayName: string; category: string | null; initials: string; photo: { url: string } | null } | null = null;
  if (state === "gueltig") {
    const photoUrl = person.photoKey && (await photoConsentGranted(p.clubId, person.id)) ? await signedMediaUrl(p.clubId, person.photoKey, "club_member") : null;
    member = { displayName: person.displayName, category: await categoryNameOf(person.categoryId), initials: initialsOf(person.displayName), photo: photoUrl ? { url: photoUrl } : null };
  }
  await writeAudit(db, { eventType: "member_card.verify", subjectId: person.id, actorUserId: p.userId, clubId: p.clubId, payload: { clubId: p.clubId, cardId: card.id, result: state } });
  return c.json({ data: { result: state, ...(member ? { member } : {}), checkedAt } });
});

async function findCardById(cardId: string): Promise<MemberCardRow | null> {
  const [row] = await db.select().from(memberCards).where(eq(memberCards.id, cardId)).limit(1);
  return row ?? null;
}

