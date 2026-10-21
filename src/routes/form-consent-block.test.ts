import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDatabase, db } from "../db/client.js";
import { clubMembers } from "../db/schema/club-members.js";
import { consentPurposes, consentRecords } from "../db/schema/privacy.js";
import { clubApplicationRoutes } from "./club-applications.js";
import { clubMemberRoutes } from "./club-members.js";
import { consentPurposeRoutes } from "./consent-purposes.js";
import { aufnahmeFields, createClub, dropClubs, installErrorHandler, requester, signUpAndVerify } from "./forms-test-support.js";
import { formRoutes } from "./forms.js";

/**
 * Wave 10 B3: the form builder's consent block (`purposeKey`) records the SAME consent events as the consent routes when the
 * application is accepted -- voluntary, never required, and an unavailable purpose never blocks the acceptance.
 */

const app = new Hono();
app.route("/forms", formRoutes);
app.route("/consent-purposes", consentPurposeRoutes);
app.route("/club-applications", clubApplicationRoutes);
app.route("/club-members", clubMemberRoutes);
installErrorHandler(app);
const call = requester(app);
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const suffix = Date.now();

describe("form builder consent block (purposeKey)", () => {
  let club: Awaited<ReturnType<typeof createClub>>;
  const applicants: string[] = [];
  let fotoPurposeId: string;

  beforeAll(async () => {
    club = await createClub("cblock", suffix);
    const purposes = (await (await call(club.founder, "/consent-purposes", { clubId: club.clubId })).json()) as Json;
    fotoPurposeId = purposes.data.find((p: Json) => p.key === "foto_video").id;
    expect((await call(club.founder, `/consent-purposes/${fotoPurposeId}/texts`, { method: "POST", clubId: club.clubId, body: { body: "Fotos beim Training dürfen verwendet werden." } })).status).toBe(201);

    const forms = (await (await call(club.founder, "/forms", { clubId: club.clubId })).json()) as Json;
    const formId = forms.data.find((f: Json) => f.purpose === "aufnahme").id;
    const fields = aufnahmeFields([
      { key: "foto_ok", type: "consent", label: "Fotos dürfen verwendet werden (freiwillig)", purposeKey: "foto_video" },
      { key: "verteiler_ok", type: "consent", label: "Verteiler", purposeKey: "messenger_verteiler" }, // purpose has no text yet
      { key: "gibts_nicht", type: "consent", label: "Unbekannt", purposeKey: "gibts_nicht" },
    ]);
    expect((await call(club.founder, `/forms/${formId}/draft`, { method: "PUT", clubId: club.clubId, body: { fields } })).status).toBe(200);
    expect((await call(club.founder, `/forms/${formId}/publish`, { method: "POST", clubId: club.clubId })).status).toBe(200);
  }, 60_000);

  afterAll(async () => {
    await dropClubs([club.clubId], [...club.userIds, ...applicants]);
    await closeDatabase();
  });

  it("refuses a required consent for a purpose (voluntary) and a purposeKey on other field types", async () => {
    const forms = (await (await call(club.founder, "/forms", { clubId: club.clubId })).json()) as Json;
    const formId = forms.data.find((f: Json) => f.purpose === "aufnahme").id;
    const required = await call(club.founder, `/forms/${formId}/draft`, { method: "PUT", clubId: club.clubId, body: { fields: aufnahmeFields([{ key: "foto_ok", type: "consent", label: "Fotos", required: true, purposeKey: "foto_video" }]) } });
    expect(required.status).toBe(422);
    const wrongType = await call(club.founder, `/forms/${formId}/draft`, { method: "PUT", clubId: club.clubId, body: { fields: aufnahmeFields([{ key: "foto_ok", type: "text", label: "Fotos", purposeKey: "foto_video" }]) } });
    expect(wrongType.status).toBe(422);
  });

  async function applyAndApprove(label: string, answers: Record<string, unknown>) {
    const who = await signUpAndVerify(`cblock-${label}-${suffix}@example.com`, `Applicant ${label}`);
    applicants.push(who.userId);
    const apply = await call(who, "/club-members/apply", { method: "POST", body: { clubId: club.clubId, answers: { category: "aktiv", privacy_consent: true, ...answers } } });
    expect(apply.status).toBe(201);
    const applicationId = ((await apply.json()) as Json).data.application.id as string;
    const approve = await call(club.founder, `/club-applications/${applicationId}/approve`, { method: "POST", clubId: club.clubId });
    expect(approve.status).toBe(200);
    const body = (await approve.json()) as Json;
    return { who, member: body.data.clubMember as Json, mapping: body.data.mapping as Json };
  }

  it("records a granted consent through the shared service when the application is accepted", async () => {
    const { who, member, mapping } = await applyAndApprove("yes", { foto_ok: true, verteiler_ok: true, gibts_nicht: true });
    const rows = await db.select().from(consentRecords).where(eq(consentRecords.clubMemberId, member.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ purposeId: fotoPurposeId, action: "granted", givenBy: "self", recordedByUserId: who.userId, proofDate: null });
    // The two unavailable purposes are skipped and reported, the acceptance succeeded.
    expect(mapping.skipped.map((s: Json) => s.reason).sort()).toEqual(["consent_purpose_unknown", "consent_unavailable"]);
    // Visible to the member like any other consent.
    const view = (await (await call(who, `/club-members/${member.id}/consents`, { clubId: club.clubId })).json()) as Json;
    expect(view.data.consents.find((c: Json) => c.key === "foto_video")).toMatchObject({ state: "granted", givenBy: "self" });
  });

  it("an unticked box records nothing and the member is accepted all the same", async () => {
    const { member } = await applyAndApprove("no", { foto_ok: false });
    expect(await db.select().from(consentRecords).where(and(eq(consentRecords.clubMemberId, member.id), eq(consentRecords.purposeId, fotoPurposeId)))).toHaveLength(0);
    const row = await db.query.clubMembers.findFirst({ where: eq(clubMembers.id, member.id) });
    expect(row?.status).toBe("aktiv");
    const [purpose] = await db.select().from(consentPurposes).where(eq(consentPurposes.id, fotoPurposeId));
    expect(purpose?.requested).toBe(false);
  });
});
