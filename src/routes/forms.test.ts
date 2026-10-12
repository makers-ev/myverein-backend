import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDatabase, db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { forms, formVersions, memberFieldDefinitions } from "../db/schema/forms.js";
import { clubPermissionsFor } from "../lib/club-permissions.js";
import { clubFormRoutes } from "./club-forms.js";
import { formRoutes } from "./forms.js";
import { aufnahmeFields, createClub, dropClubs, installErrorHandler, requester, type Account } from "./forms-test-support.js";

/**
 * Integration test of the form management API (Wave 8 B4) against a real Postgres: forms:write gating (deny by
 * default, reads included), club scoping (404), standard forms, draft -> publish -> archive lifecycle, immutable
 * versions, key-type immutability, per-purpose publish checks, race-safe publish and archive/reset of the standard form.
 */

const app = new Hono();
app.route("/forms", formRoutes);
app.route("/club-forms", clubFormRoutes);
installErrorHandler(app);
const call = requester(app);
const suffix = Date.now();

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed response helper
const body = async (res: Response) => (await res.json()) as any;

describe("form management API", () => {
  let clubId: string;
  let otherClubId: string;
  let board: Account;
  let schriftfuehrer: Account;
  let stellv: Account;
  let plain: Account;
  let kassenwart: Account;
  let otherBoard: Account;
  let userIds: string[];

  beforeAll(async () => {
    const a = await createClub("a", suffix, { schriftfuehrer: "schriftfuehrer", stellv: "stellv_vorsitz", plain: null, kassenwart: "kassenwart" });
    const b = await createClub("b", suffix);
    clubId = a.clubId;
    otherClubId = b.clubId;
    board = a.founder;
    ({ schriftfuehrer, stellv, plain, kassenwart } = a.members as Record<string, Account>);
    otherBoard = b.founder;
    userIds = [...a.userIds, ...b.userIds];
  }, 60_000);

  afterAll(async () => {
    await dropClubs([clubId, otherClubId], userIds);
    await closeDatabase();
  });

  const list = async (who = board, cid = clubId) => (await body(await call(who, "/forms", { clubId: cid }))).data as Array<{ id: string; purpose: string; publishedVersion: number | null; draftVersion: number | null; versionCount: number }>;
  const aufnahmeId = async () => (await list()).find((f) => f.purpose === "aufnahme")!.id;

  it("grants forms:write to vorsitz, stellv_vorsitz and schriftfuehrer only", () => {
    for (const role of ["vorsitz", "stellv_vorsitz", "schriftfuehrer"]) expect(clubPermissionsFor([role])).toContain("forms:write");
    for (const role of ["mitglied", "kassenwart", "beisitzer", "abteilungsleitung", "trainer", "erziehungsberechtigt"]) expect(clubPermissionsFor([role])).not.toContain("forms:write");
  });

  it("is deny-by-default: every route answers 403 without forms:write, reads included", async () => {
    const id = await aufnahmeId();
    const routes: Array<[string, string, unknown?]> = [
      ["GET", "/forms"],
      ["POST", "/forms", { purpose: "umfrage", name: "X" }],
      ["GET", `/forms/${id}`],
      ["PUT", `/forms/${id}/draft`, { fields: [] }],
      ["PUT", `/forms/${id}/versions/1`, { fields: [] }],
      ["DELETE", `/forms/${id}/draft`],
      ["POST", `/forms/${id}/publish`],
      ["POST", `/forms/${id}/archive`],
      ["GET", `/forms/${id}/versions`],
      ["GET", `/forms/${id}/versions/1`],
    ];
    for (const who of [plain, kassenwart]) {
      for (const [method, path, payload] of routes) {
        const res = await call(who, path, { method, clubId, body: payload });
        expect(res.status, `${method} ${path}`).toBe(403);
      }
    }
    expect((await call(plain, "/forms", { clubId })).status).toBe(403);
    expect((await app.request(`/forms?clubId=${clubId}`)).status).toBe(401);
    for (const who of [schriftfuehrer, stellv]) expect((await call(who, "/forms", { clubId })).status).toBe(200);
  });

  it("gives a club its standard forms (published v1) on first access", async () => {
    const all = await list();
    expect(all.map((f) => f.purpose).sort()).toEqual(["aufnahme", "austritt"]);
    for (const f of all) expect(f).toMatchObject({ publishedVersion: 1, draftVersion: null, versionCount: 1 });
    const detail = await body(await call(board, `/forms/${await aufnahmeId()}`, { clubId }));
    expect(detail.data.published.status).toBe("published");
    expect(detail.data.published.fields.map((f: { key: string }) => f.key)).toContain("privacy_consent");
    expect(detail.data.draft).toBeNull();
  });

  it("answers 404 for forms of another club and for malformed ids (never 403/200)", async () => {
    const id = await aufnahmeId();
    const probes: Array<[string, string, unknown?]> = [
      ["GET", `/forms/${id}`],
      ["PUT", `/forms/${id}/draft`, { fields: [] }],
      ["DELETE", `/forms/${id}/draft`],
      ["POST", `/forms/${id}/publish`],
      ["POST", `/forms/${id}/archive`],
      ["GET", `/forms/${id}/versions`],
      ["GET", `/forms/${id}/versions/1`],
      ["PUT", `/forms/${id}/versions/1`, { fields: [] }],
      ["GET", "/forms/not-a-uuid"],
    ];
    for (const [method, path, payload] of probes) {
      const res = await call(otherBoard, path, { method, clubId: otherClubId, body: payload });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    // ... and the other club's own list does not contain it.
    expect((await list(otherBoard, otherClubId)).map((f) => f.id)).not.toContain(id);
    // The foreign attempts changed nothing.
    expect((await list()).find((f) => f.id === id)).toMatchObject({ publishedVersion: 1, draftVersion: null });
  });

  it("validates the field definition when saving a draft (422) and stores nothing", async () => {
    const id = await aufnahmeId();
    const bad = await call(board, `/forms/${id}/draft`, { method: "PUT", clubId, body: { fields: [{ key: "Bad Key", type: "text", label: "x" }] } });
    expect(bad.status).toBe(422);
    const mapping = await call(board, `/forms/${id}/draft`, { method: "PUT", clubId, body: { fields: [{ key: "evil", type: "text", label: "x", mapsTo: "id; DROP TABLE" }] } });
    expect(mapping.status).toBe(422);
    const missing = await call(board, `/forms/${id}/draft`, { method: "PUT", clubId, body: {} });
    expect(missing.status).toBe(422);
    expect((await list()).find((f) => f.id === id)!.draftVersion).toBeNull();
  });

  it("runs draft -> save again -> discard -> publish with version numbers 2.. and archives the previous version", async () => {
    const id = await aufnahmeId();
    const first = await call(board, `/forms/${id}/draft`, { method: "PUT", clubId, body: { fields: aufnahmeFields([{ key: "shirt", type: "text", label: "Trikotgröße" }]), privacyNotice: "Alt" } });
    expect(first.status).toBe(200);
    expect((await body(first)).data.draft).toMatchObject({ version: 2, status: "draft", privacyNotice: "Alt" });

    // Saving again updates the same draft; omitting privacyNotice keeps it.
    const again = await body(await call(schriftfuehrer, `/forms/${id}/draft`, { method: "PUT", clubId, body: { fields: aufnahmeFields([{ key: "shirt", type: "text", label: "Größe" }]), name: "Aufnahme 2026" } }));
    expect(again.data.draft).toMatchObject({ version: 2, privacyNotice: "Alt" });
    expect(again.data.form.name).toBe("Aufnahme 2026");

    // Discard, then a new draft reuses the number (it was never published) and copies the live privacy notice.
    expect((await call(board, `/forms/${id}/draft`, { method: "DELETE", clubId })).status).toBe(204);
    expect((await call(board, `/forms/${id}/draft`, { method: "DELETE", clubId })).status).toBe(404);
    const reopened = await body(await call(board, `/forms/${id}/draft`, { method: "PUT", clubId, body: { fields: aufnahmeFields([{ key: "shirt", type: "text", label: "Trikotgröße" }]) } }));
    expect(reopened.data.draft.version).toBe(2);
    expect(reopened.data.draft.privacyNotice).toContain("Wir verarbeiten");

    const published = await call(board, `/forms/${id}/publish`, { method: "POST", clubId });
    expect(published.status).toBe(200);
    expect((await body(published)).data.version).toMatchObject({ version: 2, status: "published", publishedBy: expect.any(String) });

    const versions = (await body(await call(board, `/forms/${id}/versions`, { clubId }))).data as Array<{ version: number; status: string }>;
    expect(versions.map((v) => `${v.version}:${v.status}`)).toEqual(["2:published", "1:archived"]);
    const v1 = await body(await call(board, `/forms/${id}/versions/1`, { clubId }));
    expect(v1.data.version.status).toBe("archived");
    expect(v1.data.version.fields.map((f: { key: string }) => f.key)).not.toContain("shirt");
    expect((await call(board, `/forms/${id}/versions/99`, { clubId })).status).toBe(404);
    expect((await call(board, `/forms/${id}/versions/abc`, { clubId })).status).toBe(404);

    // Applicants see the new version immediately.
    const slug = (await db.query.organization.findFirst({ where: (o, { eq: e }) => e(o.id, clubId) }))!.slug;
    const seen = await body(await call(plain, `/club-forms/${slug}/aufnahme`));
    expect(seen.data.version).toBe(2);
    expect(seen.data.fields.map((f: { key: string }) => f.key)).toContain("shirt");

    // Nothing left to publish.
    expect((await call(board, `/forms/${id}/publish`, { method: "POST", clubId })).status).toBe(409);
  });

  it("keeps published and archived versions immutable (409) and writes audit entries without field content", async () => {
    const id = await aufnahmeId();
    for (const n of [1, 2]) {
      const res = await call(board, `/forms/${id}/versions/${n}`, { method: "PUT", clubId, body: { fields: aufnahmeFields() } });
      expect(res.status, `version ${n}`).toBe(409);
      expect((await body(res)).error.details.code).toBe("version_immutable");
    }
    const rows = await db.select().from(formVersions).where(eq(formVersions.formId, id));
    expect(rows.find((v) => v.version === 2)!.fields).toEqual(expect.arrayContaining([expect.objectContaining({ key: "shirt", label: "Trikotgröße" })]));

    const audit = await db.select().from(auditLog).where(and(eq(auditLog.subjectId, id), eq(auditLog.eventType, "form.publish")));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.payload).toMatchObject({ clubId, version: 2, previousVersion: 1 });
    expect(JSON.stringify(audit[0]!.payload)).not.toContain("Trikotgröße");
  });

  it("lets PUT /versions/:n save the current draft only", async () => {
    const id = await aufnahmeId();
    const draft = await body(await call(board, `/forms/${id}/draft`, { method: "PUT", clubId, body: { fields: aufnahmeFields() } }));
    expect(draft.data.draft.version).toBe(3);
    const viaVersion = await call(board, `/forms/${id}/versions/3`, { method: "PUT", clubId, body: { fields: aufnahmeFields([{ key: "extra", type: "number", label: "Extra" }]) } });
    expect(viaVersion.status).toBe(200);
    expect((await body(viaVersion)).data.draft.fields.map((f: { key: string }) => f.key)).toContain("extra");
    expect((await call(board, `/forms/${id}/versions/7`, { method: "PUT", clubId, body: { fields: [] } })).status).toBe(404);
    expect((await call(board, `/forms/${id}/draft`, { method: "DELETE", clubId })).status).toBe(204);
  });

  it("keeps the type of a published key forever, but allows dropping and adding fields", async () => {
    const id = await aufnahmeId();
    const retyped = aufnahmeFields().map((f) => (f.key === "birth_date" ? { key: "birth_date", type: "text", label: "Geburtsdatum" } : f));
    const res = await call(board, `/forms/${id}/draft`, { method: "PUT", clubId, body: { fields: retyped } });
    expect(res.status).toBe(422);
    expect((await body(res)).error.details.problems).toEqual([{ code: "key_type_immutable", fieldKey: "birth_date" }]);

    // 'shirt' existed in v2 as text: re-adding it as a number is refused even after it was dropped in between.
    const dropped = await call(board, `/forms/${id}/draft`, { method: "PUT", clubId, body: { fields: aufnahmeFields() } });
    expect(dropped.status).toBe(200);
    const readded = await call(board, `/forms/${id}/draft`, { method: "PUT", clubId, body: { fields: aufnahmeFields([{ key: "shirt", type: "number", label: "Größe" }]) } });
    expect(readded.status).toBe(422);
    await call(board, `/forms/${id}/draft`, { method: "DELETE", clubId });
  });

  it("checks the aufnahme requirements and mapping targets before publishing", async () => {
    const id = await aufnahmeId();
    const publishWith = async (fields: unknown[], privacyNotice?: string | null) => {
      const saved = await call(board, `/forms/${id}/draft`, { method: "PUT", clubId, body: { fields, ...(privacyNotice !== undefined ? { privacyNotice } : {}) } });
      expect(saved.status).toBe(200);
      return call(board, `/forms/${id}/publish`, { method: "POST", clubId });
    };
    const codes = async (res: Response) => ((await body(res)).error.details.problems as Array<{ code: string }>).map((p) => p.code);

    const noNotice = aufnahmeFields().filter((f) => f.key !== "privacy_notice");
    const r1 = await publishWith(noNotice);
    expect(r1.status).toBe(422);
    expect(await codes(r1)).toEqual(["privacy_notice_missing"]);

    const r2 = await publishWith(aufnahmeFields(), "   ");
    expect(await codes(r2)).toEqual(["privacy_notice_text_missing"]);

    const optionalConsent = aufnahmeFields().map((f) => (f.key === "privacy_consent" ? { ...f, required: false } : f));
    expect(await codes(await publishWith(optionalConsent, "Text"))).toEqual(["required_consent_missing"]);

    const unknownCustom = aufnahmeFields([{ key: "allergy", type: "text", label: "Allergien", customField: "allergien" }]);
    expect(await codes(await publishWith(unknownCustom, "Text"))).toEqual(["custom_field_unknown"]);

    await db.insert(memberFieldDefinitions).values({ clubId, key: "allergien", label: "Allergien", fieldType: "textarea" });
    const mismatch = await publishWith(unknownCustom, "Text");
    expect(await codes(mismatch)).toEqual(["custom_field_type_mismatch"]);

    const ok = await publishWith(aufnahmeFields([{ key: "allergy", type: "textarea", label: "Allergien", customField: "allergien" }]), "Text");
    expect(ok.status).toBe(200);
    expect((await body(ok)).data.version.version).toBe(3);

    // An archived definition no longer counts.
    await db.update(memberFieldDefinitions).set({ archivedAt: new Date() }).where(and(eq(memberFieldDefinitions.clubId, clubId), eq(memberFieldDefinitions.key, "allergien")));
    expect(await codes(await publishWith(aufnahmeFields([{ key: "allergy", type: "textarea", label: "Allergien", customField: "allergien" }]), "Text"))).toEqual(["custom_field_unknown"]);
    await call(board, `/forms/${id}/draft`, { method: "DELETE", clubId });
  });

  it("allows mapping only on aufnahme forms", async () => {
    const austritt = (await list()).find((f) => f.purpose === "austritt")!;
    const saved = await call(board, `/forms/${austritt.id}/draft`, {
      method: "PUT",
      clubId,
      body: { fields: [{ key: "reason", type: "textarea", label: "Grund" }, { key: "street", type: "text", label: "Straße", mapsTo: "street" }] },
    });
    expect(saved.status).toBe(200);
    const res = await call(board, `/forms/${austritt.id}/publish`, { method: "POST", clubId });
    expect(res.status).toBe(422);
    expect((await body(res)).error.details.problems).toEqual([{ code: "mapping_not_allowed", fieldKey: "street" }]);
    await call(board, `/forms/${austritt.id}/draft`, { method: "DELETE", clubId });
  });

  it("publishes race-safely: two parallel publishes create exactly one new version", async () => {
    const id = await aufnahmeId();
    const before = (await list()).find((f) => f.id === id)!;
    await call(board, `/forms/${id}/draft`, { method: "PUT", clubId, body: { fields: aufnahmeFields([{ key: "race", type: "text", label: "Race" }]) } });
    const results = await Promise.all(Array.from({ length: 4 }, () => call(board, `/forms/${id}/publish`, { method: "POST", clubId })));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409, 409, 409]);
    const after = (await list()).find((f) => f.id === id)!;
    expect(after.versionCount).toBe(before.versionCount + 1);
    const rows = await db.select().from(formVersions).where(eq(formVersions.formId, id));
    expect(rows.filter((v) => v.status === "published")).toHaveLength(1);
    expect(rows.filter((v) => v.status === "draft")).toHaveLength(0);
  });

  it("creates forms of other purposes, refuses a second active aufnahme and archives", async () => {
    const dup = await call(board, "/forms", { method: "POST", clubId, body: { purpose: "aufnahme", name: "Zweites" } });
    expect(dup.status).toBe(409);
    expect((await body(dup)).error.details.code).toBe("form_purpose_exists");

    const created = await call(board, "/forms", { method: "POST", clubId, body: { purpose: "umfrage", name: "Sommerfest", fields: [{ key: "dish", type: "text", label: "Gericht" }] } });
    expect(created.status).toBe(201);
    const { form, draft } = (await body(created)).data;
    expect(draft).toMatchObject({ version: 1, status: "draft" });
    expect((await call(board, "/forms", { method: "POST", clubId, body: { purpose: "umfrage", name: "Noch eins" } })).status).toBe(201);
    expect((await call(board, "/forms", { method: "POST", clubId, body: { purpose: "nonsense", name: "x" } })).status).toBe(422);
    expect((await call(board, "/forms", { method: "POST", clubId, body: { purpose: "umfrage", name: "x", fields: [{ key: "a", type: "bogus", label: "x" }] } })).status).toBe(422);

    expect((await call(board, `/forms/${form.id}/publish`, { method: "POST", clubId })).status).toBe(200);
    expect((await call(board, `/forms/${form.id}/archive`, { method: "POST", clubId })).status).toBe(200);
    expect((await call(board, `/forms/${form.id}/archive`, { method: "POST", clubId })).status).toBe(409);
    expect((await call(board, `/forms/${form.id}/draft`, { method: "PUT", clubId, body: { fields: [] } })).status).toBe(409);
    expect((await call(board, `/forms/${form.id}/publish`, { method: "POST", clubId })).status).toBe(409);
    const versions = (await body(await call(board, `/forms/${form.id}/versions`, { clubId }))).data as Array<{ status: string }>;
    expect(versions.map((v) => v.status)).toEqual(["archived"]);
    expect((await list()).map((f) => f.id)).not.toContain(form.id);
    const withArchived = (await body(await call(board, "/forms?includeArchived=true&purpose=umfrage", { clubId }))).data as Array<{ id: string }>;
    expect(withArchived.map((f) => f.id)).toContain(form.id);
  });

  it("resets to a fresh standard form when the aufnahme form is archived", async () => {
    const oldId = await aufnahmeId();
    expect((await call(board, `/forms/${oldId}/archive`, { method: "POST", clubId })).status).toBe(200);
    expect((await db.select().from(forms).where(eq(forms.id, oldId)))[0]!.archivedAt).not.toBeNull();
    const fresh = (await list()).find((f) => f.purpose === "aufnahme")!;
    expect(fresh.id).not.toBe(oldId);
    expect(fresh).toMatchObject({ publishedVersion: 1, versionCount: 1 });
  });

  it("serves applicants the published definition only: no admin data, no draft, options resolved", async () => {
    const id = await aufnahmeId();
    await call(board, `/forms/${id}/draft`, { method: "PUT", clubId, body: { fields: aufnahmeFields([{ key: "secret_draft", type: "text", label: "Nur Entwurf", customField: "x" }]) } });
    const slug = (await db.query.organization.findFirst({ where: (o, { eq: e }) => e(o.id, clubId) }))!.slug;
    const res = await call(plain, `/club-forms/${slug}/aufnahme`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("private");
    const def = (await body(res)).data;
    expect(Object.keys(def).sort()).toEqual(["fields", "formId", "formVersionId", "name", "privacyNotice", "purpose", "version"]);
    const text = JSON.stringify(def);
    expect(text).not.toContain("secret_draft");
    expect(text).not.toContain("mapsTo");
    expect(text).not.toContain("customField");
    const category = def.fields.find((f: { key: string }) => f.key === "category");
    expect(category.options.map((o: { value: string }) => o.value)).toContain("aktiv");
    await call(board, `/forms/${id}/draft`, { method: "DELETE", clubId });

    expect((await call(plain, "/club-forms/does-not-exist/aufnahme")).status).toBe(404);
    expect((await app.request(`/club-forms/${slug}/aufnahme`)).status).toBe(401);
  });
});
