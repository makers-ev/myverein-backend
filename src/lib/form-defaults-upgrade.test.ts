import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { organization, user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { forms, formVersions } from "../db/schema/forms.js";
import { DEFAULT_APPLICATION_FIELDS, DEFAULT_PRIVACY_NOTICE, ensureDefaultForms, LEGACY_DEFAULT_APPLICATION_FIELDS } from "./form-defaults.js";

/** Wave 10 B11: the standard application form carries no mandatory consent; an untouched legacy standard form is replaced lazily. */

const suffix = Date.now();
let owner: string;
const clubs: string[] = [];

async function club(label: string): Promise<string> {
  const id = (await auth.api.createOrganization({ body: { name: `Fd ${label} ${suffix}`, slug: `fd-${label}-${suffix}`, userId: owner } }))!.id;
  clubs.push(id);
  return id;
}
const aufnahme = async (clubId: string) => (await db.query.forms.findFirst({ where: and(eq(forms.clubId, clubId), eq(forms.purpose, "aufnahme")) }))!;
const versionsOf = async (formId: string) => (await db.select().from(formVersions).where(eq(formVersions.formId, formId))).sort((x, y) => x.version - y.version);

beforeAll(async () => {
  owner = (await auth.api.createUser({ body: { email: `fd-${suffix}@example.test`, password: "test-password-123!", name: "Fd" } })).user.id;
}, 60_000);

afterAll(async () => {
  for (const id of clubs) await db.delete(organization).where(eq(organization.id, id));
  await db.delete(user).where(eq(user.id, owner));
  await closeDatabase();
});

describe("standard application form without a mandatory consent", () => {
  it("is what a new club gets", async () => {
    const id = await club("new");
    await ensureDefaultForms(id);
    const [v1, ...rest] = await versionsOf((await aufnahme(id)).id);
    expect(rest).toEqual([]);
    expect(v1).toMatchObject({ version: 1, status: "published" });
    expect(v1!.fields).toEqual(JSON.parse(JSON.stringify(DEFAULT_APPLICATION_FIELDS)));
    expect((v1!.fields as Array<{ type: string }>).some((f) => f.type === "consent")).toBe(false);
  });

  it("replaces an untouched legacy standard form by the current one, keeps the old version as proof and moves an open draft up", async () => {
    const id = await club("legacy");
    await ensureDefaultForms(id);
    const form = await aufnahme(id);
    const [v1] = await versionsOf(form.id);
    await db.update(formVersions).set({ fields: [...LEGACY_DEFAULT_APPLICATION_FIELDS] }).where(eq(formVersions.id, v1!.id));
    const [draft] = await db.insert(formVersions).values({ formId: form.id, version: 2, status: "draft", fields: [...LEGACY_DEFAULT_APPLICATION_FIELDS], privacyNotice: DEFAULT_PRIVACY_NOTICE }).returning();

    await ensureDefaultForms(id);
    const after = await versionsOf(form.id);
    expect(after.map((v) => [v.version, v.status])).toEqual([[1, "archived"], [2, "published"], [3, "draft"]]);
    expect(after[0]!.fields).toEqual(JSON.parse(JSON.stringify(LEGACY_DEFAULT_APPLICATION_FIELDS)));
    expect(after[1]!.fields).toEqual(JSON.parse(JSON.stringify(DEFAULT_APPLICATION_FIELDS)));
    expect(after[2]!.id).toBe(draft!.id);

    await ensureDefaultForms(id); // idempotent
    expect((await versionsOf(form.id)).length).toBe(3);
  });

  it("leaves a form the board changed alone", async () => {
    const id = await club("touched");
    await ensureDefaultForms(id);
    const form = await aufnahme(id);
    const [v1] = await versionsOf(form.id);
    const touched = [...LEGACY_DEFAULT_APPLICATION_FIELDS, { key: "extra", type: "text", label: "Extra", required: false }];
    await db.update(formVersions).set({ fields: touched }).where(eq(formVersions.id, v1!.id));
    await ensureDefaultForms(id);
    const after = await versionsOf(form.id);
    expect(after).toHaveLength(1);
    expect(after[0]!.fields).toEqual(JSON.parse(JSON.stringify(touched)));
  });
});
