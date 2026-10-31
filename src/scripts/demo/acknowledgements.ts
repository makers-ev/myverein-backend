import { eq } from "drizzle-orm";

import { db } from "../../db/client.js";
import { documentAcknowledgements, documents, documentVersions } from "../../db/schema/documents.js";
import { writeAudit } from "../../lib/audit.js";
import { endOfLocalDay } from "../../lib/club-time.js";
import { requestRender } from "../../lib/pdf/render.js";
import { ensureCard, reissueCard, revokeCard, findCardOf } from "../../lib/member-cards.js";
import { accountOf, clubMemberOf, shiftDays, type DemoCtx } from "./context.js";
import { demoDocs, principalOf } from "./documents.js";

/**
 * Digital acknowledgements and membership cards (Wave 13). Requests are written the way `POST /acknowledgements/requests` writes
 * them (one row per person and version, exact wording, audit entry); answers the way the person, the guardian or the board
 * (paper proof) would give them. No notification goes out: the in-app / mail dispatch of the route is the only part left out.
 */

async function ask(ctx: DemoCtx, docKey: string, people: string[], opts: { dueInDays?: number; requiresReauth?: boolean; requestedDaysAgo?: number } = {}) {
  const actor = accountOf(ctx, "vorsitz");
  const [doc] = await db.select().from(documents).where(eq(documents.id, demoDocs[docKey]!)).limit(1);
  const [version] = await db.select().from(documentVersions).where(eq(documentVersions.id, doc!.currentVersionId!)).limit(1);
  const requestedAt = new Date(ctx.now.getTime() - (opts.requestedDaysAgo ?? 3) * 86_400_000);
  const dueAt = opts.dueInDays === undefined ? null : endOfLocalDay(shiftDays(ctx.today, opts.dueInDays), "Europe/Berlin");
  const wording = `Ich habe das Dokument „${doc!.title}“ gelesen und bestätige es in der vorliegenden Fassung.`;
  const rows = await db
    .insert(documentAcknowledgements)
    .values(people.map((who) => ({ clubId: ctx.clubId, documentId: doc!.id, versionId: version!.id, sha256: version!.sha256, clubMemberId: clubMemberOf(ctx, who), status: "offen", wording, requestedBy: actor.userId, requestedAt, dueAt, requiresReauth: opts.requiresReauth ?? false })))
    .returning({ id: documentAcknowledgements.id, clubMemberId: documentAcknowledgements.clubMemberId });
  await writeAudit(db, { eventType: "acknowledgement.request", subjectId: doc!.id, actorUserId: actor.userId, clubId: ctx.clubId, payload: { clubId: ctx.clubId, documentId: doc!.id, versionId: version!.id, created: rows.length, renewed: 0, skipped: 0 } });
  const idOf = (who: string) => rows.find((r) => r.clubMemberId === clubMemberOf(ctx, who))!.id;
  return { idOf, doc: doc! };
}

async function answer(ctx: DemoCtx, ackId: string, docId: string, personKey: string, by: { actor: string; givenBy: "self" | "guardian"; status?: "bestaetigt" | "abgelehnt"; hoursAfter?: number }) {
  const actor = accountOf(ctx, by.actor);
  const status = by.status ?? "bestaetigt";
  await db
    .update(documentAcknowledgements)
    .set({ status, respondedAt: new Date(ctx.now.getTime() - (by.hoursAfter ?? 20) * 3_600_000), actedByUserId: actor.userId, actedByClubMemberId: actor.clubMemberId || null, givenBy: by.givenBy })
    .where(eq(documentAcknowledgements.id, ackId));
  await writeAudit(db, { eventType: "acknowledgement.respond", subjectId: clubMemberOf(ctx, personKey), actorUserId: actor.userId, clubId: ctx.clubId, payload: { clubId: ctx.clubId, acknowledgementId: ackId, documentId: docId, status, givenBy: by.givenBy } });
}

export async function seedAcknowledgements(ctx: DemoCtx): Promise<void> {
  const board = accountOf(ctx, "vorsitz");
  // House rules: confirmed by themselves, one confirmed on paper, one expired, the rest still open.
  const house = await ask(ctx, "hausordnung", ["schrift", "trainer", "mitglied", "abtleit", "dieter", "renate"], { dueInDays: 14 });
  await answer(ctx, house.idOf("schrift"), house.doc.id, "schrift", { actor: "schrift", givenBy: "self", hoursAfter: 48 });
  await answer(ctx, house.idOf("trainer"), house.doc.id, "trainer", { actor: "trainer", givenBy: "self", hoursAfter: 30 });
  await db
    .update(documentAcknowledgements)
    .set({ status: "bestaetigt", respondedAt: new Date(ctx.now.getTime() - 24 * 3_600_000), actedByUserId: board.userId, actedByClubMemberId: board.clubMemberId, givenBy: "board_paper", proofDate: shiftDays(ctx.today, -2), proofSource: "Unterschriftenliste Vereinsabend" })
    .where(eq(documentAcknowledgements.id, house.idOf("dieter")));
  await writeAudit(db, { eventType: "acknowledgement.paper", subjectId: clubMemberOf(ctx, "dieter"), actorUserId: board.userId, clubId: ctx.clubId, payload: { clubId: ctx.clubId, acknowledgementId: house.idOf("dieter"), documentId: house.doc.id, status: "bestaetigt" } });
  // The due date of one request has passed: shown as "abgelaufen" (derived, never stored).
  await db.update(documentAcknowledgements).set({ dueAt: new Date(ctx.now.getTime() - 86_400_000) }).where(eq(documentAcknowledgements.id, house.idOf("abtleit")));

  // Holiday camp consent for children: re-authentication required; the guardian answers for one child, the others are open.
  const camp = await ask(ctx, "freizeit", ["noah", "mia", "finn"], { dueInDays: 21, requiresReauth: true, requestedDaysAgo: 2 });
  await answer(ctx, camp.idOf("noah"), camp.doc.id, "noah", { actor: "eltern", givenBy: "guardian", hoursAfter: 10 });

  // Proof PDF of the house rules (stored as a generated document in the system folder "Bestätigungsprotokolle").
  const proof = await requestRender({ clubId: ctx.clubId, templateId: "bestaetigungsprotokoll", params: { documentId: house.doc.id }, actor: await principalOf(ctx, "vorsitz", ["vorsitz"]) });
  if (proof.status !== "fertig") throw new Error(`Demo acknowledgement proof ended as ${proof.status} (${proof.errorCode ?? "no code"})`);
  ctx.log("Bestätigungen: 9 Anfragen (selbst, Erziehungsberechtigte, Papiernachweis, abgelaufen, offen) und Bestätigungsprotokoll");
}

/** Membership cards: issued to a few members, one re-issued, one revoked by the board, one revoked by the exit, and a few checks in the audit log. */
export async function seedMemberCards(ctx: DemoCtx): Promise<void> {
  const board = accountOf(ctx, "vorsitz");
  const issue = async (who: string, via: "board" | "auto") => {
    const card = await db.transaction((tx) => ensureCard(tx, ctx.clubId, clubMemberOf(ctx, who), via === "board" ? board.userId : null));
    await writeAudit(db, { eventType: "member_card.issue", subjectId: clubMemberOf(ctx, who), actorUserId: board.userId, clubId: ctx.clubId, payload: { clubId: ctx.clubId, cardId: card.id, via } });
    return card;
  };
  for (const who of ["vorsitz", "stellv", "kasse", "trainer", "mitglied", "jugend", "noah", "dieter", "uwe"]) await issue(who, who === "mitglied" || who === "noah" ? "auto" : "board");
  const schrift = await issue("schrift", "board");
  const trainer2 = await issue("trainer2", "board");

  // Re-issued after a lost card: the old QR code stops working (token version 2).
  const reissued = await db.transaction((tx) => reissueCard(tx, schrift, board.userId, undefined));
  await writeAudit(db, { eventType: "member_card.reissue", subjectId: clubMemberOf(ctx, "schrift"), actorUserId: board.userId, clubId: ctx.clubId, payload: { clubId: ctx.clubId, cardId: reissued.id, via: "board" } });
  // Revoked by the board.
  await revokeCard(db, clubMemberOf(ctx, "trainer2"), "manuell");
  await writeAudit(db, { eventType: "member_card.revoke", subjectId: clubMemberOf(ctx, "trainer2"), actorUserId: board.userId, clubId: ctx.clubId, payload: { clubId: ctx.clubId, cardId: trainer2.id, via: "board" } });
  // Revoked by the exit of the person (what the lifecycle does).
  await revokeCard(db, clubMemberOf(ctx, "uwe"), "austritt");

  // Checks at the entrance (what `POST /member-cards/verify` writes): three genuine results, one replaced token.
  const checker = accountOf(ctx, "trainer");
  const mitglied = await findCardOf(clubMemberOf(ctx, "mitglied"));
  const check = (eventType: "member_card.verify" | "member_card.verify_failed", subjectId: string, payload: Record<string, unknown>) =>
    writeAudit(db, { eventType, subjectId, actorUserId: checker.userId, clubId: ctx.clubId, payload: { clubId: ctx.clubId, ...payload } });
  await check("member_card.verify", clubMemberOf(ctx, "mitglied"), { cardId: mitglied!.id, result: "gueltig" });
  await check("member_card.verify", clubMemberOf(ctx, "jugend"), { cardId: (await findCardOf(clubMemberOf(ctx, "jugend")))!.id, result: "gueltig" });
  await check("member_card.verify", clubMemberOf(ctx, "trainer2"), { cardId: trainer2.id, result: "ungueltig" });
  await check("member_card.verify_failed", ctx.clubId, {});
  ctx.log("Mitgliedsausweise: 11 ausgestellt, 1 neu ausgestellt, 1 vom Vorstand gesperrt, 1 durch Austritt widerrufen, 4 Prüfungen im Protokoll");
}
