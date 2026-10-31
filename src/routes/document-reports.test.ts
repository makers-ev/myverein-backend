import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDatabase, db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { meetingInvitations, meetingMinutes } from "../db/schema/assembly.js";
import { clubMembers } from "../db/schema/club-members.js";
import { documentFolders, documents, renderJobs } from "../db/schema/documents.js";
import { meetings } from "../db/schema/meetings.js";
import { getTemplate } from "../lib/pdf/registry.js";
import { membersAsOf } from "../lib/pdf/templates/reports.js";
import { registerBuiltinTemplates } from "../lib/pdf/templates/index.js";
import { requestRender } from "../lib/pdf/render.js";
import { documentGenerationRoutes } from "./document-generation.js";
import { documentRoutes } from "./documents.js";
import { createClub, dropClubs, installErrorHandler, requester, type Account } from "./forms-test-support.js";

/** Wave 13 B10: member list, annual report, assembly documents. (Attendance and participant lists: document-event-lists.test.ts.) */
const app = new Hono();
app.route("/document-generation", documentGenerationRoutes);
app.route("/documents", documentRoutes);
installErrorHandler(app);
const call = requester(app);
const suffix = Date.now();

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed response helper
const body = async (res: Response) => (await res.json()) as any;

describe("report templates", () => {
  let club: Awaited<ReturnType<typeof createClub>>;
  let other: Awaited<ReturnType<typeof createClub>>;
  const id = () => club.clubId;
  const generate = (who: Account, templateId: string, params: unknown, clubId = id()) => call(who, "/document-generation", { method: "POST", clubId, body: { templateId, params } });

  beforeAll(async () => {
    registerBuiltinTemplates();
    club = await createClub("rep", suffix, { kassen: "kassenwart", schrift: "schriftfuehrer", trainer: "trainer", plain: null });
    other = await createClub("repo", suffix);
    const base = { clubId: id(), status: "aktiv", joinedAt: "2020-03-01" };
    await db.insert(clubMembers).values(Array.from({ length: 400 }, (_, i) => ({ ...base, displayName: `Mitglied ${String(i).padStart(3, "0")} Müller`, firstName: "M", lastName: `Müller${i}`, memberNumber: `R-${i}`, street: "Hauptstraße 1", postalCode: "10115", city: "Berlin", birthDate: "1990-05-05" })));
    await db.insert(clubMembers).values({ ...base, displayName: "Frühere Person", status: "ausgetreten", joinedAt: "2015-01-01", leftAt: "2022-06-30", memberNumber: "R-OLD" });
  }, 90_000);

  afterAll(async () => {
    await dropClubs([club.clubId, other.clubId], [...club.userIds, ...other.userIds]);
    await closeDatabase();
  });

  describe("member list", () => {
    it("needs members:read_sensitive: the board with it generates, others are refused", async () => {
      expect((await generate(club.members.schrift!, "mitgliederliste", {})).status).toBe(403);
      expect((await generate(club.members.trainer!, "mitgliederliste", {})).status).toBe(403);
      expect((await generate(club.members.plain!, "mitgliederliste", {})).status).toBe(403);
      expect((await generate(other.founder, "mitgliederliste", {}, id())).status).toBe(404);
    });

    it("files a 400 row list in the system folder, audits it, and the kassenwart can open what they generated", async () => {
      const res = await generate(club.members.kassen!, "mitgliederliste", { columns: ["memberNumber", "name", "birthDate", "address", "departments"] });
      expect(res.status).toBe(201);
      const job = (await body(res)).data;
      expect(job.status).toBe("fertig");
      const [doc] = await db.select().from(documents).where(eq(documents.id, job.documentId));
      const [folder] = await db.select().from(documentFolders).where(eq(documentFolders.id, doc!.folderId!));
      expect(folder).toMatchObject({ systemKey: "mitgliederlisten", clubId: id() });
      expect(doc).toMatchObject({ kind: "erzeugt", docType: "mitgliederliste", scope: "verein" });
      const audits = await db.select().from(auditLog).where(and(eq(auditLog.eventType, "member_list.generate"), eq(auditLog.subjectId, id())));
      expect(audits.length).toBeGreaterThan(0);

      // The folder is a board folder; the requester still reads their own result, a plain member does not even see that it exists.
      const dl = await call(club.members.kassen!, `/documents/${doc!.id}/download`, { clubId: id() });
      expect(dl.status).toBe(200);
      expect(Buffer.from(await dl.arrayBuffer()).toString("latin1", 0, 5)).toBe("%PDF-");
      expect((await call(club.members.plain!, `/documents/${doc!.id}/download`, { clubId: id() })).status).toBe(404);
      expect((await call(club.members.plain!, `/documents/${doc!.id}`, { clubId: id() })).status).toBe(404);
      const mine = await body(await call(club.members.kassen!, "/documents?mine=1", { clubId: id() }));
      expect(mine.data.map((d: { id: string }) => d.id)).toContain(doc!.id);
      expect((await body(await call(club.members.plain!, "/documents?mine=1", { clubId: id() }))).data).toEqual([]);
      // Read only: the requester cannot delete or move it.
      expect((await call(club.members.kassen!, `/documents/${doc!.id}`, { method: "DELETE", clubId: id() })).status).toBe(403);
    });

    it("lists the members at the reference date and only the chosen columns", async () => {
      const t = getTemplate("mitgliederliste")!;
      const current = await t.build(id(), { columns: ["memberNumber", "name"], includeLeft: false });
      const rows = (current.data as { rows: string[][]; total: number }).rows;
      // 400 imported members plus the five accounts of the fixture.
      expect(rows).toHaveLength(405);
      expect(rows[0]).toHaveLength(2);
      expect(JSON.stringify(rows)).not.toContain("Hauptstraße");
      expect(JSON.stringify(rows)).not.toContain("Frühere");
      const earlier = await t.build(id(), { columns: ["name", "status"], asOf: "2021-01-01", includeLeft: false });
      expect((earlier.data as { rows: string[][] }).rows.map((r) => r[0])).toContain("Frühere Person");
      // Members who joined later are not on an earlier list.
      expect((earlier.data as { rows: string[][] }).rows).toHaveLength(401);
      const early = await t.build(id(), { columns: ["name"], asOf: "2019-01-01", includeLeft: false });
      expect((early.data as { rows: string[][] }).rows.map((r) => r[0])).toEqual(["Frühere Person"]);
      expect((await generate(club.founder, "mitgliederliste", { columns: ["nope"] })).status).toBe(422);
      expect((await generate(club.founder, "mitgliederliste", { columns: ["name"], asOf: "2999-01-01" })).status).toBe(409);
    });
  });

  describe("annual report", () => {
    it("needs club_stats:read; trainers are refused", async () => {
      expect((await generate(club.members.trainer!, "jahresbericht", {})).status).toBe(403);
      expect((await generate(club.members.plain!, "jahresbericht", {})).status).toBe(403);
      const ok = await generate(club.members.kassen!, "jahresbericht", {});
      expect(ok.status).toBe(201);
      expect((await generate(club.founder, "jahresbericht", { year: 2100 })).status).toBe(409);
    });

    it("reconstructs the stock of a past year from join and exit dates and holds numbers only", async () => {
      const t = getTemplate("jahresbericht")!;
      const built = await t.build(id(), { year: 2021 });
      const data = built.data as { stats: { members: { total: number } }; asOf: string; partialYear: boolean };
      expect(data.asOf).toBe("2021-12-31");
      expect(data.partialYear).toBe(false);
      // 400 members joined 2020-03-01, the former member (2015-2022) still counts at the end of 2021.
      expect(data.stats.members.total).toBe(401);
      expect(JSON.stringify(built.data)).not.toContain("Müller");
      expect(membersAsOf([{ id: "a", memberId: null, status: "ausgetreten", joinedAt: "2020-01-01", leftAt: "2023-01-01", birthDate: null, categoryId: null }, { id: "b", memberId: null, status: "aktiv", joinedAt: "2025-01-01", leftAt: null, birthDate: null, categoryId: null }], "2021-12-31")).toEqual([
        { id: "a", memberId: null, status: "aktiv", joinedAt: "2020-01-01", leftAt: null, birthDate: null, categoryId: null },
      ]);
    });
  });

  describe("assembly documents", () => {
    let meetingId: string;
    let draftMeetingId: string;

    beforeAll(async () => {
      const [m] = await db.insert(meetings).values({ clubId: id(), type: "mitgliederversammlung", title: "MV 2025", scheduledAt: new Date("2025-05-10T17:00:00Z"), status: "abgehalten" }).returning();
      meetingId = m!.id;
      const [later] = await db.insert(meetings).values({ clubId: id(), type: "mitgliederversammlung", title: "MV 2026", scheduledAt: new Date("2026-05-10T17:00:00Z"), status: "abgehalten" }).returning();
      await db.insert(meetingMinutes).values({ meetingId, version: 1, status: "archiviert", content: "Beginn 18 Uhr.\nTOP 1: Begrüßung <script>alert(1)</script> \\input{/etc/passwd}", contentHash: "a".repeat(64), approvedInMeetingId: later!.id, approvedAt: new Date() });
      await db.insert(meetingInvitations).values({
        meetingId,
        version: 1,
        kind: "einladung",
        sentBy: club.founder.userId,
        content: { kind: "einladung", title: "MV 2025", scheduledAt: "2025-05-10T17:00:00.000Z", place: "Vereinsheim", participationMode: "praesenz", agenda: [{ position: 1, title: "Begrüßung", description: null, voteKind: "none", topic: "t" }], agendaText: null, message: "Bitte pünktlich" },
        contentHash: "b".repeat(64),
        rulesSnapshot: {},
        periodCheck: { ok: true, requiredDays: 14, daysAvailable: 20 },
        recipientCount: 12,
      });
      const [d] = await db.insert(meetings).values({ clubId: id(), type: "mitgliederversammlung", title: "MV Entwurf", scheduledAt: new Date("2025-06-10T17:00:00Z"), status: "abgehalten" }).returning();
      draftMeetingId = d!.id;
      await db.insert(meetingMinutes).values({ meetingId: draftMeetingId, version: 1, status: "entwurf", content: "Nur ein Entwurf", contentHash: "c".repeat(64) });
    });

    it("files the approved minutes and the invitation proof; drafts and foreign meetings are refused", async () => {
      expect((await generate(club.members.plain!, "versammlung-protokoll", { meetingId })).status).toBe(403);
      expect((await generate(club.members.kassen!, "versammlung-protokoll", { meetingId })).status).toBe(403);
      const refusedDraft = await generate(club.founder, "versammlung-protokoll", { meetingId: draftMeetingId });
      expect(refusedDraft.status).toBe(409);
      expect((await body(refusedDraft)).error.details.code).toBe("minutes_not_approved");
      expect((await generate(club.founder, "versammlung-protokoll", { meetingId: randomUUID() })).status).toBe(404);
      expect((await generate(other.founder, "versammlung-protokoll", { meetingId }, other.clubId)).status).toBe(404);
      expect((await generate(club.founder, "versammlung-protokoll", { meetingId, version: 7 })).status).toBe(409);

      const protocol = await generate(club.founder, "versammlung-protokoll", { meetingId });
      expect(protocol.status).toBe(201);
      const invitation = await generate(club.founder, "versammlung-einladung", { meetingId });
      expect(invitation.status).toBe(201);
      const [doc] = await db.select().from(documents).where(eq(documents.id, (await body(invitation)).data.documentId));
      const [folder] = await db.select().from(documentFolders).where(eq(documentFolders.id, doc!.folderId!));
      expect(folder!.systemKey).toBe("versammlungen");
      expect((await generate(club.founder, "versammlung-einladung", { meetingId: draftMeetingId })).status).toBe(404);
    });

    it("the system request after the approval needs no user and prints the text as text", async () => {
      const job = await requestRender({ clubId: id(), templateId: "versammlung-protokoll", params: { meetingId, version: 1 }, actor: null, idempotencyKey: `protokoll:${meetingId}:1` });
      expect(job.status).toBe("fertig");
      const built = await getTemplate("versammlung-protokoll")!.build(id(), { meetingId, version: 1 });
      expect(JSON.stringify(built.data)).toContain("<script>");
      const layout = getTemplate("versammlung-protokoll")!.layout(built, { clubName: "V", primaryColor: "#2c4870", accentColor: "#2c4870", letterhead: [] }, {});
      expect(layout.blocks.every((b) => ["heading", "paragraph", "keyValue"].includes(b.type))).toBe(true);
      // The key makes a repeat the same job.
      const again = await requestRender({ clubId: id(), templateId: "versammlung-protokoll", params: { meetingId, version: 1 }, actor: null, idempotencyKey: `protokoll:${meetingId}:1` });
      expect(again.id).toBe(job.id);
      expect((await db.select().from(renderJobs).where(and(eq(renderJobs.clubId, id()), eq(renderJobs.templateId, "versammlung-protokoll")))).filter((j) => j.params.idempotencyKey === `protokoll:${meetingId}:1`)).toHaveLength(1);
    });
  });
});

