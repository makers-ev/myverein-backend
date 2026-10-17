import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { closeDatabase, db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { clubMembers } from "../db/schema/club-members.js";
import { memberFieldDefinitions, memberFieldValues } from "../db/schema/forms.js";
import { guardianLinks } from "../db/schema/guardian-links.js";
import { clubMemberRoutes } from "./club-members.js";
import { createClub, dropClubs, installErrorHandler, requester, signUpAndVerify, type Account } from "./forms-test-support.js";
import { memberFieldRoutes } from "./member-fields.js";

/**
 * Guardians (Erziehungsberechtigte) maintain the custom fields of their children: an active guardian link grants read and
 * write of the fields with editable_by = self (never sensitive ones, never other children, never after the link ended).
 */

const app = new Hono();
app.route("/club-members", clubMemberRoutes);
app.route("/member-fields", memberFieldRoutes);
installErrorHandler(app);
const call = requester(app);
const suffix = Date.now();

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed response helper
const body = async (res: Response) => (await res.json()) as any;

describe("guardian access to the custom fields of a child", () => {
  let club: Awaited<ReturnType<typeof createClub>>;
  let guardian: Account;
  let guardianAccountId: string;
  let childId: string;
  let otherChildId: string;
  let gmemberAccountId: string;
  const accountOf = async (userId: string) => (await db.query.member.findFirst({ where: (m, { and: both, eq: same }) => both(same(m.organizationId, cid()), same(m.userId, userId)) }))!.id;
  const cid = () => club.clubId;
  const board = () => club.founder;
  const cred = { valid: true, validUntil: "2099-01-01" };

  const view = async (who: Account, memberId = childId) => call(who, `/club-members/${memberId}/custom-fields`, { clubId: cid() });
  const write = (who: Account, values: Record<string, unknown>, memberId = childId, method = "PUT") => call(who, `/club-members/${memberId}/custom-fields`, { method, clubId: cid(), body: { values } });
  const fieldsOf = async (res: Response) => (await body(res)).data.fields as Array<{ key: string; value: unknown; editable: boolean; enteredBy: string | null }>;
  const activate = (id: string) => call(board(), `/member-fields/catalog/${id}/activate`, { method: "POST", clubId: cid() });
  const link = async (ward: string) => db.insert(guardianLinks).values({ guardianMemberId: guardianAccountId, wardClubMemberId: ward });

  beforeAll(async () => {
    club = await createClub("gcf", suffix, { plain: null, gmember: null, kid: null });
    guardian = await signUpAndVerify(`gcf-guardian-${suffix}@example.com`, "Guardian gcf");
    await auth.api.addMember({ body: { userId: guardian.userId, organizationId: cid(), role: "guest" } });
    club.userIds.push(guardian.userId);
    guardianAccountId = await accountOf(guardian.userId);
    gmemberAccountId = await accountOf(club.members.gmember!.userId);
    const mk = async (name: string) => { const r = await call(board(), "/club-members", { method: "POST", clubId: cid(), body: { displayName: name, firstName: name, lastName: "Kind", categoryKey: "jugend" } }); const j = await body(r); if (!j.data) throw new Error(JSON.stringify(j)); return j.data.id as string; };
    childId = await mk("Emma");
    otherChildId = await mk("Paul");
    await link(childId);
    for (const id of ["mod_sp_trikot", "mod_q_juleica", "mod_ks_fuehrungszeugnis"]) expect([200, 201]).toContain((await activate(id)).status);
  }, 120_000);

  afterAll(async () => {
    await dropClubs([club.clubId], club.userIds);
    await closeDatabase();
  });

  it("lets the guardian read the child's self-editable fields, but not the sensitive one", async () => {
    const res = await view(guardian);
    expect(res.status).toBe(200);
    const fields = await fieldsOf(res);
    expect(fields.map((f) => f.key).sort()).toEqual(["mod_q_juleica", "mod_sp_trikot"]);
    expect(fields.every((f) => f.editable)).toBe(true);
  });

  it("lets the guardian write a field and a credential (PUT and PATCH), reported as enteredBy guardian, audited", async () => {
    expect((await write(guardian, { mod_sp_trikot: "152" })).status).toBe(200);
    const res = await write(guardian, { mod_q_juleica: cred }, childId, "PATCH");
    expect(res.status).toBe(200);
    const fields = await fieldsOf(res);
    expect(fields.find((f) => f.key === "mod_sp_trikot")).toMatchObject({ value: 152, enteredBy: "guardian" });
    expect(fields.find((f) => f.key === "mod_q_juleica")).toMatchObject({ value: cred, enteredBy: "guardian" });
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.eventType, "member_field.write"), eq(auditLog.subjectId, childId)));
    expect(audits.length).toBeGreaterThanOrEqual(2);
    expect(audits.at(-1)!.payload).toMatchObject({ clubMemberId: childId, changedBy: guardianAccountId, via: "guardian" });
    expect(JSON.stringify(audits)).not.toContain("152");
    // The board sees who entered it; a board overwrite resets the marker.
    expect((await fieldsOf(await view(board()))).find((f) => f.key === "mod_sp_trikot")!.enteredBy).toBe("guardian");
    expect((await write(board(), { mod_sp_trikot: "164" })).status).toBe(200);
    expect((await fieldsOf(await view(board()))).find((f) => f.key === "mod_sp_trikot")!.enteredBy).toBe("board");
  });

  it("refuses sensitive fields (unknown to the guardian) and validates values", async () => {
    const res = await write(guardian, { mod_ks_fuehrungszeugnis: cred });
    expect(res.status).toBe(422);
    expect((await write(guardian, { mod_sp_trikot: "nonsense" })).status).toBe(422);
    // Even a stored sensitive value stays hidden.
    expect((await write(board(), { mod_ks_fuehrungszeugnis: cred })).status).toBe(200);
    expect((await fieldsOf(await view(guardian))).map((f) => f.key)).not.toContain("mod_ks_fuehrungszeugnis");
  });

  it("refuses fields that only the board may edit", async () => {
    const created = await call(board(), "/member-fields", { method: "POST", clubId: cid(), body: { key: "board_only", label: "Intern", type: "text", visibleTo: "mitglied", editableBy: "vorstand" } });
    expect(created.status).toBe(201);
    expect((await write(guardian, { board_only: "x" })).status).toBe(403); // visible to members, but only the board writes it
    expect((await write(board(), { board_only: "visible" })).status).toBe(200);
    expect((await write(guardian, { board_only: "x" })).status).toBe(403);
    const f = (await fieldsOf(await view(guardian))).find((x) => x.key === "board_only")!;
    expect(f).toMatchObject({ value: "visible", editable: false });
  });

  it("hides board-internal fields (visible_to vorstand / funktionstraeger) from the guardian, label and key included", async () => {
    for (const [key, visibleTo] of [["internal_vorstand", "vorstand"], ["internal_ft", "funktionstraeger"]] as const) {
      expect((await call(board(), "/member-fields", { method: "POST", clubId: cid(), body: { key, label: `Geheim ${key}`, type: "text", visibleTo, editableBy: "vorstand" } })).status).toBe(201);
      expect((await write(board(), { [key]: "intern" })).status).toBe(200);
      const res = await view(guardian);
      expect(JSON.stringify(await body(res))).not.toContain(key);
      expect((await write(guardian, { [key]: "x" })).status).toBe(422);
    }
  });

  it("refuses an archived field", async () => {
    expect((await call(board(), "/member-fields", { method: "POST", clubId: cid(), body: { key: "old_one", label: "Alt", type: "text", visibleTo: "mitglied", editableBy: "self" } })).status).toBe(201);
    expect((await write(guardian, { old_one: "x" })).status).toBe(200);
    await db.update(memberFieldDefinitions).set({ archivedAt: new Date() }).where(and(eq(memberFieldDefinitions.clubId, cid()), eq(memberFieldDefinitions.key, "old_one")));
    expect((await write(guardian, { old_one: "y" })).status).toBe(422);
    expect((await fieldsOf(await view(guardian))).map((f) => f.key)).not.toContain("old_one");
    expect((await call(guardian, `/club-members/${childId}/custom-fields?includeArchived=true`, { clubId: cid() })).status).toBe(403);
  });

  it("answers 403 before validating the body for a caller who is no guardian", async () => {
    const plain = club.members.plain!;
    for (const method of ["PUT", "PATCH"]) {
      expect((await call(plain, `/club-members/${childId}/custom-fields`, { method, clubId: cid(), body: { nonsense: true } })).status).toBe(403);
      expect((await call(guardian, `/club-members/${otherChildId}/custom-fields`, { method, clubId: cid(), body: { nonsense: true } })).status).toBe(403);
    }
  });

  it("shows the credential overview entry as guardian to the board and keeps the overview closed to the guardian", async () => {
    const res = await call(board(), "/club-members/credentials?fieldKey=mod_q_juleica", { clubId: cid() });
    expect(res.status).toBe(200);
    const row = (await body(res)).data.find((r: { clubMemberId: string }) => r.clubMemberId === childId);
    expect(row).toMatchObject({ fieldKey: "mod_q_juleica", enteredBy: "guardian" });
    expect((await call(guardian, "/club-members/credentials", { clubId: cid() })).status).toBe(403);
  });

  it("works for a guardian with a regular (non-guest) membership, still without sensitive fields", async () => {
    const g = club.members.gmember!;
    await db.insert(guardianLinks).values({ guardianMemberId: gmemberAccountId, wardClubMemberId: childId });
    expect((await fieldsOf(await view(g))).map((f) => f.key)).not.toContain("mod_ks_fuehrungszeugnis");
    expect((await write(g, { mod_sp_trikot: "128" })).status).toBe(200);
    expect((await fieldsOf(await view(board()))).find((f) => f.key === "mod_sp_trikot")!.enteredBy).toBe("guardian");
    expect((await write(g, { mod_ks_fuehrungszeugnis: cred })).status).toBe(422);
    await db.delete(guardianLinks).where(eq(guardianLinks.guardianMemberId, gmemberAccountId));
  });

  it("treats a guardian who is also on the board as the board (enteredBy board, sensitive writable)", async () => {
    const founderAccountId = await accountOf(board().userId);
    await db.insert(guardianLinks).values({ guardianMemberId: founderAccountId, wardClubMemberId: childId });
    expect((await write(board(), { mod_ks_fuehrungszeugnis: cred, mod_sp_trikot: "140" })).status).toBe(200);
    const fields = await fieldsOf(await view(board()));
    expect(fields.find((f) => f.key === "mod_sp_trikot")!.enteredBy).toBe("board");
    expect(fields.find((f) => f.key === "mod_ks_fuehrungszeugnis")).toMatchObject({ value: cred, enteredBy: "board" });
    const [stored] = await db.select().from(memberFieldValues).where(eq(memberFieldValues.updatedBy, founderAccountId));
    expect(stored!.enteredVia).toBeNull();
    await db.delete(guardianLinks).where(eq(guardianLinks.guardianMemberId, founderAccountId));
  });

  it("does not let a guardian link from another club reach a ward here", async () => {
    const foreign = await createClub("gcfo", suffix);
    try {
      const foreignAccount = (await db.query.member.findFirst({ where: (m, { and: both, eq: same }) => both(same(m.organizationId, foreign.clubId), same(m.userId, foreign.founder.userId)) }))!.id;
      await db.insert(guardianLinks).values({ guardianMemberId: foreignAccount, wardClubMemberId: childId });
      expect((await call(foreign.founder, `/club-members/${childId}/custom-fields`, { clubId: foreign.clubId })).status).toBe(404);
      expect((await call(foreign.founder, `/club-members/${childId}/custom-fields`, { method: "PUT", clubId: foreign.clubId, body: { values: { mod_sp_trikot: "152" } } })).status).toBe(404);
    } finally {
      await dropClubs([foreign.clubId], foreign.userIds);
    }
  });

  it("resets the guardian marker when the child itself writes the value", async () => {
    const kid = club.members.kid!;
    const mine = await body(await call(kid, "/club-members/me/custom-fields", { clubId: cid() }));
    const kidRowId = mine.data.clubMemberId as string;
    await db.insert(guardianLinks).values({ guardianMemberId: guardianAccountId, wardClubMemberId: kidRowId });
    expect((await write(guardian, { mod_sp_trikot: "116" }, kidRowId)).status).toBe(200);
    expect((await fieldsOf(await call(kid, "/club-members/me/custom-fields", { clubId: cid() }))).find((f) => f.key === "mod_sp_trikot")!.enteredBy).toBe("guardian");
    expect((await call(kid, "/club-members/me/custom-fields", { method: "PATCH", clubId: cid(), body: { values: { mod_sp_trikot: "128" } } })).status).toBe(200);
    expect((await fieldsOf(await call(kid, "/club-members/me/custom-fields", { clubId: cid() }))).find((f) => f.key === "mod_sp_trikot")).toMatchObject({ value: 128, enteredBy: "self" });
    const [row] = await db.select().from(memberFieldValues).where(eq(memberFieldValues.clubMemberId, kidRowId));
    expect(row!.enteredVia).toBeNull();
  });

  it("denies a guardian once the ward has left the club", async () => {
    const left = (await body(await call(board(), "/club-members", { method: "POST", clubId: cid(), body: { displayName: "Lena", firstName: "Lena", lastName: "Kind", categoryKey: "jugend" } }))).data.id as string;
    await db.insert(guardianLinks).values({ guardianMemberId: guardianAccountId, wardClubMemberId: left });
    expect((await view(guardian, left)).status).toBe(200);
    await db.update(clubMembers).set({ status: "ausgetreten", leftAt: "2020-01-01" }).where(eq(clubMembers.id, left));
    expect((await view(guardian, left)).status).toBe(404);
    expect((await write(guardian, { mod_sp_trikot: "152" }, left)).status).toBe(403);
  });

  it("never reaches other children", async () => {
    expect((await view(guardian, otherChildId)).status).toBe(404);
    expect((await write(guardian, { mod_sp_trikot: "152" }, otherChildId)).status).toBe(403);
    expect((await write(guardian, { mod_sp_trikot: "152" }, "00000000-0000-0000-0000-000000000000")).status).toBe(403);
  });

  it("denies a plain member who is no guardian", async () => {
    const plain = club.members.plain!;
    expect((await write(plain, { mod_sp_trikot: "152" })).status).toBe(403);
    expect((await write(plain, { mod_sp_trikot: "152" }, childId, "PATCH")).status).toBe(403);
  });

  it("denies the guardian after the guardianship ended", async () => {
    await db.delete(guardianLinks).where(and(eq(guardianLinks.guardianMemberId, guardianAccountId), eq(guardianLinks.wardClubMemberId, childId)));
    expect((await view(guardian)).status).toBe(404);
    expect((await write(guardian, { mod_sp_trikot: "140" })).status).toBe(403);
    // What the guardian entered stays marked as guardian entry.
    expect((await fieldsOf(await view(board()))).find((f) => f.key === "mod_q_juleica")!.enteredBy).toBe("guardian");
  });

  it("gives a board-renamed module definition no translations", async () => {
    const list = async () => ((await body(await call(board(), "/member-fields", { clubId: cid() }))).data as Array<{ id: string; key: string; translations: unknown }>).find((f) => f.key === "mod_sp_trikot")!;
    const before = await list();
    expect(before.translations).not.toBeNull();
    expect((await call(board(), `/member-fields/${before.id}`, { method: "PATCH", clubId: cid(), body: { label: "Unser Trikot" } })).status).toBe(200);
    expect((await list()).translations).toBeNull();
    expect((await fieldsOf(await view(board()))).find((f) => f.key === "mod_sp_trikot")).toMatchObject({ translations: null });
  });

  describe("GET /club-members/me/children", () => {
    const children = async (who: Account, clubId = cid()) => call(who, "/club-members/me/children", { clubId });
    const ids = async (res: Response) => ((await body(res)).data as Array<{ clubMemberId: string }>).map((c) => c.clubMemberId);

    it("lists only the caller's own active children with minimal data, private and uncached", async () => {
      const mine = await db.insert(guardianLinks).values({ guardianMemberId: guardianAccountId, wardClubMemberId: childId }).returning();
      try {
        const res = await children(guardian);
        expect(res.status).toBe(200);
        expect(res.headers.get("cache-control")).toBe("private, no-store");
        const data = (await body(res)).data as Array<Record<string, unknown>>;
        expect(data.map((d) => d.clubMemberId)).toContain(childId);
        expect(data.map((d) => d.clubMemberId)).not.toContain(otherChildId);
        expect(Object.keys(data.find((d) => d.clubMemberId === childId)!).sort()).toEqual(["clubMemberId", "displayName", "firstName", "lastName", "status"]);
        // Another guardian does not see them.
        expect(await ids(await children(club.members.gmember!))).not.toContain(childId);
      } finally {
        await db.delete(guardianLinks).where(eq(guardianLinks.id, mine[0]!.id));
      }
    });

    it("answers 200 [] for a non-guardian and in a club where the caller guards nobody", async () => {
      const res = await children(club.members.plain!);
      expect(res.status).toBe(200);
      expect((await body(res)).data).toEqual([]);
      expect((await body(await children(board()))).data).toEqual([]);
    });

    it("does not leak across clubs", async () => {
      const foreign = await createClub("gcfc", suffix);
      try {
        const foreignAccount = (await db.query.member.findFirst({ where: (m, { and: both, eq: same }) => both(same(m.organizationId, foreign.clubId), same(m.userId, foreign.founder.userId)) }))!.id;
        const link = await db.insert(guardianLinks).values({ guardianMemberId: foreignAccount, wardClubMemberId: childId }).returning();
        expect(await ids(await children(foreign.founder, foreign.clubId))).toEqual([]);
        await db.delete(guardianLinks).where(eq(guardianLinks.id, link[0]!.id));
      } finally {
        await dropClubs([foreign.clubId], foreign.userIds);
      }
    });

    it("hides a ward who left the club", async () => {
      const gone = (await body(await call(board(), "/club-members", { method: "POST", clubId: cid(), body: { displayName: "Mia", firstName: "Mia", lastName: "Kind", categoryKey: "jugend" } }))).data.id as string;
      await db.insert(guardianLinks).values({ guardianMemberId: guardianAccountId, wardClubMemberId: gone });
      try {
        expect(await ids(await children(guardian))).toContain(gone);
        await db.update(clubMembers).set({ status: "ausgetreten", leftAt: "2020-01-01" }).where(eq(clubMembers.id, gone));
        expect(await ids(await children(guardian))).not.toContain(gone);
      } finally {
        await db.delete(guardianLinks).where(eq(guardianLinks.wardClubMemberId, gone));
      }
    });
  });
});
