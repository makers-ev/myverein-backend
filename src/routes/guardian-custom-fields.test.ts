import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { closeDatabase, db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
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
  const cid = () => club.clubId;
  const board = () => club.founder;
  const cred = { valid: true, validUntil: "2099-01-01" };

  const view = async (who: Account, memberId = childId) => call(who, `/club-members/${memberId}/custom-fields`, { clubId: cid() });
  const write = (who: Account, values: Record<string, unknown>, memberId = childId, method = "PUT") => call(who, `/club-members/${memberId}/custom-fields`, { method, clubId: cid(), body: { values } });
  const fieldsOf = async (res: Response) => (await body(res)).data.fields as Array<{ key: string; value: unknown; editable: boolean; enteredBy: string | null }>;
  const activate = (id: string) => call(board(), `/member-fields/catalog/${id}/activate`, { method: "POST", clubId: cid() });
  const link = async (ward: string) => db.insert(guardianLinks).values({ guardianMemberId: guardianAccountId, wardClubMemberId: ward });

  beforeAll(async () => {
    club = await createClub("gcf", suffix, { plain: null });
    guardian = await signUpAndVerify(`gcf-guardian-${suffix}@example.com`, "Guardian gcf");
    await auth.api.addMember({ body: { userId: guardian.userId, organizationId: cid(), role: "guest" } });
    club.userIds.push(guardian.userId);
    guardianAccountId = (await db.query.member.findFirst({ where: (m, { and: both, eq: same }) => both(same(m.organizationId, cid()), same(m.userId, guardian.userId)) }))!.id;
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
    expect(await body(await write(guardian, { mod_sp_trikot: "nonsense" }))).toBeTruthy();
    expect((await write(guardian, { mod_sp_trikot: "nonsense" })).status).toBe(422);
    // Even a stored sensitive value stays hidden.
    expect((await write(board(), { mod_ks_fuehrungszeugnis: cred })).status).toBe(200);
    expect((await fieldsOf(await view(guardian))).map((f) => f.key)).not.toContain("mod_ks_fuehrungszeugnis");
  });

  it("refuses fields that only the board may edit", async () => {
    const created = await call(board(), "/member-fields", { method: "POST", clubId: cid(), body: { key: "board_only", label: "Intern", type: "text", visibleTo: "mitglied", editableBy: "vorstand" } });
    expect(created.status).toBe(201);
    expect((await write(guardian, { board_only: "x" })).status).toBe(422); // not visible yet: unknown to the guardian
    expect((await write(board(), { board_only: "visible" })).status).toBe(200);
    expect((await write(guardian, { board_only: "x" })).status).toBe(422); // never writable
    const f = (await fieldsOf(await view(guardian))).find((x) => x.key === "board_only")!;
    expect(f).toMatchObject({ value: "visible", editable: false });
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
});
