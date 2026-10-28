import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { z } from "zod";

import { db } from "../../../db/client.js";
import { meetingInvitations, meetingMinutes } from "../../../db/schema/assembly.js";
import { meetings, type MeetingRow } from "../../../db/schema/meetings.js";
import { deliverySummary, type InvitationContent } from "../../assembly-invitation.js";
import { hasClubPermission } from "../../club-permissions.js";
import { ConflictError, ForbiddenError, NotFoundError } from "../../errors.js";
import { clubTimezone, formatWhen, locationName } from "../../event-notify.js";
import { composeMinutesDoc, type ExportDoc } from "../../minutes.js";
import { defineTemplate, type TemplateLayout } from "../registry.js";
import { paragraphChunks } from "./shared.js";

/** General assembly documents (Wave 13 B10): the invitation as a proof of what was sent, and the approved minutes. */

const meetingParams = z.object({ meetingId: z.uuid(), version: z.number().int().min(1).max(10_000).optional() }).strict();

async function loadMeeting(clubId: string, meetingId: string): Promise<MeetingRow> {
  const [row] = await db.select().from(meetings).where(and(eq(meetings.id, meetingId), eq(meetings.clubId, clubId))).limit(1);
  if (!row) throw new NotFoundError("Meeting not found");
  return row;
}

function requireAssemblyManage(roleTypes: readonly string[], isGuest: boolean): void {
  if (isGuest || !hasClubPermission(roleTypes, "assembly:manage")) throw new ForbiddenError("Missing assembly:manage permission");
}

/** An ExportDoc (heading, facts, sections) as declarative blocks. */
export function blocksOfDoc(doc: ExportDoc): TemplateLayout["blocks"] {
  return [
    { type: "heading", text: doc.title },
    { type: "keyValue", rows: doc.facts },
    ...doc.sections.flatMap((s): TemplateLayout["blocks"] => [
      { type: "heading", text: s.heading, level: 2 },
      ...(s.lines.length > 0 ? paragraphChunks(s.lines.map((l) => `- ${l}`).join("\n")).map((text) => ({ type: "paragraph" as const, text })) : []),
      ...(s.pre !== undefined ? paragraphChunks(s.pre).map((text) => ({ type: "paragraph" as const, text })) : []),
    ]),
  ];
}

interface DocData {
  doc: ExportDoc;
}

export const versammlungProtokollTemplate = defineTemplate({
  id: "versammlung-protokoll",
  version: 1,
  label: "Versammlungsprotokoll",
  description: "Das genehmigte Protokoll mit Einladungsnachweis, Anwesenheit, Beschlüssen, Berichtigungsvermerken und Prüfsumme. Nur für genehmigte Fassungen.",
  destination: "archive",
  permission: "documents:generate",
  docType: "versammlung_protokoll",
  sensitive: false,
  folder: { systemKey: "versammlungen", name: "Versammlungen" },
  sync: true,
  paramsSchema: meetingParams,
  authorize: async (actor, params) => {
    requireAssemblyManage(actor.roleTypes, actor.isGuest);
    await loadMeeting(actor.clubId, params.meetingId);
    const approved = await approvedVersion(params.meetingId, params.version);
    if (!approved) throw new ConflictError("Only approved minutes can be filed", { details: { code: "minutes_not_approved" } });
  },
  build: async (clubId, params): Promise<{ data: DocData; title: string; filename: string }> => {
    const meeting = await loadMeeting(clubId, params.meetingId);
    const approved = await approvedVersion(meeting.id, params.version);
    if (!approved) throw new NotFoundError("Approved minutes not found");
    // Names of the present stay out: the filed minutes carry the numbers, the voting roll is a different document.
    const doc = await composeMinutesDoc({ meeting, includeDrafts: false, includeNames: false, onlyVersion: approved });
    return { data: { doc }, title: doc.title, filename: `protokoll-version-${approved}.pdf` };
  },
  layout: (built) => ({ format: "a4" as const, title: built.title, blocks: blocksOfDoc((built.data as DocData).doc) }),
});

/** The version number to file: the given one if it is approved, else the newest approved one. */
async function approvedVersion(meetingId: string, requested: number | undefined): Promise<number | null> {
  const rows = await db
    .select({ version: meetingMinutes.version })
    .from(meetingMinutes)
    .where(and(eq(meetingMinutes.meetingId, meetingId), isNotNull(meetingMinutes.approvedAt), inArray(meetingMinutes.status, ["genehmigt", "archiviert"])))
    .orderBy(desc(meetingMinutes.version));
  if (requested !== undefined) return rows.some((r) => r.version === requested) ? requested : null;
  return rows[0]?.version ?? null;
}

interface InvitationData {
  title: string;
  kind: string;
  version: number;
  sentAt: string;
  scheduledAt: string | null;
  place: string | null;
  timezone: string;
  recipientCount: number;
  contentHash: string;
  agenda: Array<{ position: number; title: string; description: string | null }>;
  agendaText: string | null;
  message: string | null;
  periodOk: boolean | null;
  requiredDays: number | null;
  daysAvailable: number | null;
  exceptionReason: string | null;
  delivery: Array<{ channel: string; status: string; count: number }>;
}

export const versammlungEinladungTemplate = defineTemplate({
  id: "versammlung-einladung",
  version: 1,
  label: "Versammlungseinladung (Versandnachweis)",
  description: "Die versendete Einladung (oder der Nachtrag) mit Tagesordnung, Fristprüfung, Zustellübersicht und Prüfsumme als Nachweis.",
  destination: "archive",
  permission: "documents:generate",
  docType: "versammlung_einladung",
  sensitive: false,
  folder: { systemKey: "versammlungen", name: "Versammlungen" },
  sync: true,
  paramsSchema: meetingParams,
  authorize: async (actor, params) => {
    requireAssemblyManage(actor.roleTypes, actor.isGuest);
    await loadMeeting(actor.clubId, params.meetingId);
    if (!(await pickInvitation(params.meetingId, params.version))) throw new NotFoundError("Invitation not found");
  },
  build: async (clubId, params): Promise<{ data: InvitationData; title: string; filename: string }> => {
    const meeting = await loadMeeting(clubId, params.meetingId);
    const invitation = await pickInvitation(meeting.id, params.version);
    if (!invitation) throw new NotFoundError("Invitation not found");
    const content = invitation.content as InvitationContent;
    const period = invitation.periodCheck as { ok?: boolean; requiredDays?: number | null; daysAvailable?: number | null };
    const timezone = await clubTimezone(clubId);
    const data: InvitationData = {
      title: content.title,
      kind: invitation.kind,
      version: invitation.version,
      sentAt: invitation.sentAt.toISOString(),
      scheduledAt: content.scheduledAt,
      place: content.place ?? (await locationName(clubId, meeting.locationId)),
      timezone,
      recipientCount: invitation.recipientCount,
      contentHash: invitation.contentHash,
      agenda: content.agenda.map((a) => ({ position: a.position, title: a.title, description: a.description })),
      agendaText: content.agendaText,
      message: content.message,
      periodOk: typeof period.ok === "boolean" ? period.ok : null,
      requiredDays: period.requiredDays ?? null,
      daysAvailable: period.daysAvailable ?? null,
      exceptionReason: invitation.exceptionReason,
      delivery: await deliverySummary(invitation.id),
    };
    return { data, title: `${invitation.kind === "nachtrag" ? "Nachtrag" : "Einladung"}: ${content.title}`, filename: `einladung-version-${invitation.version}.pdf` };
  },
  layout: (built) => {
    const d = built.data as InvitationData;
    const heading = d.kind === "nachtrag" ? "Nachtrag zur Einladung" : "Einladung";
    const period =
      d.periodOk === null ? "-" : d.periodOk ? "Einladungsfrist eingehalten" : `Einladungsfrist nicht eingehalten (verfügbar ${d.daysAvailable ?? "?"} Tage, erforderlich ${d.requiredDays ?? "?"} Tage)${d.exceptionReason ? `; Begründung: ${d.exceptionReason}` : ""}`;
    return {
      format: "a4" as const,
      title: built.title,
      blocks: [
        { type: "heading", text: `${heading}: ${d.title}` },
        { type: "keyValue", rows: [["Termin", formatWhen(d.scheduledAt ? new Date(d.scheduledAt) : null, d.timezone)], ["Ort", d.place ?? "-"], ["Versendet am", formatWhen(new Date(d.sentAt), d.timezone)], ["Empfänger", String(d.recipientCount)], ["Frist", period]] },
        ...(d.message ? [{ type: "paragraph" as const, text: d.message }] : []),
        { type: "heading", text: "Tagesordnung", level: 2 },
        ...(d.agenda.length > 0
          ? [{ type: "paragraph" as const, text: d.agenda.map((a) => `${a.position}. ${a.title}${a.description ? ` - ${a.description}` : ""}`).join("\n") }]
          : d.agendaText
            ? paragraphChunks(d.agendaText).map((text) => ({ type: "paragraph" as const, text }))
            : [{ type: "paragraph" as const, text: "Keine Tagesordnung angegeben." }]),
        { type: "heading", text: "Zustellung", level: 2 },
        { type: "paragraph", text: d.delivery.length > 0 ? d.delivery.map((x) => `${x.channel}: ${x.count} ${x.status}`).join("\n") : "Keine Zustellungen erfasst." },
        { type: "keyValue", rows: [["Prüfsumme (SHA-256 des Inhalts)", d.contentHash]] },
      ],
    };
  },
});

async function pickInvitation(meetingId: string, version: number | undefined) {
  const [row] = await db
    .select()
    .from(meetingInvitations)
    .where(version === undefined ? eq(meetingInvitations.meetingId, meetingId) : and(eq(meetingInvitations.meetingId, meetingId), eq(meetingInvitations.version, version)))
    .orderBy(desc(meetingInvitations.version))
    .limit(1);
  return row ?? null;
}
