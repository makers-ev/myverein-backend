import { zValidator } from "@hono/zod-validator";
import { asc, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";

import { db } from "../db/client.js";
import type { ClubMemberRow } from "../db/schema/club-members.js";
import { consentPurposes, consentRecords, consentTexts, type ConsentGivenBy } from "../db/schema/privacy.js";
import { afterConsentRevoked, clubMemberOf, consentAgeLimitOf, isUnderConsentAge, memberConsentViews, PROOF_SOURCE_MAX, recordConsent } from "../lib/consent.js";
import { isUuid } from "../lib/club-members.js";
import { hasClubPermission } from "../lib/club-permissions.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import { liveLinkOf } from "../lib/guardian-scope.js";
import { cleanText } from "../lib/text-policy.js";
import type { ClubEnv } from "../middleware/club-guard.js";

/**
 * `/club-members/:id/consents` (Wave 10 B3), mounted into the club-members router (session + club guard come from there).
 * Who may decide for a member:
 * - an adult (at/above the purpose's age limit) with an account: themself (`self`);
 * - a minor: a guardian with a live link and `can_consent` (`guardian`), or the board with a paper proof (`board_paper`,
 *   date + source mandatory; also allowed for adults). A minor with an account may only REVOKE alone.
 * Declining or ignoring has no consequence for membership or any feature: nothing reads these records to allow or deny access.
 */
export const memberConsentRoutes = new Hono<ClubEnv>();

const validationHook = (result: { success: boolean; error?: { issues: unknown } }) => {
  if (!result.success) throw new ValidationError("Invalid request body", { details: result.error?.issues });
};

const proofSchema = z.object({
  proofDate: z.iso.date().optional(),
  proofSource: cleanText(z.string().trim().min(1).max(PROOF_SOURCE_MAX)).optional(),
});
const grantSchema = proofSchema.extend({ textVersionId: z.uuid() });

type Ctx = Context<ClubEnv>;

/** Who the caller is relative to the member: the member themself and/or a live guardian link. */
async function relationOf(c: Ctx, ward: ClubMemberRow) {
  const membership = c.get("membership");
  const link = await liveLinkOf(membership.id, ward.id);
  return {
    isSelf: ward.memberId !== null && ward.memberId === membership.id,
    link: link?.link ?? null,
    canRead: hasClubPermission(c.get("clubRoleTypes"), "privacy:read"),
    canManage: hasClubPermission(c.get("clubRoleTypes"), "privacy:manage"),
  };
}

memberConsentRoutes.get("/", async (c) => {
  const clubId = c.get("clubId");
  const ward = await clubMemberOf(clubId, c.req.param("id")!);
  const rel = await relationOf(c, ward);
  if (!rel.isSelf && rel.link === null && !rel.canRead && !rel.canManage) throw new ForbiddenError("Not allowed to see the consents of this member");

  const views = await memberConsentViews(clubId, ward.id);
  const events = await db
    .select({ id: consentRecords.id, purposeId: consentRecords.purposeId, purposeKey: consentPurposes.key, action: consentRecords.action, givenBy: consentRecords.givenBy, version: consentTexts.version, createdAt: consentRecords.createdAt, proofDate: consentRecords.proofDate, proofSource: consentRecords.proofSource })
    .from(consentRecords)
    .innerJoin(consentPurposes, eq(consentPurposes.id, consentRecords.purposeId))
    .innerJoin(consentTexts, eq(consentTexts.id, consentRecords.textVersionId))
    .where(eq(consentRecords.clubMemberId, ward.id))
    .orderBy(desc(consentRecords.createdAt), asc(consentRecords.id));
  const showProof = rel.canRead || rel.canManage;
  return c.json({
    data: {
      clubMemberId: ward.id,
      consents: views,
      open: views.filter((v) => v.open).length,
      history: events.map((e) => ({ ...e, proofDate: showProof ? e.proofDate : null, proofSource: showProof ? e.proofSource : null })),
    },
  });
});

/** The path a consent event takes for this caller, or the refusal. */
async function authorize(c: Ctx, ward: ClubMemberRow, action: "granted" | "revoked", purpose: { minAge: number | null }, proof: { proofDate?: string | undefined; proofSource?: string | undefined }): Promise<{ givenBy: ConsentGivenBy; via: "member" | "guardian" | "board" }> {
  const rel = await relationOf(c, ward);
  // Board with a paper proof (also for adults): both fields are checked by `recordConsent` (422 `proof_required`).
  if (rel.canManage && (proof.proofDate !== undefined || proof.proofSource !== undefined)) return { givenBy: "board_paper", via: "board" };

  const limit = await consentAgeLimitOf(ward.clubId, purpose);
  const minor = isUnderConsentAge(ward.birthDate, limit);
  if (rel.isSelf) {
    // Withdrawing a consent must always be possible for the person themself.
    if (minor && action === "granted") throw new ForbiddenError("Under the age limit: a guardian or the board (with a paper proof) decides", { details: { code: "consent_requires_guardian" } });
    return { givenBy: "self", via: "member" };
  }
  if (rel.link !== null) {
    if (!minor) throw new ForbiddenError("The member is old enough to decide alone", { details: { code: "consent_not_for_guardian" } });
    if (!rel.link.canConsent) throw new ForbiddenError("This guardian link does not allow consenting", { details: { code: "guardian_cannot_consent" } });
    return { givenBy: "guardian", via: "guardian" };
  }
  if (rel.canManage) throw new ValidationError("Recording for somebody else needs the date and the source of the paper proof", { details: { code: "proof_required" } });
  throw new ForbiddenError("Not allowed to decide for this member");
}

async function decide(c: Ctx, action: "granted" | "revoked", body: z.infer<typeof proofSchema> & { textVersionId?: string }) {
  const clubId = c.get("clubId");
  const ward = await clubMemberOf(clubId, c.req.param("id")!);
  const purposeId = c.req.param("purposeId")!;
  const [purpose] = isUuid(purposeId) ? await db.select().from(consentPurposes).where(eq(consentPurposes.id, purposeId)) : [];
  // A foreign club's purpose id answers like an unknown one.
  const own = purpose && purpose.clubId === clubId ? purpose : undefined;
  if (!own) {
    await authorize(c, ward, action, { minAge: null }, body); // the same refusals for callers who may not decide at all
    throw new NotFoundError("Consent purpose not found");
  }
  const who = await authorize(c, ward, action, own, body);
  const result = await db.transaction((tx) =>
    recordConsent(tx, {
      clubId,
      clubMemberId: ward.id,
      purposeId: own.id,
      action,
      givenBy: who.givenBy,
      recordedByUserId: c.get("user").id,
      ...(body.textVersionId !== undefined ? { textVersionId: body.textVersionId } : {}),
      proofDate: body.proofDate ?? null,
      proofSource: body.proofSource ?? null,
      via: who.via,
    }),
  );
  if (action === "revoked") await afterConsentRevoked(result.purpose, ward, c.get("membership").id);
  const [view] = (await memberConsentViews(clubId, ward.id)).filter((v) => v.purposeId === own.id);
  return { changed: result.changed, consent: view ?? null };
}

memberConsentRoutes.post("/:purposeId", zValidator("json", grantSchema, validationHook), async (c) => {
  const out = await decide(c, "granted", c.req.valid("json"));
  return c.json({ data: out.consent }, out.changed ? 201 : 200);
});

/** Revoke (or explicitly decline). The optional JSON body only carries a paper proof of the board. */
memberConsentRoutes.delete("/:purposeId", async (c) => {
  const raw = await c.req.json().catch(() => ({}));
  const parsed = proofSchema.safeParse(raw ?? {});
  if (!parsed.success) throw new ValidationError("Invalid request body", { details: parsed.error.issues });
  const out = await decide(c, "revoked", parsed.data);
  return c.json({ data: out.consent });
});
