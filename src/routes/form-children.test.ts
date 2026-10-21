import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { member, user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { clubApplications } from "../db/schema/club-applications.js";
import { clubMembers, clubMemberStatusHistory } from "../db/schema/club-members.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { formSubmissions } from "../db/schema/forms.js";
import { guardianLinks } from "../db/schema/guardian-links.js";
import { compensateAbortedApproval } from "../lib/form-applications.js";
import { countOpenChildApplications, MAX_OPEN_CHILD_APPLICATIONS } from "../lib/form-children.js";
import { logger } from "../lib/logger.js";
import { makePng } from "../lib/media-fixtures.js";
import { clubApplicationRoutes } from "./club-applications.js";
import { clubFormRoutes } from "./club-forms.js";
import { clubMemberRoutes } from "./club-members.js";
import { formRoutes } from "./forms.js";
import { formSubmissionRoutes } from "./form-submissions.js";
import { createClub, dropClubs, installErrorHandler, requester, signUpAndVerify, type Account } from "./forms-test-support.js";

/**
 * Child application by a parent (Wave 8 B8) against a real Postgres: the form must name the child, the parent is the
 * submitter, acceptance creates an account-less club member plus the guardian link (and an external role for a new parent),
 * several children per parent, the cap, the relaxed ALREADY_MEMBER rule for this case only, no self-assignment of wards,
 * consent evidence and privacy (no child data in logs or audit entries).
 */

const app = new Hono();
app.route("/club-members", clubMemberRoutes);
app.route("/club-applications", clubApplicationRoutes);
app.route("/forms", formRoutes);
app.route("/club-forms", clubFormRoutes);
app.route("/form-submissions", formSubmissionRoutes);
installErrorHandler(app);
const call = requester(app);
const suffix = Date.now();
const CHILD_FIRST = "Kinderlein";
const CHILD_LAST = "Geheimname";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed response helper
const body = async (res: Response) => (await res.json()) as any;

const FIELDS = [
  { key: "first_name", type: "text", label: "Vorname des Kindes", required: true, mapsTo: "firstName" },
  { key: "last_name", type: "text", label: "Nachname des Kindes", required: true, mapsTo: "lastName" },
  { key: "category", type: "select", label: "Mitgliedschaft", required: true, optionsSource: "member_categories", mapsTo: "category" },
  { key: "birth_date", type: "date", label: "Geburtsdatum", mapsTo: "birthDate" },
  { key: "photo", type: "image", label: "Foto", mapsTo: "photo" },
  { key: "privacy_notice", type: "info", infoKind: "privacy_notice", label: "Datenschutz" },
  { key: "privacy_consent", type: "consent", label: "Ich willige für mein Kind ein.", required: false },
];
const child = (over: Record<string, unknown> = {}) => ({ first_name: CHILD_FIRST, last_name: CHILD_LAST, category: "jugend", birth_date: "2016-03-04", privacy_consent: true, ...over });

describe("child application by a parent (B8)", () => {
  let club: Awaited<ReturnType<typeof createClub>>; // form that names the child
  let plainClub: Awaited<ReturnType<typeof createClub>>; // standard form (no name fields)
  const accounts: Account[] = [];
  const logged: unknown[][] = [];

  const newUser = async (label: string) => {
    const acc = await signUpAndVerify(`child-${label}-${suffix}@example.com`, `Parent ${label}`);
    accounts.push(acc);
    return acc;
  };
  const applyChild = (who: Account, answers: Record<string, unknown> = child(), extra: Record<string, unknown> = {}, target = club) =>
    call(who, "/club-members/apply", { method: "POST", body: { clubSlug: target.slug, onBehalfOf: "guardian", answers, ...extra } });
  const filedChild = async (who: Account, answers = child()) => {
    const res = await applyChild(who, answers);
    expect(res.status, await res.clone().text()).toBe(201);
    const data = (await body(res)).data;
    return { applicationId: data.application.id as string, submissionId: data.submission.id as string, data };
  };
  const decide = (who: Account, id: string, action: "approve" | "reject", payload?: unknown) => call(who, `/club-applications/${id}/${action}`, { method: "POST", clubId: club.clubId, body: payload });
  const accountOf = (userId: string) => db.query.member.findFirst({ where: and(eq(member.organizationId, club.clubId), eq(member.userId, userId)) });

  beforeAll(async () => {
    club = await createClub("kid", suffix, { schriftfuehrer: "schriftfuehrer", plain: null });
    plainClub = await createClub("kidp", suffix);
    for (const level of ["info", "warn", "error", "debug"] as const) {
      vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => {
        logged.push(args);
      }) as never);
    }
    const list = (await body(await call(club.founder, "/forms", { clubId: club.clubId }))).data as Array<{ id: string; purpose: string }>;
    const formId = list.find((f) => f.purpose === "aufnahme")!.id;
    expect((await call(club.founder, `/forms/${formId}/draft`, { method: "PUT", clubId: club.clubId, body: { fields: FIELDS } })).status).toBe(200);
    expect((await call(club.founder, `/forms/${formId}/publish`, { method: "POST", clubId: club.clubId })).status).toBe(200);
  }, 90_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await dropClubs([club.clubId, plainClub.clubId], [...club.userIds, ...plainClub.userIds, ...accounts.map((a) => a.userId)]);
    await closeDatabase();
  });

  // --- availability --------------------------------------------------------------------------------------------

  it("offers the child application only with a form that names the child", async () => {
    const who = await newUser("avail");
    expect((await body(await call(who, `/club-forms/${club.slug}/aufnahme`))).data.childApplication).toBe(true);
    expect((await body(await call(who, `/club-forms/${plainClub.slug}/aufnahme`))).data.childApplication).toBe(false);
    for (const res of [
      await call(who, "/form-submissions", { method: "POST", body: { clubSlug: plainClub.slug, onBehalfOf: "guardian" } }),
      await applyChild(who, { category: "jugend", privacy_consent: true }, {}, plainClub),
    ]) {
      expect(res.status).toBe(409);
      expect((await body(res)).error.details.code).toBe("child_application_unsupported");
    }
    // The legacy request has no way to say "for a child".
    const legacy = await call(who, "/club-members/apply", { method: "POST", body: { clubSlug: club.slug, onBehalfOf: "guardian" } });
    expect(legacy.status).toBe(422);
  });

  it("needs a verified e-mail address", async () => {
    const who = await newUser("unverified");
    await db.update(user).set({ emailVerified: false }).where(eq(user.id, who.userId));
    const res = await applyChild(who);
    expect(res.status).toBe(403);
    expect((await body(res)).error.details.code).toBe("email_not_verified");
    expect((await call(who, "/form-submissions", { method: "POST", body: { clubSlug: club.slug, onBehalfOf: "guardian" } })).status).toBe(403);
    expect(await db.query.formSubmissions.findFirst({ where: eq(formSubmissions.submittedByUserId, who.userId) })).toBeUndefined();
  });

  // --- the child's name and age -------------------------------------------------------------------------------

  it("requires the child's names, refuses a birth date in the future and only advises about the age", async () => {
    const who = await newUser("name");
    const noName = await applyChild(who, child({ last_name: undefined }));
    expect(noName.status).toBe(422);
    expect((await body(noName)).error.details.fields).toMatchObject({ last_name: "required" });
    const future = await applyChild(who, child({ birth_date: "2999-01-01" }));
    expect(future.status).toBe(422);
    expect((await body(future)).error.details.fields).toMatchObject({ birth_date: "invalid_value" });
    expect(await db.query.formSubmissions.findFirst({ where: eq(formSubmissions.submittedByUserId, who.userId) })).toBeUndefined();

    const adult = await filedChild(who, child({ birth_date: "1990-01-01" }));
    expect(adult.data.warnings).toEqual(["child_is_adult"]);
    const unknown = await filedChild(who, child({ birth_date: undefined }));
    expect(unknown.data.warnings).toEqual(["birth_date_missing"]);
    const minor = await filedChild(who);
    expect(minor.data.warnings).toEqual([]);
    expect(minor.data.submission.onBehalfOf).toBe("guardian");
  });

  // --- the lifecycle ------------------------------------------------------------------------------------------

  it("accepts into an account-less member with the guardian link and an external role for a new parent", async () => {
    const parent = await newUser("lifecycle");
    // The parent is not a member: the form is theirs to fill in for the child (draft + photo + submit).
    const draft = await call(parent, "/form-submissions", { method: "POST", body: { clubSlug: club.slug, onBehalfOf: "guardian", answers: child() } });
    expect(draft.status).toBe(201);
    const draftData = (await body(draft)).data;
    const submissionId = draftData.submission.id as string;
    expect(draftData.submission.onBehalfOf).toBe("guardian");
    const fd = new FormData();
    fd.append("file", new File([new Uint8Array(makePng())], "kind.png", { type: "image/png" }));
    fd.append("fieldKey", "photo");
    expect((await call(parent, `/form-submissions/${submissionId}/files`, { method: "POST", form: fd })).status).toBe(201);
    const filed = await call(parent, "/club-members/apply", { method: "POST", body: { clubSlug: club.slug, submissionId } });
    expect(filed.status).toBe(201);
    const applicationId = (await body(filed)).data.application.id as string;
    const application = await db.query.clubApplications.findFirst({ where: eq(clubApplications.id, applicationId) });
    expect(application).toMatchObject({ onBehalfOf: "guardian", userId: parent.userId, status: "pending" });

    // Still nothing about the child or the parent in the club.
    expect(await accountOf(parent.userId)).toBeUndefined();
    expect(await db.query.clubMembers.findFirst({ where: and(eq(clubMembers.clubId, club.clubId), eq(clubMembers.displayName, `${CHILD_FIRST} ${CHILD_LAST}`)) })).toBeUndefined();

    // Not a board member: no decision.
    expect((await decide(club.members.plain!, applicationId, "approve")).status).toBe(403);
    expect((await call(parent, `/club-applications/${applicationId}/approve`, { method: "POST", clubId: club.clubId })).status).toBe(404);

    const approved = await decide(club.founder, applicationId, "approve");
    expect(approved.status, await approved.clone().text()).toBe(200);
    const data = (await body(approved)).data;
    expect(data.member).toBeNull();
    expect(data.guardian).toMatchObject({ userId: parent.userId, createdAsExternal: true, linked: true });
    expect(data.clubMember).toMatchObject({ displayName: `${CHILD_FIRST} ${CHILD_LAST}`, memberId: null, lastUserId: null, birthDate: "2016-03-04", status: "aktiv" });
    expect(data.clubMember.hasPhoto).toBe(true);
    expect(data.clubMember).not.toHaveProperty("photoKey");
    expect(data.clubMember.memberNumber).toMatch(/-\d{4}$/);
    expect(data.mapping.applied).toEqual(expect.arrayContaining(["firstName", "lastName", "birthDate", "photo"]));

    // Parent: external account, club role, not a member of the club in the member list sense.
    const account = (await accountOf(parent.userId))!;
    expect(account.role).toBe("guest");
    expect((await db.select().from(clubRoles).where(eq(clubRoles.memberId, account.id))).map((r) => r.roleType)).toEqual(["erziehungsberechtigt"]);
    const parentRow = (await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, account.id) }))!;
    expect(parentRow.status).toBe("interessent");
    // Link child <- parent.
    const links = await db.select().from(guardianLinks).where(eq(guardianLinks.wardClubMemberId, data.clubMember.id));
    expect(links.map((l) => l.guardianMemberId)).toEqual([account.id]);
    // Submission: accepted, about the child, still submitted by the parent.
    const sub = (await db.query.formSubmissions.findFirst({ where: eq(formSubmissions.id, submissionId) }))!;
    expect(sub).toMatchObject({ status: "accepted", subjectClubMemberId: data.clubMember.id, submittedByUserId: parent.userId, onBehalfOf: "guardian" });

    // Consent evidence: who (the guardian), when, which text -- and no personal data.
    const audit = (await db.select().from(auditLog).where(and(eq(auditLog.eventType, "club_application.approve"), eq(auditLog.subjectId, applicationId))))[0]!;
    const payload = audit.payload as Record<string, unknown> & { consent: Record<string, unknown> };
    expect(payload.consent).toMatchObject({ consentedBy: parent.userId, onBehalfOf: "guardian", consentFieldKeys: ["privacy_consent"], subjectClubMemberId: data.clubMember.id });
    expect(payload.consent.consentedAt).toBe(sub.submittedAt!.toISOString());
    expect(payload.consent.textSha256).toMatch(/^[0-9a-f]{64}$/);
    const linkAudit = await db.select().from(auditLog).where(and(eq(auditLog.eventType, "guardian_link.create"), eq(auditLog.subjectId, data.clubMember.id)));
    expect(linkAudit).toHaveLength(1);
    expect(JSON.stringify(audit.payload) + JSON.stringify(linkAudit[0]!.payload) + JSON.stringify(logged)).not.toContain(CHILD_LAST);

    // The parent may now see the child through the guardian routes of the board API (GET /club-members/:id/guardians is board/guardian only).
    expect(account.userId).toBe(parent.userId);
  });

  it("allows several children of one parent, keeps the parent's own application independent and applies the cap", async () => {
    const parent = await newUser("many");
    const first = await filedChild(parent, child({ first_name: "Eins" }));
    const second = await filedChild(parent, child({ first_name: "Zwei" }));
    expect(first.applicationId).not.toBe(second.applicationId);
    // Applying for oneself is a separate application: the pending child applications do not block it, a second own one does.
    const own = await call(parent, "/club-members/apply", { method: "POST", body: { clubSlug: club.slug, answers: { first_name: "Eltern", last_name: "Teil", category: "aktiv", privacy_consent: true } } });
    expect(own.status).toBe(201);
    const ownAgain = await call(parent, "/club-members/apply", { method: "POST", body: { clubSlug: club.slug, answers: { first_name: "Eltern", last_name: "Teil", category: "aktiv", privacy_consent: true } } });
    expect(ownAgain.status).toBe(409);
    expect((await body(ownAgain)).error.code).toBe("APPLICATION_PENDING");

    // Cap: five open child applications per account.
    await filedChild(parent, child({ first_name: "Drei" }));
    await filedChild(parent, child({ first_name: "Vier" }));
    await filedChild(parent, child({ first_name: "Fuenf" }));
    expect(await countOpenChildApplications(parent.userId)).toBe(MAX_OPEN_CHILD_APPLICATIONS);
    const sixth = await applyChild(parent, child({ first_name: "Sechs" }));
    expect(sixth.status).toBe(409);
    expect((await body(sixth)).error.details).toMatchObject({ code: "child_application_limit", limit: 5 });
    const draftToo = await call(parent, "/form-submissions", { method: "POST", body: { clubSlug: club.slug, onBehalfOf: "guardian" } });
    expect(draftToo.status).toBe(409);
    expect((await body(draftToo)).error.details.code).toBe("child_application_limit");

    // Withdrawing one frees a slot (and closes its application row).
    expect((await call(parent, `/form-submissions/${first.submissionId}/withdraw`, { method: "POST" })).status).toBe(200);
    expect((await db.query.clubApplications.findFirst({ where: eq(clubApplications.id, first.applicationId) }))!.status).toBe("withdrawn");
    expect((await applyChild(parent, child({ first_name: "Sechs" }))).status).toBe(201);

    // Two children of the same NEW parent accepted at once: one external account, two links, both applications approved.
    const pending = await db.query.clubApplications.findMany({ where: and(eq(clubApplications.userId, parent.userId), eq(clubApplications.onBehalfOf, "guardian"), eq(clubApplications.status, "pending")) });
    const otherId = pending.find((p) => p.id !== second.applicationId)!.id;
    const [a, b] = await Promise.all([decide(club.founder, second.applicationId, "approve"), decide(club.founder, otherId, "approve")]);
    expect([a.status, b.status], `${await a.clone().text()} ${await b.clone().text()}`).toEqual([200, 200]);
    const accounts1 = await db.select().from(member).where(and(eq(member.organizationId, club.clubId), eq(member.userId, parent.userId)));
    expect(accounts1).toHaveLength(1);
    expect(accounts1[0]!.role).toBe("guest");
    expect(await db.select().from(guardianLinks).where(eq(guardianLinks.guardianMemberId, accounts1[0]!.id))).toHaveLength(2);
    expect(await db.select().from(clubRoles).where(eq(clubRoles.memberId, accounts1[0]!.id))).toHaveLength(1);

    // The same parent is now an external guest: a child application is fine and so is an application for oneself (see the promotion test).
    const third = await applyChild(parent, child({ first_name: "Sieben" }));
    expect(third.status).toBe(201);
    const self = await call(parent, "/club-members/apply", { method: "POST", body: { clubSlug: club.slug, answers: { first_name: "x", last_name: "y", category: "aktiv", privacy_consent: true } } });
    // The parent's own application from above is still pending (a guest may apply for themself, one open application at a time).
    expect(self.status).toBe(409);
    expect((await body(self)).error.code).toBe("APPLICATION_PENDING");
    const accepted = await decide(club.founder, (await body(third)).data.application.id, "approve");
    expect(accepted.status).toBe(200);
    expect((await body(accepted)).data.guardian).toMatchObject({ createdAsExternal: false });
    expect(await db.select().from(guardianLinks).where(eq(guardianLinks.guardianMemberId, accounts1[0]!.id))).toHaveLength(3);
  }, 60_000);

  it("keeps a parent who already is a full member untouched and links the child", async () => {
    const parent = club.members.plain!;
    const before = (await accountOf(parent.userId))!;
    const parentRowBefore = (await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, before.id) }))!;
    const { applicationId } = await filedChild(parent, child({ first_name: "Vereinskind" }));
    const approved = await decide(club.founder, applicationId, "approve", { categoryKey: "foerdernd" });
    expect(approved.status, await approved.clone().text()).toBe(200);
    const data = (await body(approved)).data;
    expect(data.guardian).toMatchObject({ createdAsExternal: false, memberId: before.id });
    const after = (await accountOf(parent.userId))!;
    expect(after.role).toBe(before.role);
    expect(await db.select().from(clubRoles).where(eq(clubRoles.memberId, before.id))).toHaveLength(0);
    const parentRowAfter = (await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, before.id) }))!;
    expect(parentRowAfter.status).toBe(parentRowBefore.status);
    // The board's category override applies to the child.
    const cat = await db.query.memberCategories.findFirst({ where: (t, { eq: same }) => same(t.id, data.clubMember.categoryId) });
    expect(cat!.key).toBe("foerdernd");
    expect(await db.select().from(guardianLinks).where(and(eq(guardianLinks.guardianMemberId, before.id), eq(guardianLinks.wardClubMemberId, data.clubMember.id)))).toHaveLength(1);
  });

  it("does not let a former, excluded or deceased member sponsor a child", async () => {
    const parent = await newUser("former");
    const account = (await (async () => {
      const { auth } = await import("../auth/auth.js");
      return auth.api.addMember({ body: { userId: parent.userId, organizationId: club.clubId, role: "member" } });
    })())!;
    const row = (await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, account.id) }))!;
    await db.update(clubMembers).set({ status: "ausgetreten", leftAt: "2020-01-01" }).where(eq(clubMembers.id, row.id));
    const left = await applyChild(parent);
    expect(left.status).toBe(409);
    expect((await body(left)).error.details.code).toBe("guardian_not_active");
    await db.update(clubMembers).set({ status: "ausgeschlossen" }).where(eq(clubMembers.id, row.id));
    const excluded = await applyChild(parent);
    expect(excluded.status).toBe(409);
    expect((await body(excluded)).error.details.code).toBe("member_rejoin_blocked");
  });

  // --- no self-assignment ----------------------------------------------------------------------------------------

  it("never links a ward the parent names: ids in the body are ignored, links come only with an accepted application", async () => {
    const parent = await newUser("selfassign");
    const victim = (await db.select().from(clubMembers).where(eq(clubMembers.clubId, club.clubId)).limit(1))[0]!;
    const linksBefore = (await db.select().from(guardianLinks).where(eq(guardianLinks.wardClubMemberId, victim.id))).length;
    const res = await call(parent, "/form-submissions", {
      method: "POST",
      body: { clubSlug: club.slug, onBehalfOf: "guardian", subjectClubMemberId: victim.id, wardClubMemberId: victim.id, guardianMemberId: "x", answers: child() },
    });
    expect(res.status).toBe(201);
    const id = (await body(res)).data.submission.id as string;
    expect((await db.query.formSubmissions.findFirst({ where: eq(formSubmissions.id, id) }))!.subjectClubMemberId).toBeNull();
    // PATCH cannot name one either, and an unknown key is a validation error.
    const patched = await call(parent, `/form-submissions/${id}`, { method: "PATCH", body: { answers: { subject_club_member_id: victim.id } } });
    expect(patched.status).toBe(422);
    const filed = await call(parent, "/club-members/apply", { method: "POST", body: { clubSlug: club.slug, submissionId: id } });
    expect(filed.status).toBe(201);
    // Pending, rejected or withdrawn: no link, no external account.
    const applicationId = (await body(filed)).data.application.id as string;
    expect(await accountOf(parent.userId)).toBeUndefined();
    const rejected = await decide(club.founder, applicationId, "reject", { applicantMessage: "Nein" });
    expect(rejected.status).toBe(200);
    expect(await accountOf(parent.userId)).toBeUndefined();
    expect(await db.select().from(guardianLinks).where(eq(guardianLinks.wardClubMemberId, victim.id))).toHaveLength(linksBefore);
  });

  it("refuses to accept when the child cannot be named (nothing is created) and decides only once", async () => {
    const parent = await newUser("noname");
    const { applicationId, submissionId } = await filedChild(parent);
    await db.update(formSubmissions).set({ answers: { category: "jugend", privacy_consent: true } }).where(eq(formSubmissions.id, submissionId));
    const res = await decide(club.founder, applicationId, "approve");
    expect(res.status).toBe(409);
    expect((await body(res)).error.details.code).toBe("child_name_missing");
    expect(await accountOf(parent.userId)).toBeUndefined();
    expect((await db.query.clubApplications.findFirst({ where: eq(clubApplications.id, applicationId) }))!.status).toBe("pending");

    const other = await newUser("race");
    const filed = await filedChild(other);
    const [x, y] = await Promise.all([decide(club.founder, filed.applicationId, "approve"), decide(club.members.schriftfuehrer!, filed.applicationId, "approve")]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    const sub = (await db.query.formSubmissions.findFirst({ where: eq(formSubmissions.id, filed.submissionId) }))!;
    expect(await db.select().from(guardianLinks).where(eq(guardianLinks.wardClubMemberId, sub.subjectClubMemberId!))).toHaveLength(1);
    expect(await db.select().from(member).where(and(eq(member.organizationId, club.clubId), eq(member.userId, other.userId)))).toHaveLength(1);
  });

  it("never shows a new guest parent as an active member and gives them no member number", async () => {
    const parent = await newUser("neveraktiv");
    const { applicationId } = await filedChild(parent);
    expect((await decide(club.founder, applicationId, "approve")).status).toBe(200);
    const account = (await accountOf(parent.userId))!;
    const row = (await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, account.id) }))!;
    expect(row).toMatchObject({ status: "interessent", memberNumber: null });
    const history = await db.select().from(clubMemberStatusHistory).where(eq(clubMemberStatusHistory.clubMemberId, row.id));
    expect(history.map((h) => h.toStatus)).toEqual(["interessent"]);
  });

  it("promotes a guest parent to a regular member when their own application is accepted (child first, parent afterwards)", async () => {
    const parent = await newUser("promote");
    const kid = await filedChild(parent);
    expect((await decide(club.founder, kid.applicationId, "approve")).status).toBe(200);
    const guest = (await accountOf(parent.userId))!;
    expect(guest.role).toBe("guest");
    // A guest is not a member: no ALREADY_MEMBER, the own application can be filed ...
    const own = await call(parent, "/club-members/apply", { method: "POST", body: { clubSlug: club.slug, answers: { first_name: "Eltern", last_name: "Teil", category: "aktiv", privacy_consent: true } } });
    expect(own.status, await own.clone().text()).toBe(201);
    const ownId = (await body(own)).data.application.id as string;
    // ... but still only one open one.
    expect((await call(parent, "/club-members/apply", { method: "POST", body: { clubSlug: club.slug, answers: { first_name: "x", last_name: "y", category: "aktiv", privacy_consent: true } } })).status).toBe(409);
    const approved = await decide(club.founder, ownId, "approve");
    expect(approved.status, await approved.clone().text()).toBe(200);
    const data = (await body(approved)).data;
    expect(data.member).toMatchObject({ id: guest.id, role: "member" });
    expect((await accountOf(parent.userId))!.role).toBe("member");
    const row = (await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, guest.id) }))!;
    expect(row).toMatchObject({ status: "aktiv", displayName: "Eltern Teil" });
    expect(row.memberNumber).toMatch(/-\d{4}$/);
    const history = await db.select().from(clubMemberStatusHistory).where(eq(clubMemberStatusHistory.clubMemberId, row.id));
    expect(history.map((h) => `${h.fromStatus}>${h.toStatus}`)).toEqual(["null>interessent", "interessent>aktiv"]);
    // The guardian role and the link stay; the person now has the implicit member role.
    expect((await db.select().from(clubRoles).where(eq(clubRoles.memberId, guest.id))).map((r) => r.roleType)).toEqual(["erziehungsberechtigt"]);
    expect(await db.select().from(guardianLinks).where(eq(guardianLinks.guardianMemberId, guest.id))).toHaveLength(1);
    const me = await call(parent, "/club-members/me", { clubId: club.clubId });
    expect(me.status).toBe(200);
    // Applying again is now ALREADY_MEMBER.
    const again = await call(parent, "/club-members/apply", { method: "POST", body: { clubSlug: club.slug, answers: { first_name: "x", last_name: "y", category: "aktiv", privacy_consent: true } } });
    expect((await body(again)).error.code).toBe("ALREADY_MEMBER");
  });

  it("never removes a guest account that is somebody's guardian when an acceptance is compensated", async () => {
    const parent = await newUser("compensate");
    const { applicationId } = await filedChild(parent);
    expect((await decide(club.founder, applicationId, "approve")).status).toBe(200);
    const account = (await accountOf(parent.userId))!;
    const created = { id: account.id, organizationId: club.clubId, userId: parent.userId };
    // With a guardian link ...
    expect(await compensateAbortedApproval(created)).toBe(false);
    expect(await accountOf(parent.userId)).toBeDefined();
    // ... and with only the guardian role left (it stems from some other application).
    await db.delete(guardianLinks).where(eq(guardianLinks.guardianMemberId, account.id));
    expect(await compensateAbortedApproval(created)).toBe(false);
    expect(await accountOf(parent.userId)).toBeDefined();
    // A bare guest without link and role is removable (the aborted acceptance's own creation).
    await db.delete(clubRoles).where(eq(clubRoles.memberId, account.id));
    expect(await compensateAbortedApproval(created)).toBe(true);
    expect(await accountOf(parent.userId)).toBeUndefined();
  });

  it("keeps the child out of the logs, the audit entries and error answers", async () => {
    const dump = JSON.stringify(logged) + JSON.stringify(await db.select().from(auditLog).where(eq(auditLog.eventType, "form_submission.submit")));
    expect(dump).not.toContain(CHILD_LAST);
    expect(dump).not.toContain(CHILD_FIRST);
    const who = await newUser("errors");
    const text = await (await applyChild(who, child({ category: `x${CHILD_LAST}` }))).text();
    expect(text).not.toContain(CHILD_LAST);
  });
});
