import { z } from "zod";

import { db } from "../../../db/client.js";
import { departments } from "../../../db/schema/departments.js";
import { eq } from "drizzle-orm";
import { ForbiddenError } from "../../errors.js";
import { assertEventScope, loadClubEvent } from "../../event-access.js";
import { buildAttendanceView } from "../../event-attendance.js";
import { clubTimezone, formatWhen, locationName } from "../../event-notify.js";
import { answerCell, loadParticipants } from "../../event-participants.js";
import { hasClubPermission } from "../../club-permissions.js";
import { defineTemplate, type TemplateLayout } from "../registry.js";

/** Attendance and participant lists of an event (Wave 13 B10): printable, with a signature column. Department scope as in the routes. */

const eventParams = z.object({ eventId: z.uuid() }).strict();
const MAX_ROWS = 2000;
const FOLDER = { systemKey: "terminlisten", name: "Anwesenheits- und Teilnehmerlisten" };

interface ListData {
  title: string;
  when: string;
  place: string | null;
  department: string | null;
  headers: string[];
  rows: string[][];
  truncated: boolean;
  supervisors: string[];
  summary: string | null;
}

async function departmentName(departmentId: string | null): Promise<string | null> {
  if (!departmentId) return null;
  const [row] = await db.select({ name: departments.name }).from(departments).where(eq(departments.id, departmentId)).limit(1);
  return row?.name ?? null;
}

async function eventHeader(clubId: string, eventId: string) {
  const { event, calendar } = await loadClubEvent(eventId, clubId);
  const timezone = await clubTimezone(clubId);
  return { event, calendar, when: formatWhen(event.startsAt, timezone, event.endsAt), place: await locationName(clubId, event.locationId), department: await departmentName(calendar.departmentId) };
}

function listLayout(d: ListData, heading: string, signatureColumn: boolean): TemplateLayout {
  return {
    format: "a4" as const,
    title: `${heading}: ${d.title}`,
    blocks: [
      { type: "heading" as const, text: `${heading}: ${d.title}` },
      { type: "keyValue" as const, rows: ([["Termin", d.when], ["Ort", d.place ?? "-"], ...(d.department ? ([["Abteilung", d.department]] as Array<[string, string]>) : []), ...(d.supervisors.length > 0 ? ([["Aufsichtspersonen", d.supervisors.join(", ")]] as Array<[string, string]>) : []), ...(d.summary ? ([["Stand", d.summary]] as Array<[string, string]>) : [])] as Array<[string, string]>) },
      ...(d.rows.length > 0
        ? [
            {
              type: "table" as const,
              columns: [...d.headers.map((h, i) => ({ title: h, width: i === 0 ? 3 : 1.6 })), ...(signatureColumn ? [{ title: "Unterschrift", width: 3 }] : [])],
              rows: d.rows.map((r) => (signatureColumn ? [...r, ""] : r)),
            },
          ]
        : [{ type: "paragraph" as const, text: "Keine Einträge." }]),
      ...(d.truncated ? [{ type: "paragraph" as const, text: `Die Liste wurde auf ${MAX_ROWS} Einträge gekürzt.` }] : []),
    ],
  };
}

export const anwesenheitslisteTemplate = defineTemplate({
  id: "anwesenheitsliste",
  version: 1,
  label: "Anwesenheitsliste",
  description: "Liste der erwarteten und erfassten Personen eines Termins mit Aufsichtspersonen und Unterschriftsspalte. Trainer und Abteilungsleitung nur für Termine der eigenen Abteilungen.",
  destination: "archive",
  permission: "documents:generate",
  docType: "anwesenheitsliste",
  sensitive: true,
  folder: FOLDER,
  sync: true,
  paramsSchema: eventParams,
  authorize: async (actor, params) => {
    if (actor.isGuest || !hasClubPermission(actor.roleTypes, "attendance:read")) throw new ForbiddenError("Missing attendance:read permission");
    const { calendar } = await loadClubEvent(params.eventId, actor.clubId);
    await assertEventScope("attendance:read", actor.roleTypes, actor.accountMemberId, calendar);
  },
  build: async (clubId, params) => {
    const header = await eventHeader(clubId, params.eventId);
    const view = await buildAttendanceView(clubId, header.event, header.calendar);
        const data: ListData = {
      title: header.event.title,
      when: header.when,
      place: header.place,
      department: header.department,
      headers: ["Name", "Status", "Hinweis"],
      rows: view.entries.slice(0, MAX_ROWS).map((e) => [e.displayName, e.attendanceId !== null ? (e.status ?? "") : "", [e.isMinor ? "minderjährig" : "", e.guestName ? "Gast" : "", e.rsvp === "warteliste" ? "Warteliste" : ""].filter(Boolean).join(", ")]),
      truncated: view.entries.length > MAX_ROWS,
      supervisors: view.supervisors.map((s) => s.displayName),
      summary: view.closed ? "Liste abgeschlossen" : "Liste offen",
    };
    return { data, title: `Anwesenheitsliste ${header.event.title}`, filename: "anwesenheitsliste.pdf" };
  },
  layout: (built) => listLayout(built.data as ListData, "Anwesenheitsliste", true),
});

export const teilnehmerlisteTemplate = defineTemplate({
  id: "teilnehmerliste",
  version: 1,
  label: "Teilnehmerliste",
  description: "Angemeldete Personen eines Termins (Mitglieder, Gäste) mit den nicht vertraulichen Angaben aus dem Anmeldeformular und Unterschriftsspalte.",
  destination: "archive",
  permission: "documents:generate",
  docType: "teilnehmerliste",
  sensitive: true,
  folder: FOLDER,
  sync: true,
  paramsSchema: eventParams,
  authorize: async (actor, params) => {
    if (actor.isGuest || !hasClubPermission(actor.roleTypes, "registrations:read")) throw new ForbiddenError("Missing registrations:read permission");
    const { calendar } = await loadClubEvent(params.eventId, actor.clubId);
    await assertEventScope("registrations:read", actor.roleTypes, actor.accountMemberId, calendar);
  },
  build: async (clubId, params) => {
    const header = await eventHeader(clubId, params.eventId);
    // Sensitive answers never go into a printed list; guest e-mail addresses stay out as well.
    const { participants, fields } = await loadParticipants(header.event.id, false);
    const active = participants.filter((p) => p.status === "angemeldet" || p.status === "warteliste");
    const shownFields = fields.filter((f) => !f.sensitive && f.type !== "file" && f.type !== "image").slice(0, 3);
    const data: ListData = {
      title: header.event.title,
      when: header.when,
      place: header.place,
      department: header.department,
      headers: ["Name", "Status", "Personen", ...shownFields.map((f) => f.label)],
      rows: active.slice(0, MAX_ROWS).map((p) => [p.displayName + (p.kind === "guest" ? " (Gast)" : ""), p.status, String(p.partySize), ...shownFields.map((f) => answerCell(p.answers[f.key]))]),
      truncated: active.length > MAX_ROWS,
      supervisors: [],
      summary: `${active.reduce((s, p) => s + (p.status === "angemeldet" ? p.partySize : 0), 0)} Personen angemeldet`,
    };
    return { data, title: `Teilnehmerliste ${header.event.title}`, filename: "teilnehmerliste.pdf" };
  },
  layout: (built) => listLayout(built.data as ListData, "Teilnehmerliste", true),
});
