import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { member, organization, user } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { clubMemberDepartments, clubMembers, memberCategories } from "../db/schema/club-members.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { pushTokens } from "../db/schema/communication.js";
import { departments } from "../db/schema/departments.js";
import { guardianLinks } from "../db/schema/guardian-links.js";
import {
  AudienceLimitError,
  normalizeEmail,
  resolveAudience,
  resolveClubAudience,
  summarizeAudience,
  type AudienceCandidate,
} from "./audience.js";

const TODAY = "2026-10-18";

let seq = 0;
const cand = (over: Partial<AudienceCandidate> = {}): AudienceCandidate => {
  seq += 1;
  return {
    clubMemberId: `cm-${seq}`,
    accountMemberId: null,
    userId: null,
    displayName: `Person ${seq}`,
    firstName: null,
    status: "aktiv",
    leftAt: null,
    accountEmail: null,
    contactEmail: null,
    departmentIds: [],
    categoryKey: null,
    roleTypes: [],
    guardianOf: [],
    pushTokenCount: 0,
    ...over,
  };
};
const account = (over: Partial<AudienceCandidate> = {}) => {
  const n = seq + 1;
  return cand({ accountMemberId: `acc-${n}`, userId: `user-${n}`, accountEmail: `user${n}@example.test`, ...over });
};
const keys = (c: AudienceCandidate[], a: Parameters<typeof resolveAudience>[0], o = {}) =>
  resolveAudience(a, c, { today: TODAY, ...o }).recipients.map((r) => r.clubMemberId ?? r.key);

describe("resolveAudience (pure)", () => {
  it("matches nobody for an empty definition (deny by default)", () => {
    expect(keys([account(), cand({ contactEmail: "a@example.test" })], {})).toEqual([]);
    expect(keys([account()], { all: false, departmentIds: [], memberIds: [] })).toEqual([]);
  });

  it("all = every club member, not bare accounts", () => {
    const a = account();
    const child = cand({ contactEmail: "kid@example.test" });
    const bare = account({ clubMemberId: null });
    expect(keys([a, child, bare], { all: true, includeGuardians: false })).toEqual([a.clubMemberId, child.clubMemberId]);
  });

  it("is the union of department, role, category and explicit members", () => {
    const inDept = account({ departmentIds: ["d1"] });
    const trainer = account({ roleTypes: ["trainer"] });
    const cat = cand({ categoryKey: "jugend", contactEmail: "j@example.test" });
    const single = cand({ contactEmail: "s@example.test" });
    const other = account({ departmentIds: ["d2"], roleTypes: ["kassenwart"], categoryKey: "aktiv" });
    const all = [inDept, trainer, cat, single, other];
    expect(keys(all, { departmentIds: ["d1"] })).toEqual([inDept.clubMemberId]);
    expect(keys(all, { roleTypes: ["trainer"] })).toEqual([trainer.clubMemberId]);
    expect(keys(all, { categoryKeys: ["jugend"] })).toEqual([cat.clubMemberId]);
    expect(keys(all, { memberIds: [single.clubMemberId!] })).toEqual([single.clubMemberId]);
    expect(keys(all, { departmentIds: ["d1"], roleTypes: ["trainer"], categoryKeys: ["jugend"], memberIds: [single.clubMemberId!] }).sort()).toEqual(
      [inDept, trainer, cat, single].map((c) => c.clubMemberId).sort(),
    );
  });

  it("role filter only applies to accounts", () => {
    const accountless = cand({ roleTypes: ["trainer"], contactEmail: "x@example.test" });
    expect(keys([accountless], { roleTypes: ["trainer"] })).toEqual([]);
  });

  it("excludes dormant, left and past-left_at members, also when addressed explicitly", () => {
    const ruhend = account({ status: "ruhend" });
    const gone = account({ status: "ausgetreten" });
    const expelled = account({ status: "ausgeschlossen" });
    const dead = account({ status: "verstorben" });
    const leavingPast = account({ leftAt: "2026-10-01" });
    const leavingFuture = account({ leftAt: "2026-12-31" });
    const probe = account({ status: "probe" });
    const all = [ruhend, gone, expelled, dead, leavingPast, leavingFuture, probe];
    const expected = [leavingFuture.clubMemberId, probe.clubMemberId];
    expect(keys(all, { all: true })).toEqual(expected);
    expect(keys(all, { memberIds: all.map((c) => c.clubMemberId!) })).toEqual(expected);
  });

  it("reaches account-less members by contact e-mail only", () => {
    const withMail = cand({ contactEmail: " Kid@Example.test " });
    const noMail = cand();
    const badMail = cand({ contactEmail: "not an address" });
    const { recipients } = resolveAudience({ all: true }, [withMail, noMail, badMail], { today: TODAY });
    const byId = new Map(recipients.map((r) => [r.clubMemberId, r]));
    expect(byId.get(withMail.clubMemberId)).toMatchObject({ email: "kid@example.test", channels: { inApp: false, email: true, push: false } });
    expect(byId.get(noMail.clubMemberId)).toMatchObject({ email: null, channels: { inApp: false, email: false, push: false } });
    expect(byId.get(badMail.clubMemberId)?.channels.email).toBe(false);
    expect(summarizeAudience(recipients, ["in_app", "email"])).toMatchObject({ total: 3, reachable: 1, email: 1, emailOnly: 1, unreachable: 2, inApp: 0 });
  });

  it("uses the account e-mail for account holders and flags push only with a token", () => {
    const a = account({ pushTokenCount: 2, contactEmail: "other@example.test" });
    const b = account();
    const { recipients } = resolveAudience({ all: true }, [a, b], { today: TODAY });
    expect(recipients.find((r) => r.clubMemberId === a.clubMemberId)).toMatchObject({ email: a.accountEmail, channels: { inApp: true, email: true, push: true } });
    expect(recipients.find((r) => r.clubMemberId === b.clubMemberId)?.channels.push).toBe(false);
  });

  it("adds guardians of matched wards by default and not when disabled", () => {
    const child = cand({ departmentIds: ["d1"], contactEmail: "kid@example.test" });
    const guardian = account({ guardianOf: [child.clubMemberId!] });
    const bareGuardian = account({ clubMemberId: null, guardianOf: [child.clubMemberId!] });
    const unrelated = account({ clubMemberId: null });
    const all = [child, guardian, bareGuardian, unrelated];
    const res = resolveAudience({ departmentIds: ["d1"] }, all, { today: TODAY }).recipients;
    expect(res.map((r) => [r.key, r.via])).toEqual([
      [child.clubMemberId, "direct"],
      [guardian.clubMemberId, "guardian"],
      [`acct:${bareGuardian.accountMemberId}`, "guardian"],
    ]);
    expect(keys(all, { departmentIds: ["d1"], includeGuardians: false })).toEqual([child.clubMemberId]);
  });

  it("does not add guardians of excluded wards or exited guardians", () => {
    const leftChild = cand({ status: "ausgetreten", departmentIds: ["d1"] });
    const exitedGuardian = account({ status: "ausgetreten" });
    const child = cand({ departmentIds: ["d1"] });
    const guardianOfLeft = account({ guardianOf: [leftChild.clubMemberId!] });
    const withExited = { ...exitedGuardian, guardianOf: [child.clubMemberId!] };
    expect(keys([leftChild, child, guardianOfLeft, withExited], { departmentIds: ["d1"] })).toEqual([child.clubMemberId]);
  });

  it("deduplicates a person matched by several rules and a guardian matched twice", () => {
    const a = account({ departmentIds: ["d1"], roleTypes: ["trainer"], categoryKey: "aktiv" });
    const kid1 = cand({ departmentIds: ["d1"], contactEmail: "k1@example.test" });
    const kid2 = cand({ departmentIds: ["d1"], contactEmail: "k2@example.test" });
    const parent = account({ guardianOf: [kid1.clubMemberId!, kid2.clubMemberId!] });
    const res = keys([a, a, kid1, kid2, parent], { departmentIds: ["d1"], roleTypes: ["trainer"], categoryKeys: ["aktiv"], memberIds: [a.clubMemberId!] });
    expect(res.filter((k) => k === a.clubMemberId)).toHaveLength(1);
    expect(res.filter((k) => k === parent.clubMemberId)).toHaveLength(1);
    expect(res).toHaveLength(4);
  });

  it("gives a shared family address to one person only, preferring account holders", () => {
    const parent = account({ accountEmail: "family@example.test", guardianOf: [] });
    const kid = cand({ contactEmail: "Family@Example.test", departmentIds: ["d1"] });
    parent.guardianOf = [kid.clubMemberId!];
    const kid2 = cand({ contactEmail: "family@example.test", departmentIds: ["d1"] });
    const { recipients } = resolveAudience({ departmentIds: ["d1"] }, [kid, kid2, parent], { today: TODAY });
    const mails = recipients.filter((r) => r.email !== null);
    expect(mails).toHaveLength(1);
    expect(mails[0]?.clubMemberId).toBe(parent.clubMemberId);
    for (const r of recipients.filter((x) => x.clubMemberId !== parent.clubMemberId)) {
      expect(r.channels.email).toBe(false);
      expect(r.emailCoveredBy).toBe(parent.clubMemberId);
    }
    const summary = summarizeAudience(recipients, ["in_app", "email"]);
    expect(summary).toMatchObject({ total: 3, email: 1, inApp: 1, sharedAddress: 2, unreachable: 0, reachable: 3 });
  });

  it("is deterministic regardless of candidate order", () => {
    const a = cand({ contactEmail: "same@example.test" });
    const b = cand({ contactEmail: "same@example.test" });
    const first = resolveAudience({ all: true }, [a, b], { today: TODAY }).recipients.find((r) => r.email)?.key;
    const second = resolveAudience({ all: true }, [b, a], { today: TODAY }).recipients.find((r) => r.email)?.key;
    expect(first).toBe(second);
  });

  it("enforces the hard upper limit on persons after deduplication", () => {
    const many = Array.from({ length: 6 }, () => account());
    expect(() => resolveAudience({ all: true }, many, { today: TODAY, limit: 5 })).toThrow(AudienceLimitError);
    expect(resolveAudience({ all: true }, many, { today: TODAY, limit: 6 }).recipients).toHaveLength(6);
    const dup = account();
    expect(resolveAudience({ all: true }, [dup, dup, ...many.slice(0, 4)], { today: TODAY, limit: 5 }).recipients).toHaveLength(5);
    try {
      resolveAudience({ all: true }, many, { today: TODAY, limit: 2 });
    } catch (err) {
      expect(err).toMatchObject({ size: 6, limit: 2 });
    }
  });

  it("summarises only the requested channels", () => {
    const a = account({ pushTokenCount: 1 });
    const kid = cand({ contactEmail: "k@example.test" });
    const { recipients } = resolveAudience({ all: true }, [a, kid], { today: TODAY });
    expect(summarizeAudience(recipients, ["in_app"])).toMatchObject({ total: 2, reachable: 1, inApp: 1, email: 0, unreachable: 1 });
    expect(summarizeAudience(recipients, ["in_app", "email", "push"])).toMatchObject({ reachable: 2, inApp: 1, email: 2, push: 1, emailOnly: 1, unreachable: 0 });
  });

  it("normalizes e-mail addresses and rejects header-injection attempts", () => {
    expect(normalizeEmail("  A@B.de ")).toBe("a@b.de");
    expect(normalizeEmail("a@b.de\nBcc: x@y.de")).toBeNull();
    expect(normalizeEmail("a b@c.de")).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
  });
});

describe("resolveClubAudience (DB loader)", () => {
  const sfx = randomUUID().slice(0, 8);
  const clubA = `aud-a-${sfx}`;
  const clubB = `aud-b-${sfx}`;
  const userIds: string[] = [];
  const ids: Record<string, string> = {};

  async function mkUser(label: string): Promise<string> {
    const id = `aud-${label}-${sfx}`;
    await db.insert(user).values({ id, name: label, email: `${id}@example.test`, emailVerified: true });
    userIds.push(id);
    return id;
  }

  beforeAll(async () => {
    await db.insert(organization).values([
      { id: clubA, name: "Club A", slug: clubA, createdAt: new Date() },
      { id: clubB, name: "Club B", slug: clubB, createdAt: new Date() },
    ]);
    const [dept] = await db.insert(departments).values({ clubId: clubA, name: "Jugend" }).returning();
    const [deptB] = await db.insert(departments).values({ clubId: clubB, name: "Fremd" }).returning();
    const [cat] = await db.insert(memberCategories).values({ clubId: clubA, key: "jugend", name: "Jugend" }).returning();

    const trainerUser = await mkUser("trainer");
    const guardianUser = await mkUser("guardian");
    const otherUser = await mkUser("other");
    const bareUser = await mkUser("bare");
    for (const [label, userId, org] of [
      ["trainer", trainerUser, clubA],
      ["guardian", guardianUser, clubA],
      ["other", otherUser, clubB],
      ["bare", bareUser, clubA],
    ] as const) {
      await db.insert(member).values({ id: `aud-m-${label}-${sfx}`, organizationId: org, userId, role: "member", createdAt: new Date() });
    }
    await db.insert(clubRoles).values({ memberId: `aud-m-trainer-${sfx}`, roleType: "trainer", departmentId: dept!.id });
    await db.insert(clubRoles).values({ memberId: `aud-m-bare-${sfx}`, roleType: "erziehungsberechtigt" });
    await db.insert(pushTokens).values({ userId: trainerUser, token: `ExponentPushToken[${sfx}]`, platform: "ios" });

    const rows = await db
      .insert(clubMembers)
      .values([
        { clubId: clubA, memberId: `aud-m-trainer-${sfx}`, displayName: "Trainer", joinedAt: "2020-01-01" },
        { clubId: clubA, memberId: `aud-m-guardian-${sfx}`, displayName: "Guardian", joinedAt: "2020-01-01" },
        { clubId: clubA, displayName: "Kind", contactEmail: "kind@example.test", categoryId: cat!.id, joinedAt: "2020-01-01" },
        { clubId: clubA, displayName: "Ruhend", status: "ruhend", contactEmail: "r@example.test", categoryId: cat!.id, joinedAt: "2020-01-01" },
        { clubId: clubA, displayName: "Alt", contactEmail: "alt@example.test", categoryId: cat!.id, joinedAt: "2020-01-01", leftAt: "2021-01-01" },
        { clubId: clubB, memberId: `aud-m-other-${sfx}`, displayName: "Other club", joinedAt: "2020-01-01" },
      ])
      .returning();
    for (const r of rows) ids[r.displayName] = r.id;
    await db.insert(clubMemberDepartments).values([
      { clubMemberId: ids.Kind!, departmentId: dept!.id },
      { clubMemberId: ids.Ruhend!, departmentId: dept!.id },
    ]);
    // a department of ANOTHER club must never match, even if a row points at it
    await db.insert(clubMemberDepartments).values({ clubMemberId: ids["Other club"]!, departmentId: deptB!.id });
    await db.insert(guardianLinks).values({ guardianMemberId: `aud-m-guardian-${sfx}`, wardClubMemberId: ids.Kind! });
    ids.dept = dept!.id;
    ids.deptB = deptB!.id;
  });

  afterAll(async () => {
    await db.delete(organization).where(eq(organization.id, clubA));
    await db.delete(organization).where(eq(organization.id, clubB));
    for (const id of userIds) await db.delete(user).where(eq(user.id, id));
  });

  const names = async (audience: Parameters<typeof resolveClubAudience>[1], clubId = clubA) =>
    (await resolveClubAudience(clubId, audience)).recipients.map((r) => r.displayName).sort();

  it("resolves all members of the club only, without dormant and left members", async () => {
    expect(await names({ all: true, includeGuardians: false })).toEqual(["Guardian", "Kind", "Trainer"]);
    expect(await names({ all: true }, clubB)).toEqual(["Other club"]);
  });

  it("filters by department, category, role and explicit ids; foreign ids resolve to nothing", async () => {
    expect(await names({ departmentIds: [ids.dept!], includeGuardians: false })).toEqual(["Kind"]);
    expect(await names({ categoryKeys: ["jugend"], includeGuardians: false })).toEqual(["Kind"]);
    expect(await names({ roleTypes: ["trainer"] })).toEqual(["Trainer"]);
    expect(await names({ memberIds: [ids["Other club"]!] })).toEqual([]);
    expect(await names({ departmentIds: [ids.deptB!] })).toEqual([]);
  });

  it("adds linked guardians, reachability comes from the account and push tokens", async () => {
    const { recipients } = await resolveClubAudience(clubA, { departmentIds: [ids.dept!] });
    expect(recipients.map((r) => [r.displayName, r.via]).sort()).toEqual([["Guardian", "guardian"], ["Kind", "direct"]]);
    const kind = recipients.find((r) => r.displayName === "Kind")!;
    expect(kind.channels).toEqual({ inApp: false, email: true, push: false });
    expect(recipients.find((r) => r.displayName === "Guardian")?.channels).toMatchObject({ inApp: true, email: true });
    const trainer = (await resolveClubAudience(clubA, { roleTypes: ["trainer"] })).recipients[0]!;
    expect(trainer.channels).toEqual({ inApp: true, email: true, push: true });
  });

  it("reaches accounts without a club_members row through their role", async () => {
    const { recipients } = await resolveClubAudience(clubA, { roleTypes: ["erziehungsberechtigt"] });
    expect(recipients).toHaveLength(1);
    expect(recipients[0]).toMatchObject({ clubMemberId: null, channels: { inApp: true, email: true } });
  });
});
