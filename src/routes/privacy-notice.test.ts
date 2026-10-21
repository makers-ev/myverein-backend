import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDatabase, db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { clubApplications } from "../db/schema/club-applications.js";
import { clubPrivacyNotices } from "../db/schema/club-privacy-notices.js";
import { clubMembers } from "../db/schema/club-members.js";
import { clubSettings } from "../db/schema/club-settings.js";
import { clubApplicationRoutes } from "./club-applications.js";
import { clubFormRoutes } from "./club-forms.js";
import { clubMemberRoutes } from "./club-members.js";
import { clubNoticeBySlugRoutes, clubPrivacyNoticeRoutes } from "./club-privacy-notices.js";
import { formSubmissionRoutes } from "./form-submissions.js";
import { createClub, dropClubs, installErrorHandler, requester, signUpAndVerify, type Account } from "./forms-test-support.js";

/**
 * Wave 10 B11: club privacy notice (versions, template, board rights), the applicant's acknowledgement, the Art. 14 stamp for members
 * without account. A notice is information: nothing depends on taking note of it (Koppelungsverbot).
 */

const app = new Hono();
app.route("/club-privacy-notices", clubPrivacyNoticeRoutes);
app.route("/clubs", clubNoticeBySlugRoutes);
app.route("/club-members", clubMemberRoutes);
app.route("/club-applications", clubApplicationRoutes);
app.route("/form-submissions", formSubmissionRoutes);
app.route("/club-forms", clubFormRoutes);
installErrorHandler(app);
const call = requester(app);
const suffix = Date.now();
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response) => (await res.json()) as Json;

const NOTICE = `Datenschutzhinweis des Vereins. ${"Wir verarbeiten Daten für die Mitgliederverwaltung. ".repeat(4)}`;

describe("club privacy notice (B11)", () => {
  let a: Awaited<ReturnType<typeof createClub>>;
  let b: Awaited<ReturnType<typeof createClub>>; // never publishes
  let board: Account;
  let plain: Account;
  const applicants: Account[] = [];

  const newApplicant = async (label: string) => {
    const acc = await signUpAndVerify(`pn-${label}-${suffix}@example.com`, `Applicant ${label}`);
    applicants.push(acc);
    return acc;
  };
  const publish = (who: Account, text?: string) => call(who, "/club-privacy-notices", { method: "POST", clubId: a.clubId, body: text === undefined ? {} : { body: text } });

  beforeAll(async () => {
    a = await createClub("pna", suffix, { plain: null });
    b = await createClub("pnb", suffix);
    board = a.founder;
    plain = a.members.plain!;
  }, 90_000);

  afterAll(async () => {
    await dropClubs([a.clubId, b.clubId], [...a.userIds, ...b.userIds, ...applicants.map((x) => x.userId)]);
    await closeDatabase();
  });

  describe("versions", () => {
    it("has no notice at first: members and applicants get null, the board gets a generated draft with the club's data", async () => {
      expect((await body(await call(plain, "/club-privacy-notices/current", { clubId: a.clubId }))).data).toBeNull();
      const applicant = await newApplicant("early");
      expect((await body(await call(applicant, `/clubs/${a.slug}/privacy-notice`))).data).toBeNull();

      await db.insert(clubSettings).values({ clubId: a.clubId, privacyContact: "datenschutz@verein.example", privacyController: "Verein e. V., Musterweg 1, 12345 Stadt" }).onConflictDoUpdate({ target: clubSettings.clubId, set: { privacyContact: "datenschutz@verein.example", privacyController: "Verein e. V., Musterweg 1, 12345 Stadt" } });
      const draft = (await body(await call(board, "/club-privacy-notices/draft", { clubId: a.clubId }))).data;
      expect(draft.current).toBeNull();
      expect(draft.body).toContain("MUSTER, KEINE RECHTSBERATUNG");
      expect(draft.body).toContain("datenschutz@verein.example");
      expect(draft.body).toContain("Musterweg 1");
      // The active retention periods are part of it, in the club's override when there is one.
      expect(draft.body).toContain("Krankmeldungen und Abwesenheiten: nach 3 Monaten");
      expect(draft.body).toContain("freiwillig");
      expect(draft.body).not.toContain("willige ich ein");
    });

    it("publishes immutable versions: first v1, the same text is a no-op, a change is v2; invalid text 422", async () => {
      expect((await publish(board, "zu kurz")).status).toBe(422);
      const first = await publish(board, NOTICE);
      expect(first.status).toBe(201);
      const v1 = (await body(first)).data;
      expect(v1).toMatchObject({ version: 1, body: NOTICE.trim() });
      expect(v1.sha256).toMatch(/^[0-9a-f]{64}$/);

      const again = await publish(board, NOTICE);
      expect(again.status).toBe(200);
      expect((await body(again)).data.id).toBe(v1.id);

      const v2 = (await body(await publish(board, `${NOTICE} Ergänzung.`))).data;
      expect(v2.version).toBe(2);
      const generated = await publish(board); // no text: the generated draft
      expect(generated.status).toBe(201);
      expect((await body(generated)).data.version).toBe(3);

      const list = (await body(await call(board, "/club-privacy-notices", { clubId: a.clubId }))).data;
      expect(list.map((n: Json) => n.version)).toEqual([3, 2, 1]);
      expect(list[0].body).toBeUndefined();
      expect((await body(await call(board, `/club-privacy-notices/${v1.id}`, { clubId: a.clubId }))).data.body).toBe(NOTICE.trim());
      // Rows are never edited: there is no update route.
      expect((await call(board, `/club-privacy-notices/${v1.id}`, { method: "PATCH", clubId: a.clubId, body: { body: "x" } })).status).toBe(404);
      const audits = await db.select().from(auditLog).where(and(eq(auditLog.clubId, a.clubId), eq(auditLog.eventType, "privacy_notice.publish")));
      expect(audits).toHaveLength(3);
    });

    it("lets every member and the applicant read the current text; only the board manages", async () => {
      const current = (await body(await call(plain, "/club-privacy-notices/current", { clubId: a.clubId }))).data;
      expect(current.version).toBe(3);
      const applicant = await newApplicant("reader");
      const bySlug = (await body(await call(applicant, `/clubs/${a.slug}/privacy-notice`))).data;
      expect(bySlug).toMatchObject({ version: 3, clubName: expect.any(String) });
      expect((await call(applicant, "/clubs/no-such-club/privacy-notice")).status).toBe(404);
      expect((await app.request(`/clubs/${a.slug}/privacy-notice`)).status).toBe(401);

      for (const [method, path, json] of [["GET", "", undefined], ["GET", "/draft", undefined], ["POST", "", { body: NOTICE }]] as const) {
        expect((await call(plain, `/club-privacy-notices${path}`, { method, clubId: a.clubId, ...(json ? { body: json } : {}) })).status).toBe(403);
      }
    });

    it("keeps clubs apart: a foreign club's notice id is 404, the other club has none", async () => {
      const mine = (await body(await call(board, "/club-privacy-notices", { clubId: a.clubId }))).data[0];
      expect((await call(b.founder, `/club-privacy-notices/${mine.id}`, { clubId: b.clubId })).status).toBe(404);
      expect((await call(b.founder, "/club-privacy-notices/not-a-uuid", { clubId: b.clubId })).status).toBe(404);
      expect((await body(await call(b.founder, "/club-privacy-notices/current", { clubId: b.clubId }))).data).toBeNull();
      expect((await call(board, "/club-privacy-notices/current", { clubId: b.clubId })).status).toBe(404); // not a member of b
    });
  });

  describe("applicant acknowledgement (information, never a condition)", () => {
    const apply = (who: Account, clubSlug: string, extra: Record<string, unknown> = {}) => call(who, "/club-members/apply", { method: "POST", body: { clubSlug, answers: { category: "aktiv" }, ...extra } });

    it("stamps version and time when the applicant took note, and shows it to the board", async () => {
      const who = await newApplicant("ack");
      const res = await apply(who, a.slug, { privacyNoticeAcknowledged: true });
      expect(res.status).toBe(201);
      const id = (await body(res)).data.application.id;
      const [row] = await db.select().from(clubApplications).where(eq(clubApplications.id, id));
      const [v3] = await db.select().from(clubPrivacyNotices).where(and(eq(clubPrivacyNotices.clubId, a.clubId), eq(clubPrivacyNotices.version, 3)));
      expect(row).toMatchObject({ privacyNoticeVersionId: v3!.id });
      expect(row!.privacyNoticeAcknowledgedAt).toBeInstanceOf(Date);
      const review = (await body(await call(board, `/club-applications/${id}`, { clubId: a.clubId }))).data;
      expect(review.application.privacyNoticeVersionId).toBe(v3!.id);
      expect(review.application.privacyNoticeAcknowledgedAt).toBeTruthy();
    });

    it("files the application all the same without taking note, and when the club has no notice", async () => {
      const who = await newApplicant("noack");
      const res = await apply(who, a.slug);
      expect(res.status).toBe(201);
      const [row] = await db.select().from(clubApplications).where(eq(clubApplications.id, (await body(res)).data.application.id));
      expect(row).toMatchObject({ privacyNoticeVersionId: null, privacyNoticeAcknowledgedAt: null });
      // The club without notice: acknowledging stamps nothing, the application is filed.
      const other = await newApplicant("nonotice");
      const filed = await apply(other, b.slug, { privacyNoticeAcknowledged: true });
      expect(filed.status).toBe(201);
      const [stamped] = await db.select().from(clubApplications).where(eq(clubApplications.id, (await body(filed)).data.application.id));
      expect(stamped).toMatchObject({ privacyNoticeVersionId: null, privacyNoticeAcknowledgedAt: null });
    });

    it("stamps on the draft-and-submit path and on the legacy path, too", async () => {
      const who = await newApplicant("draft");
      const draft = await call(who, "/form-submissions", { method: "POST", body: { clubSlug: a.slug, answers: { category: "aktiv" } } });
      expect(draft.status).toBe(201);
      const submitted = await call(who, `/form-submissions/${(await body(draft)).data.submission.id}/submit`, { method: "POST", body: { privacyNoticeAcknowledged: true } });
      expect(submitted.status).toBe(200);
      const [row] = await db.select().from(clubApplications).where(eq(clubApplications.id, (await body(submitted)).data.application.id));
      expect(row!.privacyNoticeAcknowledgedAt).toBeInstanceOf(Date);

      const legacy = await newApplicant("legacy");
      const res = await call(legacy, "/club-members/apply", { method: "POST", body: { clubSlug: a.slug, category: "jugend", privacyNoticeAcknowledged: true } });
      expect(res.status).toBe(201);
      const [legacyRow] = await db.select().from(clubApplications).where(eq(clubApplications.id, (await body(res)).data.application.id));
      expect(legacyRow!.privacyNoticeAcknowledgedAt).toBeInstanceOf(Date);
    });

    it("does not need a consent on the standard application form", async () => {
      const who = await newApplicant("form");
      const form = (await body(await call(who, `/club-forms/${a.slug}/aufnahme`))).data;
      expect(form.fields.some((f: Json) => f.type === "consent")).toBe(false);
      expect(form.privacyNotice).toBeTruthy();
    });
  });

  describe("Art. 14 for members without an account", () => {
    let childId: string;

    beforeAll(async () => {
      childId = (await body(await call(board, "/club-members", { method: "POST", clubId: a.clubId, body: { displayName: "Kind Ohne Konto", categoryKey: "jugend", birthDate: "2016-05-05" } }))).data.id;
    });

    it("notes that the notice was handed over, with the version, and shows when it is out of date", async () => {
      expect((await body(await call(board, `/club-members/${childId}/privacy-notice`, { clubId: a.clubId }))).data).toMatchObject({ sentAt: null, sentVersion: null, currentVersion: 3, upToDate: false });
      const sent = await call(board, `/club-members/${childId}/privacy-notice-sent`, { method: "POST", clubId: a.clubId });
      expect(sent.status).toBe(200);
      expect((await body(sent)).data).toMatchObject({ sentVersion: 3, currentVersion: 3, upToDate: true });
      const [row] = await db.select().from(clubMembers).where(eq(clubMembers.id, childId));
      expect(row!.privacyNoticeSentAt).toBeInstanceOf(Date);
      const stamp = row!.privacyNoticeSentAt!.getTime();
      // A repeat for the same version keeps the first date.
      await call(board, `/club-members/${childId}/privacy-notice-sent`, { method: "POST", clubId: a.clubId });
      expect((await db.select().from(clubMembers).where(eq(clubMembers.id, childId)))[0]!.privacyNoticeSentAt!.getTime()).toBe(stamp);
      const audits = await db.select().from(auditLog).where(and(eq(auditLog.eventType, "club_member.privacy_notice_sent"), eq(auditLog.subjectMemberId, childId)));
      expect(audits).toHaveLength(1);

      await publish(board, `${NOTICE} Neu.`);
      expect((await body(await call(board, `/club-members/${childId}/privacy-notice`, { clubId: a.clubId }))).data).toMatchObject({ sentVersion: 3, currentVersion: 4, upToDate: false });
    });

    it("is refused without a published notice, for members, and across clubs", async () => {
      const other = (await body(await call(b.founder, "/club-members", { method: "POST", clubId: b.clubId, body: { displayName: "Kind B", categoryKey: "jugend", birthDate: "2016-05-05" } }))).data.id;
      const none = await call(b.founder, `/club-members/${other}/privacy-notice-sent`, { method: "POST", clubId: b.clubId });
      expect(none.status).toBe(409);
      expect((await body(none)).error.details.code).toBe("no_published_notice");
      expect((await call(plain, `/club-members/${childId}/privacy-notice-sent`, { method: "POST", clubId: a.clubId })).status).toBe(403);
      expect((await call(plain, `/club-members/${childId}/privacy-notice`, { clubId: a.clubId })).status).toBe(403);
      expect((await call(b.founder, `/club-members/${childId}/privacy-notice-sent`, { method: "POST", clubId: b.clubId })).status).toBe(404);
    });
  });
});
