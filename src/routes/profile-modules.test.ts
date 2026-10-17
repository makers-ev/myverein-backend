import { and, count, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { auth } from "../auth/auth.js";
import { closeDatabase, db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { clubMembers } from "../db/schema/club-members.js";
import { memberFieldDefinitions, memberFieldValues } from "../db/schema/forms.js";
import { MAX_CUSTOM_FIELDS_PER_CLUB } from "../lib/custom-fields.js";
import { logger } from "../lib/logger.js";
import { PROFILE_MODULES } from "../lib/profile-modules.js";
import { clubMemberRoutes } from "./club-members.js";
import { aufnahmeFields, createClub, dropClubs, installErrorHandler, requester, signUpAndVerify, type Account } from "./forms-test-support.js";
import { formRoutes } from "./forms.js";
import { memberFieldRoutes } from "./member-fields.js";

/**
 * Integration test of the profile module catalog and the `credential` value type: nothing exists until the board activates
 * a module (deny-by-default), activation is idempotent and race-safe, never overwrites customised definitions, deactivation
 * keeps the values, credential values are validated and shown per visibility / sensitivity, never required, exported
 * formula-safe, and never reach logs or the audit trail.
 */

const app = new Hono();
app.route("/club-members", clubMemberRoutes);
app.route("/member-fields", memberFieldRoutes);
app.route("/forms", formRoutes);
installErrorHandler(app);
const call = requester(app);
const suffix = Date.now();
const SECRET = "GEHEIMSTUFE-4711";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed response helper
const body = async (res: Response) => (await res.json()) as any;

describe("profile modules and credential fields", () => {
  let club: Awaited<ReturnType<typeof createClub>>;
  let other: Awaited<ReturnType<typeof createClub>>;
  let guest: Account;
  let targetRowId: string;
  const logged: unknown[][] = [];
  const cid = () => club.clubId;
  const board = () => club.founder;
  const m = (name: string) => club.members[name]!;

  const catalog = async (who = board(), clubId = cid()) => call(who, "/member-fields/catalog", { clubId });
  const activate = (id: string, who = board(), clubId = cid()) => call(who, `/member-fields/catalog/${id}/activate`, { method: "POST", clubId });
  const deactivate = (id: string, who = board(), clubId = cid()) => call(who, `/member-fields/catalog/${id}/deactivate`, { method: "POST", clubId });
  const put = (who: Account, values: Record<string, unknown>, memberId = targetRowId) => call(who, `/club-members/${memberId}/custom-fields`, { method: "PUT", clubId: cid(), body: { values } });
  const patchMe = (who: Account, values: Record<string, unknown>) => call(who, "/club-members/me/custom-fields", { method: "PATCH", clubId: cid(), body: { values } });
  const viewOf = async (who: Account, memberId = targetRowId) => {
    const res = await call(who, `/club-members/${memberId}/custom-fields`, { clubId: cid() });
    return { status: res.status, fields: res.status === 200 ? ((await body(res)).data.fields as Array<{ key: string; value: unknown; editable: boolean }>) : [] };
  };
  const rowCount = async (clubId: string, key: string) => (await db.select({ n: count() }).from(memberFieldDefinitions).where(and(eq(memberFieldDefinitions.clubId, clubId), eq(memberFieldDefinitions.key, key))))[0]!.n;

  beforeAll(async () => {
    club = await createClub("pm", suffix, { sf: "schriftfuehrer", trainer: "trainer", kassen: "kassenwart", target: null });
    other = await createClub("pmo", suffix);
    guest = await signUpAndVerify(`pm-guest-${suffix}@example.com`, "Guest pm");
    await auth.api.addMember({ body: { userId: guest.userId, organizationId: cid(), role: "guest" } });
    club.userIds.push(guest.userId);
    for (const level of ["info", "warn", "error", "debug"] as const) {
      vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => {
        logged.push(args);
      }) as never);
    }
    const account = await db.query.member.findFirst({ where: (mm, { and: both, eq: same }) => both(same(mm.organizationId, cid()), same(mm.userId, m("target").userId)) });
    targetRowId = (await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, account!.id) }))!.id;
  }, 120_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await dropClubs([club.clubId, other.clubId], [...club.userIds, ...other.userIds]);
    await closeDatabase();
  });

  it("starts empty: nothing exists until a module is activated, and the catalog needs forms:write", async () => {
    expect(((await body(await call(board(), "/member-fields", { clubId: cid() }))).data as unknown[]).length).toBe(0);
    for (const who of [m("target"), m("trainer"), m("kassen"), guest]) {
      expect((await catalog(who)).status).toBe(403);
      expect((await activate("mod_q_juleica", who)).status).toBe(403);
      expect((await deactivate("mod_q_juleica", who)).status).toBe(403);
    }
    expect(await rowCount(cid(), "mod_q_juleica")).toBe(0);

    const res = await catalog(m("sf")); // schriftfuehrer holds forms:write
    expect(res.status).toBe(200);
    const data = (await body(res)).data;
    expect(data.modules).toHaveLength(PROFILE_MODULES.length);
    expect(data.modules.every((x: { state: string; mandatory: boolean }) => x.state === "inactive" && x.mandatory === false)).toBe(true);
    expect(data.groups.map((g: { id: string }) => g.id)).toEqual(["fuehrerschein", "qualifikationen", "kinderschutz", "mitarbeit", "sport", "persoenlich"]);
    expect(data.limit).toEqual({ used: 0, max: MAX_CUSTOM_FIELDS_PER_CLUB });
    expect((await activate("mod_does_not_exist")).status).toBe(404);
    expect((await activate("custom_thing")).status).toBe(404);
    expect((await deactivate("mod_does_not_exist")).status).toBe(404);
  });

  it("activates with the agreed defaults, idempotently, per club", async () => {
    const first = await activate("mod_q_juleica");
    expect(first.status).toBe(201);
    const created = (await body(first)).data;
    expect(created).toMatchObject({ created: true, reactivated: false });
    expect(created.field).toMatchObject({ key: "mod_q_juleica", type: "credential", visibleTo: "funktionstraeger", editableBy: "self", sensitive: false, archived: false, valueCount: 0 });
    expect(created.module).toMatchObject({ id: "mod_q_juleica", state: "active", customized: false });

    const again = await activate("mod_q_juleica");
    expect(again.status).toBe(200);
    expect((await body(again)).data).toMatchObject({ created: false, reactivated: false });
    expect(await rowCount(cid(), "mod_q_juleica")).toBe(1);

    const ks = (await body(await activate("mod_ks_fuehrungszeugnis"))).data.field;
    expect(ks).toMatchObject({ visibleTo: "vorstand", sensitive: true, editableBy: "self", type: "credential" });
    expect(ks.helpText).toContain("Inhalt");
    const stapler = (await body(await activate("mod_fs_stapler"))).data.field;
    expect(stapler).toMatchObject({ visibleTo: "funktionstraeger", sensitive: false });
    const sitze = (await body(await activate("mod_mw_sitzplaetze"))).data.field;
    expect(sitze).toMatchObject({ type: "number", validation: { min: 0, max: 9 } });
    const cat = (await body(await catalog())).data;
    expect(cat.modules.find((x: { id: string }) => x.id === "mod_q_juleica")).toMatchObject({ state: "active", fieldId: created.field.id });
    expect(cat.limit.used).toBe(4);

    // Other club untouched (IDOR): its catalog is still empty, and its board cannot reach this club's definition.
    expect((await body(await catalog(other.founder, other.clubId))).data.modules.every((x: { state: string }) => x.state === "inactive")).toBe(true);
    expect(await rowCount(other.clubId, "mod_q_juleica")).toBe(0);
    // A club's board cannot activate in a club it does not belong to (clubGuard answers 404, no existence leak).
    expect((await activate("mod_q_sanitaeter", other.founder, cid())).status).toBe(404);
    expect(await rowCount(cid(), "mod_q_sanitaeter")).toBe(0);
  });

  it("creates exactly one definition under parallel activation", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => activate("mod_q_erste_hilfe")));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 200, 200, 200, 200, 200, 200, 201]);
    expect(await rowCount(cid(), "mod_q_erste_hilfe")).toBe(1);
    // A manual create of the same key and a module activation never both win.
    const mixed = await Promise.all([
      call(board(), "/member-fields", { method: "POST", clubId: cid(), body: { key: "mod_sp_trikot", label: "Eigene Größe", type: "text" } }),
      activate("mod_sp_trikot"),
    ]);
    expect(mixed.map((r) => r.status).sort()).toHaveLength(2);
    expect(mixed.every((r) => [200, 201, 409].includes(r.status))).toBe(true);
    expect(await rowCount(cid(), "mod_sp_trikot")).toBe(1);
  });

  it("never overwrites a customised definition; deactivation archives and keeps the values", async () => {
    const fieldId = (await db.query.memberFieldDefinitions.findFirst({ where: and(eq(memberFieldDefinitions.clubId, cid()), eq(memberFieldDefinitions.key, "mod_q_juleica")) }))!.id;
    expect((await call(board(), `/member-fields/${fieldId}`, { method: "PATCH", clubId: cid(), body: { label: "JuLeiCa (Jugendleiter)" } })).status).toBe(200);
    expect((await put(board(), { mod_q_juleica: { valid: true, validUntil: "2031-05-01" } })).status).toBe(200);

    const stay = await activate("mod_q_juleica");
    expect((await body(stay)).data.field.label).toBe("JuLeiCa (Jugendleiter)");
    expect((await body(await catalog())).data.modules.find((x: { id: string }) => x.id === "mod_q_juleica")).toMatchObject({ state: "active", customized: true });

    const off = await deactivate("mod_q_juleica");
    expect(off.status).toBe(200);
    expect((await body(off)).data).toMatchObject({ changed: true, module: { state: "archived" } });
    expect((await body(await deactivate("mod_q_juleica"))).data.changed).toBe(false);
    expect((await body(await deactivate("mod_q_segelschein"))).data).toMatchObject({ changed: false, module: { state: "inactive" } });
    expect(await db.select().from(memberFieldValues).where(eq(memberFieldValues.fieldId, fieldId))).toHaveLength(1);
    expect((await viewOf(board())).fields.map((f) => f.key)).not.toContain("mod_q_juleica");
    expect((await put(board(), { mod_q_juleica: { valid: true } })).status).toBe(422); // archived: unknown field

    const back = await activate("mod_q_juleica");
    expect(back.status).toBe(200);
    expect((await body(back)).data).toMatchObject({ created: false, reactivated: true, field: { label: "JuLeiCa (Jugendleiter)", archived: false } });
    expect((await viewOf(board())).fields.find((f) => f.key === "mod_q_juleica")!.value).toEqual({ valid: true, validUntil: "2031-05-01" });
    await db.update(memberFieldDefinitions).set({ label: "JuLeiCa" }).where(eq(memberFieldDefinitions.id, fieldId));
  });

  it("keeps the 100 definitions limit", async () => {
    const filler = await createClub("pmf", suffix);
    const existing = (await db.select({ n: count() }).from(memberFieldDefinitions).where(eq(memberFieldDefinitions.clubId, filler.clubId)))[0]!.n;
    await db.insert(memberFieldDefinitions).values(Array.from({ length: MAX_CUSTOM_FIELDS_PER_CLUB - existing - 1 }, (_, i) => ({ clubId: filler.clubId, key: `filler_${i}`, label: `F${i}`, fieldType: "text" })));
    try {
      expect((await activate("mod_q_sanitaeter", filler.founder, filler.clubId)).status).toBe(201); // the 100th
      const over = await activate("mod_q_segelschein", filler.founder, filler.clubId);
      expect(over.status).toBe(409);
      expect((await body(over)).error.details.code).toBe("custom_field_limit");
      expect((await activate("mod_q_sanitaeter", filler.founder, filler.clubId)).status).toBe(200); // already active: still fine
      expect(await rowCount(filler.clubId, "mod_q_segelschein")).toBe(0);
    } finally {
      await dropClubs([filler.clubId], filler.userIds);
    }
  });

  it("validates credential values and never makes a module mandatory", async () => {
    for (const id of ["mod_q_uebungsleiter", "mod_q_schiedsrichter", "mod_ks_praevention"]) expect((await activate(id)).status).toBeLessThan(300);
    const bad: Array<[string, unknown]> = [
      ["mod_q_juleica", { valid: false }],
      ["mod_q_juleica", { valid: true, validUntil: "31.12.2030" }],
      ["mod_q_juleica", { valid: true, obtainedOn: "2030-02-01", validUntil: "2030-01-01" }],
      ["mod_q_juleica", { valid: true, level: "A" }],
      ["mod_q_juleica", { valid: true, secret: "x" }],
      ["mod_q_juleica", "ja"],
      ["mod_q_uebungsleiter", { valid: true, level: "z" }],
      ["mod_q_schiedsrichter", { valid: true, level: "x".repeat(61) }],
    ];
    for (const [key, value] of bad) expect((await put(board(), { [key]: value })).status, `${key} ${JSON.stringify(value)}`).toBe(422);

    expect((await put(board(), { mod_q_uebungsleiter: { valid: true, level: "b", obtainedOn: "2024-01-01", validUntil: "2030-01-01" }, mod_q_schiedsrichter: { valid: true, level: SECRET } })).status).toBe(200);
    expect((await viewOf(board())).fields.find((f) => f.key === "mod_q_uebungsleiter")!.value).toEqual({ valid: true, level: "b", obtainedOn: "2024-01-01", validUntil: "2030-01-01" });
    // Not held: the value is simply cleared.
    expect((await put(board(), { mod_q_uebungsleiter: null })).status).toBe(200);
    expect((await viewOf(board())).fields.find((f) => f.key === "mod_q_uebungsleiter")!.value).toBeNull();
    // Nothing is mandatory: a write without any module value is not an error and no definition carries `required`.
    expect((await put(board(), { mod_q_sanitaeter: null })).status).toBe(422); // not activated -> unknown, not "required"
    expect(Object.keys((await body(await catalog())).data.modules[0])).not.toContain("required");
  });

  it("shows credential values per visibility and sensitivity, and lets members maintain their own", async () => {
    expect((await patchMe(m("target"), { mod_q_erste_hilfe: { valid: true, obtainedOn: "2025-03-01", validUntil: "2027-03-01" }, mod_ks_praevention: { valid: true, validUntil: "2028-01-01" } })).status).toBe(200);
    // The person sees everything of their own, including the sensitive module.
    const own = (await viewOf(m("target"))).fields;
    expect(own.find((f) => f.key === "mod_ks_praevention")!.value).toEqual({ valid: true, validUntil: "2028-01-01" });
    expect(own.find((f) => f.key === "mod_q_erste_hilfe")!.editable).toBe(true);

    const keysFor = async (who: Account) => (await viewOf(who)).fields.map((f) => f.key);
    // Trainer (funktionstraeger): licences yes, Kinderschutz no.
    const trainer = await keysFor(m("trainer"));
    expect(trainer).toContain("mod_q_erste_hilfe");
    expect(trainer).not.toContain("mod_ks_praevention");
    // Schriftfuehrer has members:write but not members:read_sensitive: no Kinderschutz, cannot write it either.
    expect(await keysFor(m("sf"))).not.toContain("mod_ks_praevention");
    expect((await put(m("sf"), { mod_ks_praevention: { valid: true } })).status).toBe(422);
    expect((await put(m("sf"), { mod_q_erste_hilfe: { valid: true, validUntil: "2027-04-01" } })).status).toBe(200);
    // Vorsitz and Kassenwart (members:read_sensitive) read Kinderschutz; the read of someone else's is audited with ids only.
    expect(await keysFor(board())).toContain("mod_ks_praevention");
    expect(await keysFor(m("kassen"))).toContain("mod_ks_praevention");
    // A plain member sees nothing of another member's modules (default visibility is not "mitglied").
    const plain = await call(m("target"), `/club-members/${targetRowId}/custom-fields`, { clubId: cid() });
    expect(plain.status).toBe(200); // own row
    expect((await put(m("target"), { mod_q_erste_hilfe: { valid: true } })).status).toBe(403); // PUT is board only
    // Guests have no profile fields.
    expect((await patchMe(guest, { mod_q_erste_hilfe: { valid: true } })).status).toBe(403);
  });

  it("keeps values out of logs and audit entries", async () => {
    const entries = await db.select().from(auditLog);
    const mine = entries.filter((e) => JSON.stringify(e.payload).includes(cid()));
    expect(mine.length).toBeGreaterThan(0);
    expect(JSON.stringify(mine)).not.toContain(SECRET);
    expect(mine.some((e) => e.eventType === "profile_module.activate")).toBe(true);
    expect(mine.some((e) => e.eventType === "profile_module.deactivate")).toBe(true);
    expect(JSON.stringify(logged)).not.toContain(SECRET);
  });

  it("exports credential columns as formula-safe text, only for readable fields", async () => {
    expect((await put(board(), { mod_q_schiedsrichter: { valid: true, level: "=1+1", validUntil: "2030-01-01" } })).status).toBe(200);
    const csvOf = (who: Account, columns: string) => call(who, `/club-members/export?columns=${encodeURIComponent(columns)}`, { clubId: cid() });
    const ok = await (await csvOf(board(), "displayName,cf:mod_q_schiedsrichter,cf:mod_q_erste_hilfe,cf:mod_ks_praevention")).text();
    expect(ok).toContain("Ja, Stufe: =1+1, bis: 2030-01-01");
    expect(ok).toContain("Ja, bis: 2027-04-01");
    expect(ok).toContain("Ja, bis: 2028-01-01");
    expect(ok).not.toMatch(/;=1\+1/);
    const sf = await csvOf(m("sf"), "displayName,cf:mod_ks_praevention");
    expect(sf.status).toBe(422);
    expect((await body(sf)).error.details.code).toBe("unknown_column");
    expect((await csvOf(m("sf"), "displayName,cf:mod_q_erste_hilfe")).status).toBe(200);
  });

  it("supports board-defined credential fields with levels and protects levels in use", async () => {
    const created = await call(board(), "/member-fields", { method: "POST", clubId: cid(), body: { key: "own_licence", label: "Eigene Lizenz", type: "credential", options: [{ value: "1", label: "Stufe 1" }, { value: "2", label: "Stufe 2" }], helpText: "Nur Vermerk" } });
    expect(created.status).toBe(201);
    const id = (await body(created)).data.id;
    expect((await put(board(), { own_licence: { valid: true, level: "2" } })).status).toBe(200);
    const drop = await call(board(), `/member-fields/${id}`, { method: "PATCH", clubId: cid(), body: { options: [{ value: "1", label: "Stufe 1" }] } });
    expect(drop.status).toBe(409);
    expect((await body(drop)).error.details.code).toBe("option_in_use");
    const retype = await call(board(), `/member-fields/${id}`, { method: "PATCH", clubId: cid(), body: { type: "text" } });
    expect(retype.status).toBe(409);
    expect((await call(board(), "/member-fields", { method: "POST", clubId: cid(), body: { key: "bad_cred", label: "x", type: "credential", options: [{ value: "a", label: "A" }], visibleTo: "mitglied" } })).status).toBe(201);
    expect((await call(board(), "/member-fields", { method: "POST", clubId: cid(), body: { key: "bad_cred2", label: "x", type: "text", options: [{ value: "a", label: "A" }] } })).status).toBe(422);
  });

  it("keeps credentials out of forms and modules out of mandatory form fields", async () => {
    const created = await call(board(), "/forms", { method: "POST", clubId: cid(), body: { purpose: "umfrage", name: "Umfrage", fields: [{ key: "lizenz", type: "credential", label: "Lizenz" }] } });
    expect(created.status).toBe(422);
    expect((await body(created)).error.details.problems).toEqual([{ code: "credential_not_supported", fieldKey: "lizenz" }]);

    expect((await activate("mod_fs_schluesselzahl_95")).status).toBeLessThan(300);
    const list = (await body(await call(board(), "/forms", { clubId: cid() }))).data as Array<{ id: string; purpose: string }>;
    const id = list.find((f) => f.purpose === "aufnahme")!.id;
    const publishWith = async (required: boolean) => {
      const fields = aufnahmeFields([{ key: "ks95", type: "checkbox", label: "Schlüsselzahl 95", required, customField: "mod_fs_schluesselzahl_95" }]);
      expect((await call(board(), `/forms/${id}/draft`, { method: "PUT", clubId: cid(), body: { fields, privacyNotice: "Text" } })).status).toBe(200);
      return call(board(), `/forms/${id}/publish`, { method: "POST", clubId: cid() });
    };
    const refused = await publishWith(true);
    expect(refused.status).toBe(422);
    expect((await body(refused)).error.details.problems).toEqual([{ code: "module_never_mandatory", fieldKey: "ks95" }]);
    expect((await publishWith(false)).status).toBe(200);
  });
});
