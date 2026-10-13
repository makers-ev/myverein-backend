import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { db, closeDatabase } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { clubExitRequests } from "../db/schema/club-exit-requests.js";
import { clubMembers } from "../db/schema/club-members.js";
import { forms, formSubmissions } from "../db/schema/forms.js";
import { earliestExitDate } from "../lib/exit-notice.js";
import { loadClubSettings } from "../lib/club-settings.js";
import { logger } from "../lib/logger.js";
import { todayBerlin } from "../lib/member-lifecycle.js";
import { clubExitRequestRoutes } from "./club-exit-requests.js";
import { clubMemberRoutes } from "./club-members.js";
import { formRoutes } from "./forms.js";
import { formSubmissionRoutes } from "./form-submissions.js";
import { createClub, dropClubs, installErrorHandler, requester, signUpAndVerify, type Account } from "./forms-test-support.js";

/**
 * Exit form (Wave 8 B9) against a real Postgres: the standard form, answers validated by the engine, the submission linked
 * from the exit request and following its lifecycle, the notice logic and the owner/board protections untouched, review
 * rendering against the original version with sensitive fields, IDOR and privacy.
 */

const app = new Hono();
app.route("/club-exit-requests", clubExitRequestRoutes);
app.route("/club-members", clubMemberRoutes);
app.route("/forms", formRoutes);
app.route("/form-submissions", formSubmissionRoutes);
installErrorHandler(app);
const call = requester(app);
const suffix = Date.now();
const SECRET = "UMZUG-GEHEIMGRUND-4711";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed response helper
const body = async (res: Response) => (await res.json()) as any;

describe("exit form (B9)", () => {
  let club: Awaited<ReturnType<typeof createClub>>;
  let other: Awaited<ReturnType<typeof createClub>>;
  const extra: Account[] = [];
  const logged: unknown[][] = [];

  const exitForm = (who: Account, target = club) => call(who, "/club-exit-requests/form", { clubId: target.clubId });
  const post = (who: Account, payload: Record<string, unknown>, target = club) => call(who, "/club-exit-requests", { method: "POST", clubId: target.clubId, body: payload });
  const get = (who: Account, id: string, target = club) => call(who, `/club-exit-requests/${id}`, { clubId: target.clubId });
  const act = (who: Account, id: string, action: string, payload: Record<string, unknown> = {}) => call(who, `/club-exit-requests/${id}/${action}`, { method: "POST", clubId: club.clubId, body: payload });
  const submissionOf = async (requestId: string) => {
    const request = (await db.query.clubExitRequests.findFirst({ where: eq(clubExitRequests.id, requestId) }))!;
    return { request, submission: request.formSubmissionId ? await db.query.formSubmissions.findFirst({ where: eq(formSubmissions.id, request.formSubmissionId) }) : undefined };
  };
  const newMember = async (label: string) => {
    const acc = await signUpAndVerify(`exit-${label}-${suffix}@example.com`, `Exit ${label}`);
    extra.push(acc);
    const { auth } = await import("../auth/auth.js");
    await auth.api.addMember({ body: { userId: acc.userId, organizationId: club.clubId, role: "member" } });
    return acc;
  };

  beforeAll(async () => {
    club = await createClub("exf", suffix, { schriftfuehrer: "schriftfuehrer", kassenwart: "kassenwart", plain: null });
    other = await createClub("exfo", suffix, { plain: null });
    for (const level of ["info", "warn", "error", "debug"] as const) {
      vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => {
        logged.push(args);
      }) as never);
    }
  }, 90_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await dropClubs([club.clubId, other.clubId], [...club.userIds, ...other.userIds, ...extra.map((a) => a.userId)]);
    await closeDatabase();
  });

  it("serves the standard exit form to members only, definition without admin data", async () => {
    const res = await exitForm(club.members.plain!);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("private");
    const def = (await body(res)).data;
    expect(def).toMatchObject({ purpose: "austritt", version: 1 });
    expect(def.fields.map((f: { key: string }) => f.key)).toEqual(["reason", "confirm"]);
    expect(JSON.stringify(def)).not.toContain("mapsTo");
    // Not a member of that club: indistinguishable from an unknown club.
    expect((await exitForm(club.members.plain!, other)).status).toBe(404);
    expect((await app.request(`/club-exit-requests/form?clubId=${club.clubId}`)).status).toBe(401);
  });

  it("stores the answers as a submission linked from the request; the dates still come from the notice rules", async () => {
    const who = club.members.plain!;
    const form = (await body(await exitForm(who))).data;
    const res = await post(who, { answers: { reason: SECRET, confirm: true }, formVersionId: form.formVersionId });
    expect(res.status, await res.clone().text()).toBe(201);
    const data = (await body(res)).data;
    expect(data.formSubmissionId).toBeTruthy();
    // The answers live in the submission only: the request column (and later the status history) gets only an explicit `reason`.
    expect(data.reason).toBeNull();
    // The notice logic is the club's: earliest date from club_settings, no field can change it.
    const settings = await loadClubSettings(db, club.clubId);
    expect(data.earliestEffectiveOn).toBe(earliestExitDate(todayBerlin(), settings));
    expect(data.status).toBe("pending");

    const { request, submission } = await submissionOf(data.id);
    expect(submission).toMatchObject({ status: "submitted", onBehalfOf: "self", submittedByUserId: who.userId, formVersionId: form.formVersionId, clubId: club.clubId });
    const memberRow = (await db.query.clubMembers.findFirst({ where: eq(clubMembers.id, request.clubMemberId) }))!;
    expect(submission!.subjectClubMemberId).toBe(memberRow.id);
    expect(memberRow.status).toBe("aktiv");

    // Audit: ids only.
    const audit = (await db.select().from(auditLog).where(and(eq(auditLog.eventType, "club_exit_request.create"), eq(auditLog.subjectId, data.id))))[0]!;
    expect(audit.payload).toMatchObject({ formSubmissionId: submission!.id, formVersionId: form.formVersionId });
    expect(JSON.stringify(audit.payload)).not.toContain(SECRET);
    await act(club.founder, data.id, "reject", { note: "cleanup" });
  });

  it("validates with the form engine and creates nothing for a bad request", async () => {
    const who = await newMember("invalid");
    const count = async () => (await db.select().from(formSubmissions).where(eq(formSubmissions.submittedByUserId, who.userId))).length;
    for (const [answers, fields] of [
      [{ reason: SECRET, confirm: false }, { confirm: "required" }],
      [{ reason: SECRET }, { confirm: "required" }],
      [{ confirm: true, bogus: SECRET }, { bogus: "unknown_field" }],
      [{ confirm: true, reason: "x".repeat(1001) }, { reason: "too_long" }],
    ] as const) {
      const res = await post(who, { answers });
      expect(res.status).toBe(422);
      const text = await res.text();
      expect(JSON.parse(text).error.details.fields).toEqual(fields);
      expect(text).not.toContain(SECRET);
    }
    expect((await post(who, { answers: "nope" })).status).toBe(422);
    expect((await post(who, { answers: [1] })).status).toBe(422);
    expect((await post(who, { formVersionId: "00000000-0000-4000-8000-000000000001" })).status).toBe(422);
    expect(await count()).toBe(0);
    expect(await db.select().from(clubExitRequests).where(eq(clubExitRequests.requestedBy, (await db.query.member.findFirst({ where: (m, { and: both, eq: same }) => both(same(m.organizationId, club.clubId), same(m.userId, who.userId)) }))!.id))).toHaveLength(0);
    // A stale version carries the current definition.
    const stale = await post(who, { answers: { confirm: true }, formVersionId: "00000000-0000-4000-8000-000000000001" });
    expect(stale.status).toBe(409);
    const staleError = (await body(stale)).error;
    expect(staleError).toMatchObject({ code: "FORM_VERSION_OUTDATED" });
    expect(staleError.details.currentVersion.purpose).toBe("austritt");
  });

  it("keeps requests without answers exactly as before and refuses answers for an exclusion", async () => {
    const who = await newMember("legacy");
    const res = await post(who, { reason: "kein Formular" });
    expect(res.status).toBe(201);
    const data = (await body(res)).data;
    expect(data).toMatchObject({ formSubmissionId: null, reason: "kein Formular" });
    expect((await get(who, data.id).then(body)).data.submission).toBeNull();
    await act(club.founder, data.id, "reject", { note: "cleanup" });

    const target = await newMember("exclusion");
    const targetRow = (await db.query.clubMembers.findFirst({ where: (t, { inArray }) => inArray(t.lastUserId, [target.userId]) }))!;
    const excl = await post(club.members.schriftfuehrer!, { kind: "exclusion", clubMemberId: targetRow.id, reason: "Grund", answers: { confirm: true } });
    expect(excl.status).toBe(422);
    expect(await db.select().from(formSubmissions).where(eq(formSubmissions.clubId, club.clubId))).not.toContainEqual(expect.objectContaining({ subjectClubMemberId: targetRow.id }));
  });

  it("double submit leaves exactly one request and one submission; the explicit reason wins over the form's", async () => {
    const who = await newMember("double");
    const results = await Promise.all([post(who, { answers: { confirm: true, reason: "A" } }), post(who, { answers: { confirm: true, reason: "B" } })]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const mine = await db.select().from(formSubmissions).where(eq(formSubmissions.submittedByUserId, who.userId));
    expect(mine).toHaveLength(1);
    const win = results.find((r) => r.status === 201)!;
    const data = (await body(win)).data;
    await act(club.founder, data.id, "reject", { note: "cleanup" });

    const withReason = await post(who, { reason: "Ausdrücklich", answers: { confirm: true, reason: "Formulargrund" } });
    expect(withReason.status).toBe(201);
    const withReasonData = (await body(withReason)).data;
    expect(withReasonData.reason).toBe("Ausdrücklich");
    await act(club.founder, withReasonData.id, "reject", { note: "cleanup" });
  });

  it("follows the request: approve -> accepted, reject -> rejected, withdraw -> withdrawn (and the generic routes cannot touch it)", async () => {
    const approvedBy = await newMember("approve");
    const a = (await body(await post(approvedBy, { answers: { confirm: true, reason: SECRET } }))).data;
    // The submission cannot be changed or withdrawn behind the request's back.
    const sub = (await submissionOf(a.id)).submission!;
    expect((await call(approvedBy, `/form-submissions/${sub.id}/withdraw`, { method: "POST" })).status).toBe(409);
    expect((await call(approvedBy, `/form-submissions/${sub.id}`, { method: "PATCH", body: { answers: { reason: "x" } } })).status).toBe(409);
    expect((await call(approvedBy, `/form-submissions/${sub.id}/submit`, { method: "POST", body: {} })).status).toBe(409);
    // Foreign members cannot read it.
    expect((await call(club.members.plain!, `/form-submissions/${sub.id}`)).status).toBe(404);

    const approved = await act(club.founder, a.id, "approve");
    expect(approved.status, await approved.clone().text()).toBe(200);
    const done = (await submissionOf(a.id)).submission!;
    expect(done.status).toBe("accepted");
    expect(done.decidedAt).not.toBeNull();
    // The status change is the exit workflow's (unchanged): effective today means left.
    const row = (await db.query.clubMembers.findFirst({ where: eq(clubMembers.id, (await submissionOf(a.id)).request.clubMemberId) }))!;
    expect(["ausgetreten", "aktiv"]).toContain(row.status);

    const rejectedBy = await newMember("reject");
    const r = (await body(await post(rejectedBy, { answers: { confirm: true } }))).data;
    expect((await act(club.founder, r.id, "reject", { note: "Nein" })).status).toBe(200);
    expect((await submissionOf(r.id)).submission!.status).toBe("rejected");

    const withdrawnBy = await newMember("withdraw");
    const w = (await body(await post(withdrawnBy, { answers: { confirm: true } }))).data;
    expect((await call(withdrawnBy, `/club-exit-requests/${w.id}/withdraw`, { method: "POST", clubId: club.clubId, body: {} })).status).toBe(200);
    expect((await submissionOf(w.id)).submission!.status).toBe("withdrawn");

    // An exclusion replaces a pending cancellation and closes its submission.
    const replaced = await newMember("replaced");
    const p = (await body(await post(replaced, { answers: { confirm: true } }))).data;
    const targetRow = (await db.query.clubMembers.findFirst({ where: eq(clubMembers.id, (await submissionOf(p.id)).request.clubMemberId) }))!;
    expect((await post(club.founder, { kind: "exclusion", clubMemberId: targetRow.id, reason: "Ausschluss" })).status).toBe(201);
    expect((await submissionOf(p.id)).submission!.status).toBe("rejected");
  });

  it("keeps the owner and board protections: nothing is stored when the exit is refused", async () => {
    const before = (await db.select().from(formSubmissions).where(eq(formSubmissions.clubId, club.clubId))).length;
    // The board (schriftfuehrer) records a cancellation for the club owner, with an answer set.
    const ownerRow = (await db.query.clubMembers.findFirst({ where: (t, { and: both, eq: same, isNotNull }) => both(same(t.clubId, club.clubId), isNotNull(t.memberId)) , orderBy: (t, { asc }) => [asc(t.createdAt)] }))!;
    const res = await post(club.members.schriftfuehrer!, { clubMemberId: ownerRow.id, answers: { confirm: true } });
    expect([409, 403]).toContain(res.status);
    expect(["owner_protected", "board_protected"]).toContain((await body(res)).error.details.code);
    // The owner cannot cancel themself either.
    const own = await post(club.founder, { answers: { confirm: true } });
    expect(own.status).toBe(409);
    expect((await body(own)).error.details.code).toBe("owner_protected");
    expect((await db.select().from(formSubmissions).where(eq(formSubmissions.clubId, club.clubId))).length).toBe(before);
    // A plain member cannot record for someone else, with or without answers.
    expect((await post(club.members.plain!, { clubMemberId: ownerRow.id, answers: { confirm: true } })).status).toBe(403);
  });

  it("renders the board review against the ORIGINAL version, redacts sensitive answers and hides them from outsiders", async () => {
    // v2 adds a sensitive field and changes a label; requests filed with v1 keep v1.
    const exitFormRow = (await db.select().from(forms).where(and(eq(forms.clubId, club.clubId), eq(forms.purpose, "austritt"))))[0]!;
    const first = await newMember("review1");
    const old = (await body(await post(first, { answers: { confirm: true, reason: SECRET } }))).data;
    const fields = [
      { key: "reason", type: "textarea", label: "Warum gehst du? (neu)", validation: { maxLength: 1000 } },
      { key: "health", type: "textarea", label: "Gesundheit", sensitive: true },
      { key: "destination", type: "select", label: "Wohin?", options: [{ value: "a", label: "Anderer Verein" }, { value: "b", label: "Kein Verein" }] },
      { key: "confirm", type: "checkbox", label: "Ich möchte meine Mitgliedschaft beenden.", required: true },
    ];
    expect((await call(club.founder, `/forms/${exitFormRow.id}/draft`, { method: "PUT", clubId: club.clubId, body: { fields } })).status).toBe(200);
    expect((await call(club.founder, `/forms/${exitFormRow.id}/publish`, { method: "POST", clubId: club.clubId })).status).toBe(200);

    const second = await newMember("review2");
    const fresh = (await body(await post(second, { answers: { confirm: true, health: "KRANKHEIT-4712", destination: "b" } }))).data;

    // Original version for the old request: its own label, no new fields.
    const oldView = (await body(await get(club.founder, old.id))).data;
    expect(oldView.submission.version).toBe(1);
    expect(oldView.submission.answers.map((a: { key: string; label: string }) => [a.key, a.label])).toEqual([
      ["reason", "Grund (optional)"],
      ["confirm", "Ich möchte meine Mitgliedschaft beenden."],
    ]);
    expect(oldView.submission.answers[0]).toMatchObject({ value: SECRET, display: SECRET, answered: true, redacted: false });

    // Founder (members:read_sensitive) sees the sensitive answer, the Schriftführer (members:write only) does not.
    const asFounder = (await body(await get(club.founder, fresh.id))).data.submission;
    expect(asFounder.version).toBe(2);
    expect(asFounder.answers.find((a: { key: string }) => a.key === "health")).toMatchObject({ value: "KRANKHEIT-4712", redacted: false, sensitive: true });
    expect(asFounder.answers.find((a: { key: string }) => a.key === "destination")).toMatchObject({ value: "b", display: "Kein Verein" });
    const asBoard = await get(club.members.schriftfuehrer!, fresh.id);
    const boardText = await asBoard.text();
    expect(boardText).not.toContain("KRANKHEIT-4712");
    expect(JSON.parse(boardText).data.submission.answers.find((a: { key: string }) => a.key === "health")).toMatchObject({ value: null, display: null, redacted: true });
    // The submitter sees their own answers; another member and another club cannot see the request at all.
    const own = (await body(await get(second, fresh.id))).data.submission;
    expect(own.answers.find((a: { key: string }) => a.key === "health").value).toBe("KRANKHEIT-4712");
    expect((await get(club.members.plain!, fresh.id)).status).toBe(404);
    expect((await get(other.founder, fresh.id, other)).status).toBe(404);

    // The list carries the link only (no answers).
    const list = await call(club.founder, "/club-exit-requests?status=pending", { clubId: club.clubId });
    const listText = await list.text();
    expect(listText).not.toContain("KRANKHEIT-4712");
    expect(JSON.parse(listText).data.find((r: { id: string }) => r.id === fresh.id).formSubmissionId).toBeTruthy();
    await act(club.founder, fresh.id, "reject", { note: "cleanup" });
  });

  it("closes the exit form together with the request on a direct status change and audits sensitive deliveries", async () => {
    const who = await newMember("direct");
    const r = (await body(await post(who, { answers: { confirm: true } }))).data;
    const row = (await db.query.clubMembers.findFirst({ where: eq(clubMembers.id, (await submissionOf(r.id)).request.clubMemberId) }))!;
    const moved = await call(club.founder, `/club-members/${row.id}/transition`, { method: "POST", clubId: club.clubId, body: { toStatus: "ausgetreten", reason: "direkt" } });
    expect(moved.status, await moved.clone().text()).toBe(200);
    const after = await submissionOf(r.id);
    expect(after.request.status).toBe("rejected");
    expect(after.submission!.status).toBe("rejected");

    // Reading sensitive answers of someone else's request is audited with keys only.
    const exitFormRow = (await db.select().from(forms).where(and(eq(forms.clubId, club.clubId), eq(forms.purpose, "austritt"))))[0]!;
    const fields = [
      { key: "health", type: "textarea", label: "Gesundheit", sensitive: true },
      { key: "confirm", type: "checkbox", label: "Ich möchte meine Mitgliedschaft beenden.", required: true },
    ];
    expect((await call(club.founder, `/forms/${exitFormRow.id}/draft`, { method: "PUT", clubId: club.clubId, body: { fields } })).status).toBe(200);
    expect((await call(club.founder, `/forms/${exitFormRow.id}/publish`, { method: "POST", clubId: club.clubId })).status).toBe(200);
    const second = await newMember("sensaudit");
    const fresh = (await body(await post(second, { answers: { confirm: true, health: "AUDIT-GEHEIM" } }))).data;
    const read = await get(club.founder, fresh.id);
    expect(read.headers.get("cache-control")).toContain("no-store");
    expect((await get(club.members.schriftfuehrer!, fresh.id)).status).toBe(200);
    await get(second, fresh.id);
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.eventType, "club_exit_request.sensitive_read"), eq(auditLog.subjectId, fresh.id)));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.payload).toMatchObject({ fieldKeys: ["health"] });
    expect(JSON.stringify(audits[0]!.payload)).not.toContain("AUDIT-GEHEIM");
    // The sensitive text is nowhere in the request columns.
    expect(JSON.stringify(await db.select().from(clubExitRequests).where(eq(clubExitRequests.id, fresh.id)))).not.toContain("AUDIT-GEHEIM");
    await act(club.founder, fresh.id, "reject", { note: "cleanup" });
  });

  it("keeps the answers out of logs and audit entries", async () => {
    const audits = JSON.stringify(await db.select().from(auditLog).where(eq(auditLog.eventType, "club_exit_request.create")));
    expect(audits).not.toContain(SECRET);
    expect(audits).not.toContain("KRANKHEIT-4712");
    const dump = JSON.stringify(logged);
    expect(dump).not.toContain(SECRET);
    expect(dump).not.toContain("KRANKHEIT-4712");
  });
});
