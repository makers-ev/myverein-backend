import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { closeDatabase, db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { clubMembers } from "../db/schema/club-members.js";
import { memberCards } from "../db/schema/documents.js";
import { signCardToken } from "../lib/member-cards.js";
import { createClub, dropClubs, installErrorHandler, requester, signUpAndVerify, type Account } from "./forms-test-support.js";
import { memberCardVerifyRoutes } from "./member-card-verify.js";
import { memberCardRoutes } from "./member-cards.js";

/** Wave 13 B13: checking a card -- rights, uniform answer for everything that is not a genuine card of the club, replay, expiry, exit, audit, rate limit. */
const app = new Hono();
app.route("/club-members", memberCardRoutes);
app.route("/member-cards", memberCardVerifyRoutes);
installErrorHandler(app);
const call = requester(app);
const suffix = Date.now();

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed response helper
const body = async (res: Response) => (await res.json()) as any;
const DAY = 86_400_000;

describe("membership card verification", () => {
  let club: Awaited<ReturnType<typeof createClub>>;
  let other: Awaited<ReturnType<typeof createClub>>;
  let guest: Account;
  let plainCm = "";
  let otherPlainCm = "";
  const id = () => club.clubId;

  const verify = (who: Account, token: unknown, clubId = id()) => call(who, "/member-cards/verify", { method: "POST", body: { token }, clubId });
  const tokenOf = async (who: Account, clubId = id()) => (await body(await call(who, "/club-members/me/card", { clubId }))).data.token as string;
  const cardRow = async (clubMemberId: string) => (await db.select().from(memberCards).where(eq(memberCards.clubMemberId, clubMemberId)))[0]!;
  const clubMemberOf = async (a: Account, clubId = id()) => {
    const m = await db.query.member.findFirst({ where: (t, { and: a2, eq: e2 }) => a2(e2(t.organizationId, clubId), e2(t.userId, a.userId)) });
    return (await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, m!.id) }))!.id;
  };

  beforeAll(async () => {
    club = await createClub("vfy", suffix, { trainer: "trainer", beisitzer: "beisitzer", plain: null });
    other = await createClub("vfyo", suffix, { trainer: "trainer", plain: null });
    guest = await signUpAndVerify(`vfy-guest-${suffix}@example.com`, "Guest");
    club.userIds.push(guest.userId);
    await auth.api.addMember({ body: { userId: guest.userId, organizationId: id(), role: "guest" } });
    plainCm = await clubMemberOf(club.members.plain!);
    otherPlainCm = await clubMemberOf(other.members.plain!, other.clubId);
  }, 90_000);

  afterAll(async () => {
    await dropClubs([club.clubId, other.clubId], [...club.userIds, ...other.userIds]);
    await closeDatabase();
  });

  it("is only for members with member_cards:verify of the same club", async () => {
    const token = await tokenOf(club.members.plain!);
    expect((await verify(club.members.plain!, token)).status).toBe(403);
    expect((await verify(guest, token)).status).toBe(403);
    expect((await call(club.members.trainer!, "/member-cards/verify", { method: "POST", body: { token }, clubId: other.clubId })).status).toBe(404);
    expect((await app.request(`/member-cards/verify?clubId=${id()}`, { method: "POST", body: JSON.stringify({ token }), headers: { "content-type": "application/json" } })).status).toBe(401);
    expect((await verify(club.members.trainer!, 42)).status).toBe(422);
    for (const checker of [club.founder, club.members.trainer!, club.members.beisitzer!]) expect((await verify(checker, token)).status).toBe(200);
  });

  it("a valid card shows what is needed to compare the person and nothing else", async () => {
    const token = await tokenOf(club.members.plain!);
    const res = await verify(club.members.trainer!, token);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const data = (await body(res)).data;
    expect(data.result).toBe("gueltig");
    expect(Object.keys(data.member).sort()).toEqual(["category", "displayName", "initials", "photo"]);
    expect(data.member.displayName).toContain("plain");
    expect(data.member.photo).toBeNull();
    const text = JSON.stringify(data);
    for (const leak of ["birthDate", "street", "phone", "email", "memberNumber", "clubMemberId", "cardId"]) expect(text).not.toContain(leak);
  });

  it("answers every forged, foreign or replaced token with the same ungueltig and the same shape", async () => {
    const token = await tokenOf(club.members.plain!);
    const foreign = await tokenOf(other.members.plain!, other.clubId);
    const parts = token.split(".");
    const tampered = [parts[0], parts[1], "9", parts[3], parts[4]].join(".");
    const unknownCard = signCardToken({ id: "11111111-2222-4333-8444-555555555555", tokenVersion: 1, validUntil: null }).token;
    const answers = [] as unknown[];
    for (const t of [foreign, tampered, unknownCard, "garbage", "", token.slice(0, 20)]) {
      const res = await verify(club.members.trainer!, t);
      expect(res.status).toBe(200);
      const data = (await body(res)).data;
      expect(Object.keys(data).sort()).toEqual(["checkedAt", "result"]);
      answers.push(data.result);
    }
    expect(new Set(answers)).toEqual(new Set(["ungueltig"]));
    // The other club's checker sees the foreign token as valid in ITS club and ours as ungueltig.
    expect((await body(await verify(other.members.trainer!, foreign, other.clubId))).data.result).toBe("gueltig");
    expect((await body(await verify(other.members.trainer!, token, other.clubId))).data.result).toBe("ungueltig");
    expect(otherPlainCm).toBeTruthy();
  });

  it("a re-issue kills the old token (replay), the new one works", async () => {
    const old = await tokenOf(club.members.plain!);
    expect((await call(club.founder, `/club-members/${plainCm}/card/reissue`, { method: "POST", body: {}, clubId: id() })).status).toBe(200);
    expect((await body(await verify(club.members.trainer!, old))).data.result).toBe("ungueltig");
    expect((await body(await verify(club.members.trainer!, await tokenOf(club.members.plain!)))).data.result).toBe("gueltig");
  });

  it("an expired token and a passed end date are abgelaufen without showing the person", async () => {
    const card = await cardRow(plainCm);
    const stale = signCardToken(card, new Date(Date.now() - 500 * DAY));
    const res = (await body(await verify(club.members.trainer!, stale.token))).data;
    expect(res).toMatchObject({ result: "abgelaufen" });
    expect(res.member).toBeUndefined();
    await db.update(memberCards).set({ validUntil: "2023-01-01" }).where(eq(memberCards.id, card.id));
    expect((await body(await verify(club.members.trainer!, signCardToken({ ...card, validUntil: null }).token))).data).toEqual(expect.objectContaining({ result: "abgelaufen" }));
    await db.update(memberCards).set({ validUntil: null }).where(eq(memberCards.id, card.id));
  });

  it("an exit ends the card at once, a manual revocation is ungueltig", async () => {
    const token = await tokenOf(club.members.plain!);
    await db.update(clubMembers).set({ status: "ausgetreten", leftAt: "2024-01-01" }).where(eq(clubMembers.id, plainCm));
    const left = (await body(await verify(club.members.trainer!, token))).data;
    expect(left.result).toBe("ausgetreten");
    expect(left.member).toBeUndefined();
    await db.update(clubMembers).set({ status: "aktiv", leftAt: null }).where(eq(clubMembers.id, plainCm));
    await call(club.founder, `/club-members/${plainCm}/card/revoke`, { method: "POST", body: {}, clubId: id() });
    expect((await body(await verify(club.members.trainer!, token))).data.result).toBe("ungueltig");
  });

  it("audits who checked whom, and failed checks without a person", async () => {
    const reissued = await call(club.founder, `/club-members/${plainCm}/card/reissue`, { method: "POST", body: {}, clubId: id() });
    expect(reissued.status).toBe(200);
    const token = await tokenOf(club.members.plain!);
    await verify(club.members.trainer!, token);
    const ok = await db.select().from(auditLog).where(and(eq(auditLog.eventType, "member_card.verify"), eq(auditLog.subjectId, plainCm)));
    expect(ok.length).toBeGreaterThan(0);
    expect(ok[ok.length - 1]!.actorUserId).toBe(club.members.trainer!.userId);
    expect(JSON.stringify(ok[ok.length - 1]!.payload)).not.toContain(token);
    await verify(club.members.trainer!, "garbage-token");
    const failed = await db.select().from(auditLog).where(and(eq(auditLog.eventType, "member_card.verify_failed"), eq(auditLog.subjectId, id())));
    expect(failed.length).toBeGreaterThan(0);
    expect(JSON.stringify(failed)).not.toContain("garbage-token");
  });

  it("limits the checks per person (429) without blocking a colleague", async () => {
    const results: number[] = [];
    for (let i = 0; i < 34; i += 1) results.push((await verify(club.members.beisitzer!, `forged-${i}`)).status);
    expect(results.filter((s) => s === 429).length).toBeGreaterThan(0);
    expect(results.slice(0, 20).every((s) => s === 200)).toBe(true);
    expect((await verify(club.members.trainer!, "forged")).status).toBe(200);
  });
});
