import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { closeDatabase, db } from "../db/client.js";
import { clubMembers } from "../db/schema/club-members.js";
import { documents, memberCards } from "../db/schema/documents.js";
import { guardianLinks } from "../db/schema/guardian-links.js";
import { mediaFiles } from "../db/schema/media-files.js";
import { consentPurposes, consentRecords, consentTexts } from "../db/schema/privacy.js";
import { makePng } from "../lib/media-fixtures.js";
import { CARD_TOKEN_PREFIX, parseCardToken, signCardToken } from "../lib/member-cards.js";
import { replaceMemberPhoto } from "../lib/member-photos.js";
import { transitionMember, todayBerlin } from "../lib/member-lifecycle.js";
import { getTemplate } from "../lib/pdf/registry.js";
import { registerBuiltinTemplates } from "../lib/pdf/templates/index.js";
import { createClub, dropClubs, installErrorHandler, requester, signUpAndVerify, type Account } from "./forms-test-support.js";
import { memberCardRoutes, memberCardSheetRoutes } from "./member-cards.js";

/** Wave 13 B12: membership card -- issue, token, live state, revocation on exit, photo consent, printable PDF, sheets. */
const app = new Hono();
app.route("/club-members", memberCardRoutes);
app.route("/member-cards", memberCardSheetRoutes);
installErrorHandler(app);
const call = requester(app);
const suffix = Date.now();

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed response helper
const body = async (res: Response) => (await res.json()) as any;
const yearsAgo = (n: number) => new Date(Date.now() - n * 365.25 * 86_400_000).toISOString().slice(0, 10);
const isoPlus = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);

describe("membership card", () => {
  let club: Awaited<ReturnType<typeof createClub>>;
  let other: Awaited<ReturnType<typeof createClub>>;
  let guardian: Account;
  let expiredGuardian: Account;
  let plainCm = "";
  let plain2Cm = "";
  let childCm = "";
  const id = () => club.clubId;

  const get = (who: Account, path: string, clubId = id()) => call(who, path, { clubId });
  const send = (who: Account, path: string, method: string, bodyJson?: unknown, clubId = id()) => call(who, path, { method, body: bodyJson, clubId });
  const accountMemberOf = async (a: Account) => (await db.query.member.findFirst({ where: (m, { and: a2, eq: e2 }) => a2(e2(m.organizationId, id()), e2(m.userId, a.userId)) }))!.id;
  const clubMemberOf = async (a: Account) => (await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, await accountMemberOf(a)) }))!.id;
  const join = async (label: string, role: "member" | "guest") => {
    const a = await signUpAndVerify(`card-${label}-${suffix}@example.com`, `Card ${label}`);
    club.userIds.push(a.userId);
    await auth.api.addMember({ body: { userId: a.userId, organizationId: id(), role } });
    return a;
  };

  beforeAll(async () => {
    registerBuiltinTemplates();
    club = await createClub("card", suffix, { trainer: "trainer", plain: null, plain2: null });
    other = await createClub("cardo", suffix);
    plainCm = await clubMemberOf(club.members.plain!);
    plain2Cm = await clubMemberOf(club.members.plain2!);
    guardian = await join("guardian", "guest");
    expiredGuardian = await join("expguardian", "guest");
    const [child] = await db.insert(clubMembers).values({ clubId: id(), displayName: "Kind Ohne Konto", birthDate: yearsAgo(9), joinedAt: "2024-01-01", memberNumber: "K-1" }).returning();
    childCm = child!.id;
    await db.insert(guardianLinks).values({ guardianMemberId: await accountMemberOf(guardian), wardClubMemberId: childCm, confirmedAt: new Date() });
    await db.insert(guardianLinks).values({ guardianMemberId: await accountMemberOf(expiredGuardian), wardClubMemberId: childCm, confirmedAt: new Date(), validUntil: "2020-01-01" });
  }, 90_000);

  afterAll(async () => {
    await dropClubs([club.clubId, other.clubId], [...club.userIds, ...other.userIds]);
    await closeDatabase();
  });

  describe("the token", () => {
    it("is signed, opaque and bound to card id and version; any change makes it worthless", () => {
      const card = { id: "6f1c2f6e-3a9b-4c64-8d54-0a1f6a2b9c10", tokenVersion: 3, validUntil: null };
      const { token, expiresAt } = signCardToken(card, new Date("2026-01-01T00:00:00Z"));
      expect(token.startsWith(`${CARD_TOKEN_PREFIX}.`)).toBe(true);
      expect(token.length).toBeLessThan(80);
      expect(token).not.toContain(card.id);
      expect(parseCardToken(token)).toEqual({ cardId: card.id, version: 3, expiresAt });
      const parts = token.split(".");
      // version bumped, expiry extended, signature cut, prefix changed, truncated, other garbage
      const variants = [
        [parts[0], parts[1], "4", parts[3], parts[4]].join("."),
        [parts[0], parts[1], parts[2], (parseInt(parts[3]!, 36) + 1).toString(36), parts[4]].join("."),
        [parts[0], parts[1], parts[2], parts[3], parts[4]!.slice(0, -1)].join("."),
        ["mc2", ...parts.slice(1)].join("."),
        token.slice(0, -2),
        `${token}.x`,
        "",
        "mc1....",
        "A".repeat(500),
      ];
      for (const v of variants) expect(parseCardToken(v), v).toBeNull();
      for (const v of [null, undefined, 42, {}, []]) expect(parseCardToken(v as never)).toBeNull();
      const flipped = parts[4]![0] === "A" ? "B" : "A";
      expect(parseCardToken([...parts.slice(0, 4), flipped + parts[4]!.slice(1)].join("."))).toBeNull();
    });

    it("is signed with MEMBER_CARD_SECRET: another key rejects it, and the end date of the card limits the lifetime", () => {
      const card = { id: "6f1c2f6e-3a9b-4c64-8d54-0a1f6a2b9c10", tokenVersion: 1, validUntil: null };
      const { token } = signCardToken(card);
      const previous = process.env.MEMBER_CARD_SECRET;
      process.env.MEMBER_CARD_SECRET = "a-completely-different-card-secret-0123456789";
      try {
        expect(parseCardToken(token)).toBeNull();
        const { token: other2 } = signCardToken(card);
        expect(parseCardToken(other2)).not.toBeNull();
      } finally {
        if (previous === undefined) delete process.env.MEMBER_CARD_SECRET;
        else process.env.MEMBER_CARD_SECRET = previous;
      }
      expect(parseCardToken(token)).not.toBeNull();
      const short = signCardToken({ ...card, validUntil: isoPlus(10) }, new Date());
      expect(short.expiresAt.getTime()).toBeLessThan(Date.now() + 12 * 86_400_000);
    });
  });

  describe("issuing and reading", () => {
    it("issues the card on the first look of the member, with a token and no personal data inside it", async () => {
      const res = await get(club.members.plain!, "/club-members/me/card");
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toContain("no-store");
      const data = (await body(res)).data;
      expect(data).toMatchObject({ clubMemberId: plainCm, issued: true, state: "gueltig", photo: null, photoConsent: false });
      expect(data.member.displayName).toContain("plain");
      expect(data.club.name).toContain("Forms card");
      expect(data.token).toMatch(/^mc1\./);
      expect(data.token).not.toContain(data.member.displayName);
      expect(parseCardToken(data.token)).toMatchObject({ cardId: data.cardId, version: 1 });
      const again = (await body(await get(club.members.plain!, "/club-members/me/card"))).data;
      expect(again.cardId).toBe(data.cardId);
      expect(await db.select().from(memberCards).where(eq(memberCards.clubMemberId, plainCm))).toHaveLength(1);
    });

    it("parallel first looks create exactly one card", async () => {
      await Promise.all(Array.from({ length: 6 }, () => get(club.members.plain2!, "/club-members/me/card")));
      expect(await db.select().from(memberCards).where(eq(memberCards.clubMemberId, plain2Cm))).toHaveLength(1);
    });

    it("is for the person, a guardian with a live link and the board; strangers and external guests get 404", async () => {
      expect((await get(club.members.plain!, `/club-members/${plain2Cm}/card`)).status).toBe(404);
      expect((await get(club.members.trainer!, `/club-members/${plain2Cm}/card`)).status).toBe(404);
      expect((await get(other.founder, `/club-members/${plain2Cm}/card`, other.clubId)).status).toBe(404);
      expect((await get(guardian, "/club-members/me/card")).status).toBe(404);
      expect((await get(club.founder, "/club-members/not-a-uuid/card")).status).toBe(404);
      const ward = await get(guardian, `/club-members/${childCm}/card`);
      expect(ward.status).toBe(200);
      expect((await body(ward)).data).toMatchObject({ clubMemberId: childCm, state: "gueltig", member: { displayName: "Kind Ohne Konto" } });
      expect((await get(expiredGuardian, `/club-members/${childCm}/card`)).status).toBe(404);
      const board = await get(club.founder, `/club-members/${plain2Cm}/card`);
      expect((await body(board)).data.state).toBe("gueltig");
    });

    it("the board sees a member without card as not issued and issues it; the others are refused", async () => {
      const [adult] = await db.insert(clubMembers).values({ clubId: id(), displayName: "Ohne Ausweis", joinedAt: "2020-01-01", birthDate: yearsAgo(40) }).returning();
      const memberId = adult!.id;
      const before = (await body(await get(club.founder, `/club-members/${memberId}/card`))).data;
      expect(before).toMatchObject({ issued: false, state: "nicht_ausgestellt", token: null, cardId: null });
      expect((await send(club.members.plain!, `/club-members/${memberId}/card`, "POST", {})).status).toBe(403);
      expect((await send(club.members.trainer!, `/club-members/${memberId}/card`, "POST", {})).status).toBe(403);
      const issued = await send(club.founder, `/club-members/${memberId}/card`, "POST", { validUntil: isoPlus(200) });
      expect(issued.status).toBe(201);
      const card = (await body(issued)).data;
      expect(card).toMatchObject({ issued: true, state: "gueltig", validUntil: isoPlus(200) });
      expect((await send(club.founder, `/club-members/${memberId}/card`, "POST", {})).status).toBe(200);
      expect((await send(other.founder, `/club-members/${memberId}/card`, "POST", {}, other.clubId)).status).toBe(404);
    });
  });

  describe("live state, re-issue and revocation", () => {
    it("a re-issue replaces the token version, a revocation takes the token away, a re-issue brings it back", async () => {
      const first = (await body(await get(club.members.plain2!, "/club-members/me/card"))).data;
      expect((await send(club.members.plain2!, `/club-members/${plain2Cm}/card/reissue`, "POST", {})).status).toBe(403);
      const re = (await body(await send(club.founder, `/club-members/${plain2Cm}/card/reissue`, "POST", {}))).data;
      expect(re.cardId).toBe(first.cardId);
      expect(parseCardToken(re.token)).toMatchObject({ version: 2 });
      expect(re.token).not.toBe(first.token);
      expect((await send(club.members.plain2!, `/club-members/${plain2Cm}/card/revoke`, "POST", {})).status).toBe(403);
      const revoked = (await body(await send(club.founder, `/club-members/${plain2Cm}/card/revoke`, "POST", {}))).data;
      expect(revoked).toMatchObject({ state: "ungueltig", hint: "widerrufen", token: null });
      const own = (await body(await get(club.members.plain2!, "/club-members/me/card"))).data;
      expect(own).toMatchObject({ state: "ungueltig", token: null });
      const back = (await body(await send(club.founder, `/club-members/${plain2Cm}/card/reissue`, "POST", {}))).data;
      expect(back).toMatchObject({ state: "gueltig" });
      expect(parseCardToken(back.token)).toMatchObject({ version: 3 });
    });

    it("parallel re-issues each count: the version is incremented in SQL, none is lost", async () => {
      const before = (await db.select().from(memberCards).where(eq(memberCards.clubMemberId, plainCm)))[0]!.tokenVersion;
      const results = await Promise.all(Array.from({ length: 6 }, () => send(club.founder, `/club-members/${plainCm}/card/reissue`, "POST", {})));
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect((await db.select().from(memberCards).where(eq(memberCards.clubMemberId, plainCm)))[0]!.tokenVersion).toBe(before + 6);
    });

    it("leaving revokes at once, a scheduled exit follows the date, coming back re-issues with a new version", async () => {
      const [person] = await db.insert(clubMembers).values({ clubId: id(), displayName: "Geht Bald", joinedAt: "2020-01-01", birthDate: yearsAgo(30), status: "aktiv" }).returning();
      const pid = person!.id;
      await send(club.founder, `/club-members/${pid}/card`, "POST", {});
      const today = todayBerlin();
      const actor = await accountMemberOf(club.founder);
      // A scheduled exit does not revoke yet, the card is valid until the day.
      await db.transaction((tx) => transitionMember(tx, id(), pid, { toStatus: "ausgetreten", effectiveOn: isoPlus(30), reason: "Kündigung" }, actor, today));
      expect((await body(await get(club.founder, `/club-members/${pid}/card`))).data.state).toBe("gueltig");
      // The date passes without a job having run: the state is derived live.
      await db.update(clubMembers).set({ leftAt: "2020-02-01" }).where(eq(clubMembers.id, pid));
      expect((await body(await get(club.founder, `/club-members/${pid}/card`))).data).toMatchObject({ state: "ausgetreten", token: null });
      await db.update(clubMembers).set({ leftAt: isoPlus(30) }).where(eq(clubMembers.id, pid));
      // An immediate exit revokes the card in the same transaction.
      await db.transaction((tx) => transitionMember(tx, id(), pid, { toStatus: "ausgetreten", effectiveOn: today, reason: "sofort" }, actor, today));
      const [revoked] = await db.select().from(memberCards).where(eq(memberCards.clubMemberId, pid));
      expect(revoked).toMatchObject({ status: "widerrufen", revokedReason: "austritt" });
      expect((await body(await get(club.founder, `/club-members/${pid}/card`))).data).toMatchObject({ state: "ausgetreten", token: null });
      await db.transaction((tx) => transitionMember(tx, id(), pid, { toStatus: "aktiv", reopen: true, reason: "Wiedereintritt" }, actor, today));
      const [again] = await db.select().from(memberCards).where(eq(memberCards.clubMemberId, pid));
      expect(again).toMatchObject({ status: "aktiv", revokedReason: null, tokenVersion: revoked!.tokenVersion + 1 });
      expect((await body(await get(club.founder, `/club-members/${pid}/card`))).data.state).toBe("gueltig");
    });

    it("an end date, a resting membership and a not yet full member are not valid", async () => {
      const [a] = await db.insert(clubMembers).values({ clubId: id(), displayName: "Abgelaufen", joinedAt: "2020-01-01" }).returning();
      await send(club.founder, `/club-members/${a!.id}/card`, "POST", { validUntil: "2023-12-31" });
      expect((await body(await get(club.founder, `/club-members/${a!.id}/card`))).data).toMatchObject({ state: "abgelaufen", token: null });
      const [r] = await db.insert(clubMembers).values({ clubId: id(), displayName: "Ruhend", joinedAt: "2020-01-01", status: "ruhend" }).returning();
      await db.insert(memberCards).values({ clubId: id(), clubMemberId: r!.id });
      expect((await body(await get(club.founder, `/club-members/${r!.id}/card`))).data).toMatchObject({ state: "ungueltig", hint: "ruhend", token: null });
      const [i] = await db.insert(clubMembers).values({ clubId: id(), displayName: "Interessent", joinedAt: "2020-01-01", status: "interessent" }).returning();
      await db.insert(memberCards).values({ clubId: id(), clubMemberId: i!.id });
      expect((await body(await get(club.founder, `/club-members/${i!.id}/card`))).data.state).toBe("ungueltig");
    });
  });

  describe("photo", () => {
    it("shows the photo only with the consent of the person and drops it when the consent is revoked", async () => {
      const row = (await db.select().from(clubMembers).where(eq(clubMembers.id, plainCm)))[0]!;
      await replaceMemberPhoto({ row, file: new File([new Uint8Array(makePng())], "foto.png", { type: "image/png" }), uploadedBy: club.members.plain!.userId, changedBy: club.members.plain!.userId });
      const without = (await body(await get(club.members.plain!, "/club-members/me/card"))).data;
      expect(without.photo).toBeNull();
      expect(without.photoConsent).toBe(false);
      expect(without.member.initials).toBeTruthy();

      // The club's system purpose exists already; give it a published text.
      const [purpose] = await db.select().from(consentPurposes).where(and(eq(consentPurposes.clubId, id()), eq(consentPurposes.key, "profilfoto_ausweis")));
      await db.update(consentPurposes).set({ active: true }).where(eq(consentPurposes.id, purpose!.id));
      const [text] = await db.insert(consentTexts).values({ purposeId: purpose!.id, version: 1, body: "Foto auf dem Ausweis", sha256: "a".repeat(64), publishedAt: new Date() }).onConflictDoUpdate({ target: [consentTexts.purposeId, consentTexts.version], set: { publishedAt: new Date() } }).returning();
      await db.insert(consentRecords).values({ clubId: id(), clubMemberId: plainCm, purposeId: purpose!.id, textVersionId: text!.id, action: "granted", givenBy: "self" });
      const withConsent = (await body(await get(club.members.plain!, "/club-members/me/card"))).data;
      expect(withConsent.photoConsent).toBe(true);
      expect(withConsent.photo.url).toMatch(/\/media\/.+\?exp=\d+&sig=[0-9a-f]{64}$/);
      // The printable card uses the photo as well (consent present); the data of the template carries it.
      const built = await getTemplate("mitgliedsausweis")!.build(id(), { clubMemberId: plainCm, layout: "card" });
      expect((built.data as { photo: Buffer | null }).photo).not.toBeNull();

      await db.insert(consentRecords).values({ clubId: id(), clubMemberId: plainCm, purposeId: purpose!.id, textVersionId: text!.id, action: "revoked", givenBy: "self" });
      expect((await body(await get(club.members.plain!, "/club-members/me/card"))).data.photo).toBeNull();
      expect(((await getTemplate("mitgliedsausweis")!.build(id(), { clubMemberId: plainCm, layout: "card" })).data as { photo: Buffer | null }).photo).toBeNull();
    });
  });

  describe("printable PDF", () => {
    it("delivers the card as PDF (card and A4), never stores it, and follows the same access rules", async () => {
      const docsBefore = (await db.select().from(documents).where(eq(documents.clubId, id()))).length;
      const filesBefore = (await db.select().from(mediaFiles).where(eq(mediaFiles.clubId, id()))).length;
      for (const layout of ["card", "a4"]) {
        const res = await get(club.members.plain!, `/club-members/me/card.pdf?layout=${layout}`);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("application/pdf");
        expect(res.headers.get("cache-control")).toContain("no-store");
        expect(res.headers.get("content-disposition")).toContain("attachment");
        expect(Buffer.from(await res.arrayBuffer()).toString("latin1", 0, 5)).toBe("%PDF-");
      }
      expect((await db.select().from(documents).where(eq(documents.clubId, id()))).length).toBe(docsBefore);
      expect((await db.select().from(mediaFiles).where(eq(mediaFiles.clubId, id()))).length).toBe(filesBefore);
      expect((await get(guardian, `/club-members/${childCm}/card.pdf`)).status).toBe(200);
      expect((await get(club.founder, `/club-members/${plain2Cm}/card.pdf`)).status).toBe(200); // the board prints the card of a member (re-issued above, valid)
    });

    it("refuses strangers, a bad layout and a card that is not valid", async () => {
      expect((await get(club.members.plain!, `/club-members/${childCm}/card.pdf`)).status).toBe(404);
      expect((await get(club.members.plain!, "/club-members/me/card.pdf?layout=poster")).status).toBe(422);
      expect((await get(guardian, "/club-members/me/card.pdf")).status).toBe(404);
    });
  });

  describe("sheet", () => {
    it("prints several cards for the board, issues missing ones, skips people without a valid membership", async () => {
      const [fresh] = await db.insert(clubMembers).values({ clubId: id(), displayName: "Neu Ohne Karte", joinedAt: "2021-01-01" }).returning();
      const [left] = await db.insert(clubMembers).values({ clubId: id(), displayName: "Schon Weg", joinedAt: "2019-01-01", status: "ausgetreten", leftAt: "2022-01-01" }).returning();
      const ok = await send(club.founder, "/member-cards/print", "POST", { clubMemberIds: [fresh!.id, left!.id, plainCm] });
      expect(ok.status).toBe(200);
      expect(Buffer.from(await ok.arrayBuffer()).toString("latin1", 0, 5)).toBe("%PDF-");
      expect(await db.select().from(memberCards).where(and(eq(memberCards.clubMemberId, fresh!.id), eq(memberCards.status, "aktiv")))).toHaveLength(1);
      expect((await send(club.members.plain!, "/member-cards/print", "POST", { clubMemberIds: [plainCm] })).status).toBe(403);
      expect((await send(club.members.trainer!, "/member-cards/print", "POST", { clubMemberIds: [plainCm] })).status).toBe(403);
      expect((await send(club.founder, "/member-cards/print", "POST", { clubMemberIds: ["00000000-0000-4000-8000-000000000001"] })).status).toBe(404);
      expect((await send(club.founder, "/member-cards/print", "POST", { clubMemberIds: [] })).status).toBe(422);
      expect((await send(other.founder, "/member-cards/print", "POST", { clubMemberIds: [plainCm] }, other.clubId)).status).toBe(404);
      expect((await send(club.founder, "/member-cards/print", "POST", { clubMemberIds: [left!.id] })).status).toBe(404);
    });
  });
});
