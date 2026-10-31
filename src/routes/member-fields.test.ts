import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { auth } from "../auth/auth.js";
import { closeDatabase, db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { clubMembers } from "../db/schema/club-members.js";
import { memberFieldDefinitions, memberFieldValues } from "../db/schema/forms.js";
import { logger } from "../lib/logger.js";
import { clubMemberRoutes } from "./club-members.js";
import { createClub, dropClubs, installErrorHandler, requester, signUpAndVerify, type Account } from "./forms-test-support.js";
import { memberFieldRoutes } from "./member-fields.js";

/**
 * Integration test of the custom fields of club members (Wave 8 B7): definitions CRUD (forms:write; archive instead of
 * delete when values exist; type change only before the first value), the visibility / editability matrix per role,
 * deny-by-default and read scoping (guests, former members, other clubs), validation with the form engine, the audit trail
 * of sensitive reads, export columns and races between value writes and definition changes.
 */

const app = new Hono();
app.route("/club-members", clubMemberRoutes);
app.route("/member-fields", memberFieldRoutes);
installErrorHandler(app);
const call = requester(app);
const suffix = Date.now();
const SECRET = "ERDNUSS-GEHEIM-4711";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed response helper
const body = async (res: Response) => (await res.json()) as any;

describe("member custom fields (B7)", () => {
  let club: Awaited<ReturnType<typeof createClub>>;
  let other: Awaited<ReturnType<typeof createClub>>;
  let guest: Account;
  let former: Account;
  const ids: Record<string, string> = {};
  const logged: unknown[][] = [];
  const cid = () => club.clubId;
  const board = () => club.founder; // vorsitz
  const m = (name: string) => club.members[name]!;
  let targetRowId: string; // the plain member "target"
  let formerRowId: string;

  const define = async (payload: Record<string, unknown>, who = board(), clubId = cid()) => call(who, "/member-fields", { method: "POST", clubId, body: payload });
  const fieldsOf = async (who: Account, path: string, clubId = cid()) => {
    const res = await call(who, path, { clubId });
    return { status: res.status, fields: res.status === 200 ? ((await body(res)).data.fields as Array<{ key: string; value: unknown; editable: boolean }>) : [] };
  };
  const keysOf = async (who: Account, memberId = targetRowId) => (await fieldsOf(who, `/club-members/${memberId}/custom-fields`)).fields.map((f) => f.key).sort();
  const put = (who: Account, values: Record<string, unknown>, memberId = targetRowId, clubId = cid()) => call(who, `/club-members/${memberId}/custom-fields`, { method: "PUT", clubId, body: { values } });
  const patchMe = (who: Account, values: Record<string, unknown>) => call(who, "/club-members/me/custom-fields", { method: "PATCH", clubId: cid(), body: { values } });

  beforeAll(async () => {
    club = await createClub("cf", suffix, { kassen: "kassenwart", sf: "schriftfuehrer", trainer: "trainer", beisitz: "beisitzer", target: null, plain2: null });
    other = await createClub("cfo", suffix);
    guest = await signUpAndVerify(`cf-guest-${suffix}@example.com`, "Guest cf");
    former = await signUpAndVerify(`cf-former-${suffix}@example.com`, "Former cf");
    await auth.api.addMember({ body: { userId: guest.userId, organizationId: cid(), role: "guest" } });
    await auth.api.addMember({ body: { userId: former.userId, organizationId: cid(), role: "member" } });
    club.userIds.push(guest.userId, former.userId);
    for (const level of ["info", "warn", "error", "debug"] as const) {
      vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => {
        logged.push(args);
      }) as never);
    }
    const accountOf = (userId: string) => db.query.member.findFirst({ where: (mm, { and: both, eq: same }) => both(same(mm.organizationId, cid()), same(mm.userId, userId)) });
    const rowOf = async (userId: string) => (await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, (await accountOf(userId))!.id) }))!;
    targetRowId = (await rowOf(m("target").userId)).id;
    const f = await rowOf(former.userId);
    formerRowId = f.id;
    await db.update(clubMembers).set({ status: "ausgetreten", leftAt: "2020-01-01" }).where(eq(clubMembers.id, f.id));

    for (const def of [
      { key: "f_vorstand", label: "Vorstandsnotiz", type: "text", visibleTo: "vorstand" },
      { key: "f_funk", label: "Lizenz", type: "text", visibleTo: "funktionstraeger" },
      { key: "f_mitglied", label: "Instrument", type: "text", visibleTo: "mitglied", editableBy: "self" },
      { key: "f_sens", label: "Allergien", type: "textarea", visibleTo: "mitglied", editableBy: "self", sensitive: true },
      { key: "f_num", label: "Schuhgröße", type: "number", visibleTo: "mitglied" },
      { key: "f_multi", label: "Interessen", type: "multiselect", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }, { value: "c", label: "C" }], visibleTo: "mitglied", editableBy: "self" },
      { key: "f_flag", label: "Führerschein", type: "checkbox", visibleTo: "funktionstraeger" },
      { key: "f_date", label: "Eintrittsprüfung", type: "date", visibleTo: "vorstand" },
    ]) {
      const res = await define(def);
      expect(res.status).toBe(201);
      ids[def.key] = (await body(res)).data.id;
    }
  }, 120_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await dropClubs([club.clubId, other.clubId], [...club.userIds, ...other.userIds]);
    await closeDatabase();
  });

  // --- definitions ------------------------------------------------------------------------------------------

  it("needs forms:write to manage definitions (403 for everybody else, before the body is looked at)", async () => {
    // schriftfuehrer holds forms:write and is therefore allowed; everybody else is not.
    for (const who of [m("target"), m("kassen"), m("trainer"), m("beisitz"), guest]) {
      expect((await define({ key: "no_way", label: "x", type: "text" }, who)).status).toBe(403);
      expect((await call(who, `/member-fields/${ids.f_num}`, { method: "PATCH", clubId: cid(), body: { label: "x" } })).status).toBe(403);
      expect((await call(who, `/member-fields/${ids.f_num}`, { method: "DELETE", clubId: cid() })).status).toBe(403);
      expect((await call(who, `/member-fields/${ids.f_num}/unarchive`, { method: "POST", clubId: cid() })).status).toBe(403);
    }
    expect((await call(m("target"), "/member-fields?includeArchived=true", { clubId: cid() })).status).toBe(403);
    expect((await call(other.founder, `/member-fields/${ids.f_num}`, { method: "PATCH", clubId: other.clubId, body: { label: "x" } })).status).toBe(404);
    expect((await call(other.founder, `/member-fields/${ids.f_num}`, { method: "DELETE", clubId: other.clubId })).status).toBe(404);
    expect(await db.query.memberFieldDefinitions.findFirst({ where: and(eq(memberFieldDefinitions.id, ids.f_num!), eq(memberFieldDefinitions.label, "Schuhgröße")) })).toBeDefined();
  });

  it("validates definitions with the form engine rules", async () => {
    const bad: Array<Record<string, unknown>> = [
      { key: "Bad Key", label: "x", type: "text" },
      { key: "constructor", label: "x", type: "text" },
      { key: "__proto__", label: "x", type: "text" },
      { key: "x1", label: "x", type: "file" },
      { key: "x2", label: "x", type: "select" },
      { key: "x3", label: "x", type: "text", options: [{ value: "a", label: "A" }] },
      { key: "x4", label: "bidi‮evil", type: "text" },
      { key: "x5", label: "x", type: "select", options: [{ value: "a", label: "A" }, { value: "a", label: "B" }] },
      { key: "x6", label: "x", type: "text", visibleTo: "alle" },
      { key: "x7", label: "x", type: "text", mapsTo: "status" },
    ];
    for (const payload of bad) expect((await define(payload)).status, JSON.stringify(payload)).toBe(422);
    const dup = await define({ key: "f_num", label: "Nochmal", type: "text" });
    expect(dup.status).toBe(409);
    expect((await body(dup)).error.details.code).toBe("custom_field_exists");
  });

  it("lists the definitions a role may see", async () => {
    const names = async (who: Account) => ((await body(await call(who, "/member-fields", { clubId: cid() }))).data as Array<{ key: string }>).map((d) => d.key).sort();
    expect(await names(board())).toHaveLength(8);
    // Plain member: what members see of each other plus what they may fill in themselves.
    expect(await names(m("target"))).toEqual(["f_mitglied", "f_multi", "f_num", "f_sens"]);
    const forManager = (await body(await call(board(), "/member-fields", { clubId: cid() }))).data as Array<{ key: string; valueCount: number }>;
    expect(forManager.every((d) => d.valueCount === 0)).toBe(true);
  });

  // --- visibility matrix ----------------------------------------------------------------------------------------

  it("shows every role exactly its slice of a member's values (deny-by-default)", async () => {
    expect((await put(board(), { f_vorstand: "Intern", f_funk: "C-Lizenz", f_mitglied: "Tuba", f_sens: SECRET, f_num: 42, f_multi: ["a", "c"], f_flag: true, f_date: "2020-05-17" })).status).toBe(200);

    const expected: Record<string, string[]> = {
      // vorstand: everything incl. sensitive (vorsitz has members:read_sensitive)
      founder: ["f_date", "f_flag", "f_funk", "f_mitglied", "f_multi", "f_num", "f_sens", "f_vorstand"],
      // kassenwart: members:read_sensitive, no members:write -> still board level for reading
      kassen: ["f_date", "f_flag", "f_funk", "f_mitglied", "f_multi", "f_num", "f_sens", "f_vorstand"],
      // schriftfuehrer: members:write but not read_sensitive -> no sensitive field
      sf: ["f_date", "f_flag", "f_funk", "f_mitglied", "f_multi", "f_num", "f_vorstand"],
      trainer: ["f_flag", "f_funk", "f_mitglied", "f_multi", "f_num"],
      beisitz: ["f_mitglied", "f_multi", "f_num"],
      plain2: ["f_mitglied", "f_multi", "f_num"],
      // the person itself sees its own values, sensitive included
      target: ["f_date", "f_flag", "f_funk", "f_mitglied", "f_multi", "f_num", "f_sens", "f_vorstand"],
    };
    const viewers: Record<string, Account> = { founder: board(), kassen: m("kassen"), sf: m("sf"), trainer: m("trainer"), beisitz: m("beisitz"), plain2: m("plain2"), target: m("target") };
    for (const [name, who] of Object.entries(viewers)) {
      const fields = await keysOf(who);
      expect(fields, name).toEqual(expected[name]);
    }
    // The values are those that were written, and sensitive ones are absent for roles without the right.
    const asSf = (await fieldsOf(m("sf"), `/club-members/${targetRowId}/custom-fields`)).fields;
    expect(asSf.find((f) => f.key === "f_funk")!.value).toBe("C-Lizenz");
    expect(JSON.stringify(asSf)).not.toContain(SECRET);
    const asPlain2 = JSON.stringify((await fieldsOf(m("plain2"), `/club-members/${targetRowId}/custom-fields`)).fields);
    expect(asPlain2).not.toContain(SECRET);
    expect(asPlain2).not.toContain("Intern");
    expect(asPlain2).not.toContain("C-Lizenz");
  });

  it("the person itself sees its own values via /me (incl. sensitive and what the board recorded)", async () => {
    const mine = (await fieldsOf(m("target"), "/club-members/me/custom-fields")).fields;
    const byKey = Object.fromEntries(mine.map((f) => [f.key, f]));
    expect(byKey.f_sens!.value).toBe(SECRET);
    expect(byKey.f_vorstand!.value).toBe("Intern");
    expect(byKey.f_vorstand!.editable).toBe(false);
    expect(byKey.f_mitglied!.editable).toBe(true);
    // Not recorded and not fillable by the person and not visible to members: not even listed.
    const plain2 = (await fieldsOf(m("plain2"), "/club-members/me/custom-fields")).fields.map((f) => f.key);
    expect(plain2).not.toContain("f_vorstand");
    expect(plain2).toContain("f_mitglied");
  });

  it("audits every read of somebody else's sensitive value (ids only) and not the person's own", async () => {
    const countRead = async () => (await db.select().from(auditLog).where(eq(auditLog.eventType, "member_field.sensitive_read"))).filter((e) => (e.payload as { clubMemberId?: string }).clubMemberId === targetRowId);
    const before = (await countRead()).length;
    expect((await call(m("target"), "/club-members/me/custom-fields", { clubId: cid() })).status).toBe(200);
    expect((await countRead()).length).toBe(before);
    expect((await call(m("sf"), `/club-members/${targetRowId}/custom-fields`, { clubId: cid() })).status).toBe(200);
    expect((await countRead()).length).toBe(before);
    expect((await call(m("kassen"), `/club-members/${targetRowId}/custom-fields`, { clubId: cid() })).status).toBe(200);
    const entries = await countRead();
    expect(entries.length).toBe(before + 1);
    expect(entries.at(-1)!.payload).toMatchObject({ clubId: cid(), fieldIds: [ids.f_sens], readBy: expect.any(String) });
    expect(JSON.stringify(entries.at(-1)!.payload)).not.toContain(SECRET);
  });

  // --- writing ----------------------------------------------------------------------------------------------------

  it("lets only members:write change values for others (403 otherwise); sensitive also needs members:read_sensitive", async () => {
    for (const who of [m("target"), m("plain2"), m("trainer"), m("kassen"), m("beisitz"), guest]) expect((await put(who, { f_funk: "x" })).status, "plain write").toBe(403);
    // schriftfuehrer has members:write but cannot even see the sensitive field: indistinguishable from a missing key.
    const sens = await put(m("sf"), { f_sens: "nope" });
    expect(sens.status).toBe(422);
    expect((await body(sens)).error.details.fields).toEqual({ f_sens: "unknown_field" });
    expect((await put(m("sf"), { f_funk: "B-Lizenz" })).status).toBe(200);
    expect((await fieldsOf(board(), `/club-members/${targetRowId}/custom-fields`)).fields.find((f) => f.key === "f_funk")!.value).toBe("B-Lizenz");
  });

  it("lets a member change only its own editable_by = self fields (403 for visible read-only ones, 422 for hidden ones)", async () => {
    expect((await patchMe(m("target"), { f_mitglied: "Posaune", f_multi: ["b"] })).status).toBe(200);
    const view = (await fieldsOf(m("target"), "/club-members/me/custom-fields")).fields;
    expect(view.find((f) => f.key === "f_mitglied")!.value).toBe("Posaune");
    expect(view.find((f) => f.key === "f_multi")!.value).toEqual(["b"]);
    // f_num is visible to members but only the board edits it.
    expect((await patchMe(m("target"), { f_num: 44 })).status).toBe(403);
    // f_vorstand is not visible to a plain member: same answer as for a field that does not exist.
    const hidden = await patchMe(m("plain2"), { f_vorstand: "x" });
    const missing = await patchMe(m("plain2"), { f_gibt_es_nicht: "x" });
    expect(hidden.status).toBe(422);
    expect(missing.status).toBe(422);
    expect(Object.values((await body(hidden)).error.details.fields)).toEqual(["unknown_field"]);
    // Nothing was changed by the refused requests.
    expect((await fieldsOf(m("target"), "/club-members/me/custom-fields")).fields.find((f) => f.key === "f_num")!.value).toBe(42);
    // The own sensitive value is editable by the person (own data).
    expect((await patchMe(m("target"), { f_sens: "Haselnuss" })).status).toBe(200);
  });

  it("validates values with the form engine, atomically, and never echoes a value", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ f_num: "viel" }, "invalid_type"],
      [{ f_date: "2020-02-31" }, "invalid_value"],
      [{ f_multi: ["a", "z"] }, "not_an_option"],
      [{ f_multi: "a" }, "invalid_type"],
      [{ f_funk: 5 }, "invalid_type"],
      [{ f_funk: "x".repeat(201) }, "too_long"],
      [{ f_flag: "ja" }, "invalid_type"],
      [{ f_funk: "ctrl\u0000" }, "invalid_value"],
    ];
    for (const [values, code] of cases) {
      const res = await put(board(), { f_vorstand: "darf nicht ankommen", ...values });
      expect(res.status, JSON.stringify(values)).toBe(422);
      const text = await res.text();
      expect(Object.values(JSON.parse(text).error.details.fields)).toContain(code);
      expect(text).not.toContain("darf nicht ankommen");
    }
    // Atomic: the valid sibling of the refused requests was not written.
    expect((await fieldsOf(board(), `/club-members/${targetRowId}/custom-fields`)).fields.find((f) => f.key === "f_vorstand")!.value).toBe("Intern");
    for (const payload of [{}, { values: {} }, { values: [] }, { values: { __proto__: "x" } }]) expect((await call(board(), `/club-members/${targetRowId}/custom-fields`, { method: "PUT", clubId: cid(), body: payload })).status, JSON.stringify(payload)).toBe(422);
    expect((await put(board(), { "__proto__": "x", constructor: "y", "Bad Key": "z" })).status).toBe(422);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it("clears a value with null / empty and keeps types", async () => {
    expect((await put(board(), { f_date: "2021-01-02", f_num: 41.5 })).status).toBe(200);
    const typed = (await fieldsOf(board(), `/club-members/${targetRowId}/custom-fields`)).fields;
    expect(typed.find((f) => f.key === "f_num")!.value).toBe(41.5);
    expect(typed.find((f) => f.key === "f_date")!.value).toBe("2021-01-02");
    expect((await put(board(), { f_date: null, f_num: null, f_flag: false })).status).toBe(200);
    const cleared = (await fieldsOf(board(), `/club-members/${targetRowId}/custom-fields`)).fields;
    for (const key of ["f_date", "f_num", "f_flag"]) expect(cleared.find((f) => f.key === key)!.value).toBeNull();
    expect(await db.select().from(memberFieldValues).where(and(eq(memberFieldValues.clubMemberId, targetRowId), eq(memberFieldValues.fieldId, ids.f_date!)))).toHaveLength(0);
  });

  // --- scoping ----------------------------------------------------------------------------------------------------

  it("applies the read scoping of members: other clubs, guests and former members are 404, never a leak", async () => {
    expect((await call(other.founder, `/club-members/${targetRowId}/custom-fields`, { clubId: other.clubId })).status).toBe(404);
    expect((await put(other.founder, { f_funk: "x" }, targetRowId, other.clubId)).status).toBe(404);
    expect([403, 404]).toContain((await call(other.founder, `/club-members/${targetRowId}/custom-fields`, { clubId: cid() })).status);
    expect((await call(guest, `/club-members/${targetRowId}/custom-fields`, { clubId: cid() })).status).toBe(404);
    // A former member is hidden from plain members, visible to the board.
    expect((await call(m("plain2"), `/club-members/${formerRowId}/custom-fields`, { clubId: cid() })).status).toBe(404);
    expect((await call(board(), `/club-members/${formerRowId}/custom-fields`, { clubId: cid() })).status).toBe(200);
    expect((await call(board(), "/club-members/not-an-id/custom-fields", { clubId: cid() })).status).toBe(404);
    // An external guest has no profile fields of its own (read and write refused).
    expect((await call(guest, "/club-members/me/custom-fields", { clubId: cid() })).status).toBe(403);
    expect((await patchMe(guest, { f_mitglied: "x" })).status).toBe(403);
  });

  // --- archive / delete / type ------------------------------------------------------------------------------------

  it("changes the type only before the first value, and options only while no stored value uses a removed one", async () => {
    const created = await body(await define({ key: "t_field", label: "Typtest", type: "text" }));
    const id = created.data.id as string;
    const toNumber = await call(board(), `/member-fields/${id}`, { method: "PATCH", clubId: cid(), body: { type: "number" } });
    expect(toNumber.status).toBe(200);
    expect((await body(toNumber)).data.type).toBe("number");
    expect((await put(board(), { t_field: 7 })).status).toBe(200);
    const blocked = await call(board(), `/member-fields/${id}`, { method: "PATCH", clubId: cid(), body: { type: "text" } });
    expect(blocked.status).toBe(409);
    expect((await body(blocked)).error.details.code).toBe("custom_field_has_values");
    // Labels and visibility remain editable.
    expect((await call(board(), `/member-fields/${id}`, { method: "PATCH", clubId: cid(), body: { label: "Neu", visibleTo: "vorstand" } })).status).toBe(200);

    // Options: the stored multiselect value of the target uses "b" (see above).
    const removeUsed = await call(board(), `/member-fields/${ids.f_multi}`, { method: "PATCH", clubId: cid(), body: { options: [{ value: "a", label: "A" }, { value: "c", label: "C" }] } });
    expect(removeUsed.status).toBe(409);
    expect((await body(removeUsed)).error.details.code).toBe("option_in_use");
    expect((await call(board(), `/member-fields/${ids.f_multi}`, { method: "PATCH", clubId: cid(), body: { options: [{ value: "a", label: "A" }, { value: "b", label: "B" }, { value: "c", label: "C" }, { value: "d", label: "D" }] } })).status).toBe(200);
  });

  it("protects recorded data: lowering sensitive or widening visibility needs members:read_sensitive, and sensitive stays once there are values", async () => {
    const patch = (who: Account, id: string, payload: Record<string, unknown>) => call(who, `/member-fields/${id}`, { method: "PATCH", clubId: cid(), body: payload });
    const sensEmpty = (await body(await define({ key: "h_sens_empty", label: "Leer", type: "text", sensitive: true, visibleTo: "vorstand" }))).data.id as string;
    // schriftfuehrer has forms:write but not members:read_sensitive: neither lowering nor widening a sensitive field.
    expect((await patch(m("sf"), sensEmpty, { sensitive: false })).status).toBe(403);
    expect((await patch(m("sf"), sensEmpty, { visibleTo: "mitglied" })).status).toBe(403);
    expect((await patch(m("sf"), sensEmpty, { label: "Neu", sortOrder: 3 })).status).toBe(200);
    expect((await db.query.memberFieldDefinitions.findFirst({ where: eq(memberFieldDefinitions.id, sensEmpty) }))).toMatchObject({ sensitive: true, visibleTo: "vorstand", label: "Neu" });
    // The holder of members:read_sensitive may lower it while nothing is recorded; the audit shows old/new flags, no values.
    expect((await patch(board(), sensEmpty, { sensitive: false })).status).toBe(200);
    const [entry] = (await db.select().from(auditLog).where(and(eq(auditLog.eventType, "member_field.update"), eq(auditLog.subjectId, sensEmpty)))).slice(-1);
    expect(entry!.payload).toMatchObject({ changed: ["sensitive"], flags: { sensitive: { from: true, to: false } } });

    // With values it is one-way, whoever asks.
    const sensUsed = (await body(await define({ key: "h_sens_used", label: "Belegt", type: "text", sensitive: true }))).data.id as string;
    expect((await put(board(), { h_sens_used: SECRET })).status).toBe(200);
    const locked = await patch(board(), sensUsed, { sensitive: false });
    expect(locked.status).toBe(409);
    expect((await body(locked)).error.details.code).toBe("sensitive_locked");
    expect((await patch(m("sf"), sensUsed, { sensitive: false })).status).toBe(403);
    expect((await db.query.memberFieldDefinitions.findFirst({ where: eq(memberFieldDefinitions.id, sensUsed) }))!.sensitive).toBe(true);

    // A non-sensitive field that already holds values: widening needs the right, narrowing and other edits do not.
    const plainUsed = (await body(await define({ key: "h_plain_used", label: "Plain", type: "text", visibleTo: "vorstand" }))).data.id as string;
    expect((await put(board(), { h_plain_used: "wert" })).status).toBe(200);
    expect((await patch(m("sf"), plainUsed, { visibleTo: "mitglied" })).status).toBe(403);
    expect((await patch(board(), plainUsed, { visibleTo: "funktionstraeger" })).status).toBe(200);
    expect((await patch(m("sf"), plainUsed, { visibleTo: "vorstand" })).status).toBe(200);
    // Without values anybody with forms:write may widen a non-sensitive field.
    const plainEmpty = (await body(await define({ key: "h_plain_empty", label: "Leer2", type: "text", visibleTo: "vorstand" }))).data.id as string;
    expect((await patch(m("sf"), plainEmpty, { visibleTo: "mitglied" })).status).toBe(200);
    expect(JSON.stringify(entry!.payload)).not.toContain(SECRET);
  });

  it("deletes a definition without values and archives one with values (values stay, nobody reads or writes them)", async () => {
    const empty = (await body(await define({ key: "d_empty", label: "Leer", type: "text" }))).data.id as string;
    const deleted = await call(board(), `/member-fields/${empty}`, { method: "DELETE", clubId: cid() });
    expect(await body(deleted)).toMatchObject({ data: { id: empty, outcome: "deleted" } });
    expect(await db.query.memberFieldDefinitions.findFirst({ where: eq(memberFieldDefinitions.id, empty) })).toBeUndefined();

    const used = (await body(await define({ key: "d_used", label: "Benutzt", type: "text", visibleTo: "mitglied" }))).data.id as string;
    expect((await put(board(), { d_used: "Wert" })).status).toBe(200);
    const archived = await call(board(), `/member-fields/${used}`, { method: "DELETE", clubId: cid() });
    expect(await body(archived)).toMatchObject({ data: { id: used, outcome: "archived" } });
    expect(await db.select().from(memberFieldValues).where(eq(memberFieldValues.fieldId, used))).toHaveLength(1);

    expect(await keysOf(board())).not.toContain("d_used");
    expect(await keysOf(m("plain2"))).not.toContain("d_used");
    expect((await put(board(), { d_used: "neu" })).status).toBe(422);
    expect((await call(board(), `/member-fields/${used}`, { method: "PATCH", clubId: cid(), body: { label: "x" } })).status).toBe(409);
    expect((await call(m("plain2"), `/club-members/${targetRowId}/custom-fields?includeArchived=true`, { clubId: cid() })).status).toBe(403);
    const withArchived = (await fieldsOf(board(), `/club-members/${targetRowId}/custom-fields?includeArchived=true`)).fields;
    expect(withArchived.find((f) => f.key === "d_used")!.value).toBe("Wert");
    const listed = (await body(await call(board(), "/member-fields?includeArchived=true", { clubId: cid() }))).data as Array<{ key: string; archived: boolean; valueCount: number }>;
    expect(listed.find((d) => d.key === "d_used")).toMatchObject({ archived: true, valueCount: 1 });

    expect((await call(board(), `/member-fields/${used}/unarchive`, { method: "POST", clubId: cid() })).status).toBe(200);
    expect((await call(board(), `/member-fields/${used}/unarchive`, { method: "POST", clubId: cid() })).status).toBe(409);
    expect(await keysOf(board())).toContain("d_used");
  });

  // --- export -----------------------------------------------------------------------------------------------------

  it("exports custom field columns on request: only what the exporter may read, injection escaped", async () => {
    expect((await put(board(), { f_funk: "=1+1" })).status).toBe(200);
    const csvOf = async (who: Account, columns: string) => call(who, `/club-members/export?columns=${encodeURIComponent(columns)}`, { clubId: cid() });
    const ok = await csvOf(board(), "displayName,cf:f_funk,cf:f_sens");
    expect(ok.status).toBe(200);
    const text = await ok.text();
    expect(text).toContain("Lizenz");
    expect(text).toContain("Allergien");
    expect(text).toContain("'=1+1");
    // schriftfuehrer (members:write only): not the sensitive column.
    // Unreadable and unknown give the same answer (no existence leak).
    const denied = await csvOf(m("sf"), "displayName,cf:f_sens");
    expect(denied.status).toBe(422);
    expect((await body(await csvOf(m("sf"), "displayName,cf:nope_nope"))).error.details.code).toBe("unknown_column");
    expect((await body(await csvOf(m("sf"), "displayName,cf:f_sens"))).error.details.code).toBe("unknown_column");
    expect(await denied.text()).not.toContain(SECRET);
    expect((await csvOf(m("sf"), "displayName,cf:f_funk")).status).toBe(200);
    expect((await csvOf(board(), "cf:nope")).status).toBe(422);
    expect((await csvOf(m("plain2"), "displayName,cf:f_mitglied")).status).toBe(403); // plain members cannot export at all
    // Not part of the default selection.
    expect(await (await call(board(), "/club-members/export", { clubId: cid() })).text()).not.toContain("Lizenz");
  });

  // --- races ------------------------------------------------------------------------------------------------------

  it("a value write racing a delete or a type change never loses or corrupts a value", async () => {
    for (let i = 0; i < 3; i++) {
      const id = (await body(await define({ key: `race_del_${i}`, label: "Rennen", type: "text" }))).data.id as string;
      const [write, del] = await Promise.all([put(board(), { [`race_del_${i}`]: "Wert" }), call(board(), `/member-fields/${id}`, { method: "DELETE", clubId: cid() })]);
      expect(del.status).toBe(200);
      const outcome = (await body(del)).data.outcome as string;
      const stored = await db.select().from(memberFieldValues).where(eq(memberFieldValues.fieldId, id));
      if (write.status === 200) {
        // The write won (or ran first): the definition must have been archived with its value, never deleted.
        expect(outcome, `round ${i}`).toBe("archived");
        expect(stored).toHaveLength(1);
      } else {
        expect(write.status).toBe(422);
        expect(stored).toHaveLength(0);
      }
    }
    for (let i = 0; i < 3; i++) {
      const key = `race_type_${i}`;
      const id = (await body(await define({ key, label: "Typ", type: "text" }))).data.id as string;
      const [write, change] = await Promise.all([put(board(), { [key]: "Text" }), call(board(), `/member-fields/${id}`, { method: "PATCH", clubId: cid(), body: { type: "number" } })]);
      const def = (await db.query.memberFieldDefinitions.findFirst({ where: eq(memberFieldDefinitions.id, id) }))!;
      const stored = await db.select().from(memberFieldValues).where(eq(memberFieldValues.fieldId, id));
      if (change.status === 200) {
        // The type changed first (write sees the number type and refuses the text) ...
        expect(def.fieldType).toBe("number");
        expect(write.status).toBe(422);
        expect(stored).toHaveLength(0);
      } else {
        // ... or the write came first and froze the type.
        expect(change.status).toBe(409);
        expect(write.status).toBe(200);
        expect(def.fieldType).toBe("text");
        expect(stored).toHaveLength(1);
      }
    }
  });

  // --- privacy ----------------------------------------------------------------------------------------------------

  it("keeps values out of logs and audit entries", async () => {
    expect(JSON.stringify(logged)).not.toContain(SECRET);
    const entries = (await db.select().from(auditLog)).filter((e) => JSON.stringify(e.payload).includes(cid()));
    expect(entries.some((e) => e.eventType === "member_field.write")).toBe(true);
    for (const e of entries) for (const value of [SECRET, "Haselnuss", "C-Lizenz", "Tuba", "Posaune", "Intern"]) expect(JSON.stringify(e.payload), e.eventType).not.toContain(value);
  });
});
