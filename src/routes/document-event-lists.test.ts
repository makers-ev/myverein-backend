import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "../db/client.js";
import { documentFolders, documents } from "../db/schema/documents.js";
import { eventAttendance, eventAttendanceSheets, eventAttendanceSupervisors } from "../db/schema/event-attendance.js";
import { getTemplate } from "../lib/pdf/registry.js";
import { registerBuiltinTemplates } from "../lib/pdf/templates/index.js";
import { documentGenerationRoutes } from "./document-generation.js";
import { documentRoutes } from "./documents.js";
import { createEventFixture, HOUR, type EventFixture } from "./event-test-support.js";

/** Wave 13 B10: attendance and participant lists of an event (department scope, signature column, readable by the requester). */
describe("attendance and participant lists", () => {
  let fx: EventFixture;
  let eventA: string;
  let eventB: string;
  let kid: string;

  beforeAll(async () => {
    registerBuiltinTemplates();
    fx = await createEventFixture("rlist", [["/document-generation", documentGenerationRoutes], ["/documents", documentRoutes]]);
    kid = await fx.addAccountless("Kind Klein", { birthDate: "2018-05-05", departmentId: fx.deptA });
    await fx.addAccountless("Erwachsene Gross", { birthDate: "1990-01-01", departmentId: fx.deptA });
    eventA = (await fx.addEvent({ calendarId: fx.calA, title: "Training A", startsAt: new Date(Date.now() - HOUR), endsAt: new Date(Date.now() + HOUR) })).id;
    eventB = (await fx.addEvent({ calendarId: fx.calB, title: "Training B", startsAt: new Date(Date.now() - HOUR) })).id;
    const [sheet] = await db.insert(eventAttendanceSheets).values({ eventId: eventA }).returning();
    await db.insert(eventAttendance).values({ sheetId: sheet!.id, clubMemberId: kid, status: "anwesend", source: "manuell" });
    await db.insert(eventAttendanceSupervisors).values({ sheetId: sheet!.id, clubMemberId: fx.users.trainerA.clubMemberId });
  }, 60_000);
  afterAll(async () => fx.cleanup());

  const generate = (who: { cookie: string }, templateId: string, eventId: string) => fx.req(who, "/document-generation", { method: "POST", body: { templateId, params: { eventId } } });

  it("a trainer lists the events of their own department only, the result is readable for them", async () => {
    const own = await generate(fx.users.trainerA, "anwesenheitsliste", eventA);
    expect(own.status).toBe(201);
    const job = (await fx.json(own)).data;
    const dl = await fx.req(fx.users.trainerA, `/documents/${job.documentId}/download`);
    expect(dl.status).toBe(200);
    expect(Buffer.from(await dl.arrayBuffer()).toString("latin1", 0, 5)).toBe("%PDF-");
    // The same document is invisible for a plain member, and the other department's event is out of reach.
    expect((await fx.req(fx.users.member1, `/documents/${job.documentId}/download`)).status).toBe(404);
    expect((await generate(fx.users.trainerA, "anwesenheitsliste", eventB)).status).toBe(403);
    expect((await generate(fx.users.leaderA, "anwesenheitsliste", eventA)).status).toBe(201);
    expect((await generate(fx.users.board, "anwesenheitsliste", eventB)).status).toBe(201);
    expect((await generate(fx.users.member1, "anwesenheitsliste", eventA)).status).toBe(403);
    expect((await generate(fx.users.outsider, "anwesenheitsliste", eventA)).status).toBe(404);
    const [doc] = await db.select().from(documents).where(eq(documents.id, job.documentId));
    const [folder] = await db.select().from(documentFolders).where(eq(documentFolders.id, doc!.folderId!));
    expect(folder!.systemKey).toBe("terminlisten");
  });

  it("holds the names, the recorded status and the supervisors, but no prefilled absence", async () => {
    const built = await getTemplate("anwesenheitsliste")!.build(fx.clubId, { eventId: eventA });
    const data = built.data as { rows: string[][]; supervisors: string[]; headers: string[] };
    const kidRow = data.rows.find((r) => r[0] === "Kind Klein")!;
    expect(kidRow[1]).toBe("anwesend");
    expect(kidRow[2]).toContain("minderjährig");
    expect(data.rows.find((r) => r[0] === "Erwachsene Gross")![1]).toBe("");
    expect(data.supervisors).toContain("Trainer A");
    const layout = getTemplate("anwesenheitsliste")!.layout(built, { clubName: "V", primaryColor: "#2c4870", accentColor: "#2c4870", letterhead: [] }, {});
    const table = layout.blocks.find((b) => b.type === "table");
    expect(table && table.type === "table" ? table.columns.map((c) => c.title) : []).toContain("Unterschrift");
  });

  it("the participant list needs registrations:read in the department and leaves out sensitive answers", async () => {
    expect((await generate(fx.users.trainerA, "teilnehmerliste", eventA)).status).toBe(201);
    expect((await generate(fx.users.trainerA, "teilnehmerliste", eventB)).status).toBe(403);
    expect((await generate(fx.users.member1, "teilnehmerliste", eventA)).status).toBe(403);
    const built = await getTemplate("teilnehmerliste")!.build(fx.clubId, { eventId: eventA });
    expect((built.data as { headers: string[] }).headers.slice(0, 3)).toEqual(["Name", "Status", "Personen"]);
  });
});
