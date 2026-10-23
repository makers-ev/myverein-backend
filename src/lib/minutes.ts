import { createHash } from "node:crypto";

import { and, asc, desc, eq, inArray, isNotNull } from "drizzle-orm";

import { db } from "../db/client.js";
import { MINUTES_CONFIRM_ROLES, meetingInvitations, meetingMinutes, meetingMinutesAmendments, meetingMinutesConfirmations, type MeetingMinutesRow } from "../db/schema/assembly.js";
import { meetingAttendance, meetingResolutions, meetings, type MeetingRow } from "../db/schema/meetings.js";
import { writeAudit } from "./audit.js";
import { computeQuorum } from "./assembly-attendance.js";
import { deliverySummary } from "./assembly-invitation.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { clubTimezone, formatWhen, locationName } from "./event-notify.js";
import { clubMembersByIds } from "./meeting-members.js";

/**
 * Minutes with a version history and a state machine (Wave 11 B9): `entwurf` -> `zur_genehmigung` -> `genehmigt` -> `archiviert`.
 * - Only an `entwurf` can be edited. Chair and secretary confirm the text in text form (`MINUTES_CONFIRM_ROLES`), any change drops
 *   the confirmations; both are needed before the version goes to approval.
 * - `genehmigt` happens ONLY through a resolution in a LATER meeting of the same type (`approvedInMeetingId` / `approvedResolutionId`).
 *   From then on the version is immutable: this module refuses, and the trigger `meeting_minutes_guard` (migration 0051) refuses
 *   on the database level. Corrections are Berichtigungsvermerke (`meeting_minutes_amendments`, append-only).
 * - If the approval fails, `reopen` supersedes the submitted version (it becomes `archiviert` WITHOUT `approvedAt`, it was never
 *   approved) and starts the next version as a draft with the same text.
 * - A decision record of a circular resolution is version 1 with status `archiviert` and `approvedAt` set (the result is final).
 * Hash: SHA-256 (hex) of the UTF-8 text, so anybody can check a copy.
 */

export const minutesHash = (content: string): string => createHash("sha256").update(content, "utf8").digest("hex");

const fail = {
  conflict: (message: string, code: string, extra: Record<string, unknown> = {}) => new ConflictError(message, { details: { code, ...extra } }),
  invalid: (message: string, code: string, extra: Record<string, unknown> = {}) => new ValidationError(message, { details: { code, ...extra } }),
};

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Serialises every change of one meeting's minutes. */
async function lockMeeting(tx: Tx, clubId: string, meetingId: string): Promise<MeetingRow> {
  const [row] = await tx.select().from(meetings).where(and(eq(meetings.id, meetingId), eq(meetings.clubId, clubId))).for("update");
  if (!row) throw new NotFoundError("Meeting not found");
  return row;
}

async function latestOf(tx: Tx | typeof db, meetingId: string): Promise<MeetingMinutesRow | undefined> {
  const [row] = await tx.select().from(meetingMinutes).where(eq(meetingMinutes.meetingId, meetingId)).orderBy(desc(meetingMinutes.version)).limit(1);
  return row;
}

/** A version that was approved (also an archived one); a superseded, never approved version has no `approvedAt`. */
const isApproved = (row: Pick<MeetingMinutesRow, "approvedAt" | "status">): boolean => row.approvedAt !== null && (row.status === "genehmigt" || row.status === "archiviert");

// --- Writing -------------------------------------------------------------------------------------------------------------

/** Saves the working draft (creates version 1 when there is none). An edit drops the confirmations. */
export async function saveMinutesDraft(args: { clubId: string; meetingId: string; content: string; userId: string }): Promise<MeetingMinutesRow> {
  return db.transaction(async (tx) => {
    await lockMeeting(tx, args.clubId, args.meetingId);
    const latest = await latestOf(tx, args.meetingId);
    const hash = minutesHash(args.content);
    let row: MeetingMinutesRow;
    if (!latest) {
      [row] = await tx.insert(meetingMinutes).values({ meetingId: args.meetingId, version: 1, status: "entwurf", content: args.content, contentHash: hash, createdBy: args.userId }).returning();
    } else if (latest.status === "entwurf") {
      if (latest.contentHash === hash) return latest;
      await tx.delete(meetingMinutesConfirmations).where(eq(meetingMinutesConfirmations.minutesId, latest.id));
      [row] = await tx.update(meetingMinutes).set({ content: args.content, contentHash: hash, updatedAt: new Date() }).where(eq(meetingMinutes.id, latest.id)).returning();
    } else {
      throw fail.conflict("These minutes cannot be edited any more", "minutes_locked", { status: latest.status, version: latest.version });
    }
    await writeAudit(tx, { eventType: "meeting_minutes.save", subjectId: row!.id, payload: { clubId: args.clubId, meetingId: args.meetingId, version: row!.version } });
    return row!;
  });
}

/** Chair or secretary confirms the current draft text. Two different accounts are needed for the two roles. */
export async function confirmMinutes(args: { clubId: string; meetingId: string; role: (typeof MINUTES_CONFIRM_ROLES)[number]; userId: string }): Promise<MeetingMinutesRow> {
  return db.transaction(async (tx) => {
    await lockMeeting(tx, args.clubId, args.meetingId);
    const latest = await latestOf(tx, args.meetingId);
    if (!latest || latest.status !== "entwurf") throw fail.conflict("Only a draft can be confirmed", "minutes_not_draft");
    if (latest.content.trim() === "") throw fail.invalid("The minutes are empty", "minutes_empty");
    const existing = await tx.select().from(meetingMinutesConfirmations).where(eq(meetingMinutesConfirmations.minutesId, latest.id));
    if (existing.some((e) => e.role === args.role)) throw fail.conflict("This role has already confirmed", "minutes_already_confirmed", { role: args.role });
    if (existing.some((e) => e.confirmedBy === args.userId)) throw fail.conflict("Chair and secretary must be two different persons", "minutes_two_persons");
    await tx.insert(meetingMinutesConfirmations).values({ minutesId: latest.id, role: args.role, confirmedBy: args.userId, contentHash: latest.contentHash });
    await writeAudit(tx, { eventType: "meeting_minutes.confirm", subjectId: latest.id, payload: { clubId: args.clubId, meetingId: args.meetingId, version: latest.version, role: args.role } });
    return latest;
  });
}

export async function submitMinutes(args: { clubId: string; meetingId: string; userId: string }): Promise<MeetingMinutesRow> {
  return db.transaction(async (tx) => {
    await lockMeeting(tx, args.clubId, args.meetingId);
    const latest = await latestOf(tx, args.meetingId);
    if (!latest || latest.status !== "entwurf") throw fail.conflict("Only a draft can be submitted for approval", "minutes_not_draft");
    if (latest.content.trim() === "") throw fail.invalid("The minutes are empty", "minutes_empty");
    const confirmed = await tx.select().from(meetingMinutesConfirmations).where(eq(meetingMinutesConfirmations.minutesId, latest.id));
    const missing = MINUTES_CONFIRM_ROLES.filter((role) => !confirmed.some((c) => c.role === role && c.contentHash === latest.contentHash));
    if (missing.length > 0) throw fail.conflict("The chair and the secretary have to confirm the text first", "minutes_not_confirmed", { missing });
    const [row] = await tx.update(meetingMinutes).set({ status: "zur_genehmigung", updatedAt: new Date() }).where(eq(meetingMinutes.id, latest.id)).returning();
    await writeAudit(tx, { eventType: "meeting_minutes.submit", subjectId: latest.id, payload: { clubId: args.clubId, meetingId: args.meetingId, version: latest.version } });
    return row!;
  });
}

/** The approval did not happen: supersede the submitted version and continue with a new draft of the same text. */
export async function reopenMinutes(args: { clubId: string; meetingId: string; userId: string }): Promise<MeetingMinutesRow> {
  return db.transaction(async (tx) => {
    await lockMeeting(tx, args.clubId, args.meetingId);
    const latest = await latestOf(tx, args.meetingId);
    if (!latest || latest.status !== "zur_genehmigung") throw fail.conflict("Only minutes submitted for approval can be reopened", "minutes_not_submitted");
    await tx.update(meetingMinutes).set({ status: "archiviert", updatedAt: new Date() }).where(eq(meetingMinutes.id, latest.id));
    const [row] = await tx
      .insert(meetingMinutes)
      .values({ meetingId: args.meetingId, version: latest.version + 1, status: "entwurf", content: latest.content, contentHash: latest.contentHash, createdBy: args.userId })
      .returning();
    await writeAudit(tx, { eventType: "meeting_minutes.reopen", subjectId: row!.id, payload: { clubId: args.clubId, meetingId: args.meetingId, version: row!.version } });
    return row!;
  });
}

/** Approval by a resolution of a later meeting of the same type (the agenda item "Genehmigung des Protokolls"). */
export async function approveMinutes(args: { clubId: string; meetingId: string; resolutionId: string; userId: string }): Promise<MeetingMinutesRow> {
  return db.transaction(async (tx) => {
    const meeting = await lockMeeting(tx, args.clubId, args.meetingId);
    const latest = await latestOf(tx, args.meetingId);
    if (!latest || latest.status !== "zur_genehmigung") throw fail.conflict("The minutes have to be submitted for approval first", "minutes_not_submitted");
    const [found] = await tx
      .select({ resolution: meetingResolutions, meeting: meetings })
      .from(meetingResolutions)
      .innerJoin(meetings, eq(meetings.id, meetingResolutions.meetingId))
      .where(and(eq(meetingResolutions.id, args.resolutionId), eq(meetings.clubId, args.clubId)));
    if (!found) throw new NotFoundError("Resolution not found");
    const approving = found.meeting;
    if (approving.id === meeting.id || !approving.scheduledAt || !meeting.scheduledAt || approving.scheduledAt.getTime() <= meeting.scheduledAt.getTime()) {
      throw fail.invalid("Minutes are approved in a later meeting", "approval_meeting_not_later");
    }
    if (approving.type !== meeting.type) throw fail.invalid("The approving meeting must be of the same type", "approval_meeting_type_mismatch");
    if (!found.resolution.result.trim().toLowerCase().startsWith("angenommen")) throw fail.invalid("The resolution was not accepted", "resolution_not_accepted");
    const approvedAt = new Date();
    const [row] = await tx
      .update(meetingMinutes)
      .set({ status: "genehmigt", approvedInMeetingId: approving.id, approvedResolutionId: found.resolution.id, approvedAt, updatedAt: approvedAt })
      .where(eq(meetingMinutes.id, latest.id))
      .returning();
    await writeAudit(tx, { eventType: "meeting_minutes.approve", subjectId: latest.id, payload: { clubId: args.clubId, meetingId: args.meetingId, version: latest.version, approvedInMeetingId: approving.id } });
    return row!;
  });
}

export async function archiveMinutes(args: { clubId: string; meetingId: string; userId: string }): Promise<MeetingMinutesRow> {
  return db.transaction(async (tx) => {
    await lockMeeting(tx, args.clubId, args.meetingId);
    const latest = await latestOf(tx, args.meetingId);
    if (!latest || latest.status !== "genehmigt") throw fail.conflict("Only approved minutes can be archived", "minutes_not_approved");
    const [row] = await tx.update(meetingMinutes).set({ status: "archiviert", updatedAt: new Date() }).where(eq(meetingMinutes.id, latest.id)).returning();
    await writeAudit(tx, { eventType: "meeting_minutes.archive", subjectId: latest.id, payload: { clubId: args.clubId, meetingId: args.meetingId, version: latest.version } });
    return row!;
  });
}

/** Berichtigungsvermerk on the approved version: the text stays as it was approved. */
export async function addMinutesAmendment(args: { clubId: string; meetingId: string; note: string; userId: string }) {
  return db.transaction(async (tx) => {
    await lockMeeting(tx, args.clubId, args.meetingId);
    const [target] = await tx
      .select()
      .from(meetingMinutes)
      .where(and(eq(meetingMinutes.meetingId, args.meetingId), isNotNull(meetingMinutes.approvedAt), inArray(meetingMinutes.status, ["genehmigt", "archiviert"])))
      .orderBy(desc(meetingMinutes.version))
      .limit(1);
    if (!target) throw fail.conflict("Only approved minutes take a Berichtigungsvermerk", "minutes_not_approved");
    const [row] = await tx.insert(meetingMinutesAmendments).values({ minutesId: target.id, note: args.note, createdBy: args.userId }).returning();
    await writeAudit(tx, { eventType: "meeting_minutes.amend", subjectId: row!.id, payload: { clubId: args.clubId, meetingId: args.meetingId, version: target.version } });
    return { ...row!, version: target.version };
  });
}

// --- Reading -------------------------------------------------------------------------------------------------------------

/** What one caller may see: managers every version, everybody else the latest approved version only. */
export async function visibleMinutes(meetingId: string, includeDrafts: boolean): Promise<MeetingMinutesRow | undefined> {
  if (includeDrafts) return latestOf(db, meetingId);
  const [row] = await db
    .select()
    .from(meetingMinutes)
    .where(and(eq(meetingMinutes.meetingId, meetingId), isNotNull(meetingMinutes.approvedAt), inArray(meetingMinutes.status, ["genehmigt", "archiviert"])))
    .orderBy(desc(meetingMinutes.version))
    .limit(1);
  return row;
}

export function shapeMinutes(row: MeetingMinutesRow, confirmations?: Array<typeof meetingMinutesConfirmations.$inferSelect>) {
  return {
    id: row.id,
    meetingId: row.meetingId,
    version: row.version,
    status: row.status,
    approved: isApproved(row),
    content: row.content,
    contentHash: row.contentHash,
    approvedInMeetingId: row.approvedInMeetingId,
    approvedResolutionId: row.approvedResolutionId,
    approvedAt: row.approvedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(confirmations ? { confirmations: confirmations.map((c) => ({ role: c.role, confirmedAt: c.confirmedAt, matchesText: c.contentHash === row.contentHash })) } : {}),
  };
}

/** Full minutes view: the version the caller sees, the version list (managers) and the Berichtigungsvermerke. */
export async function readMinutes(meeting: MeetingRow, includeDrafts: boolean) {
  const current = await visibleMinutes(meeting.id, includeDrafts);
  const versions = includeDrafts
    ? (await db.select().from(meetingMinutes).where(eq(meetingMinutes.meetingId, meeting.id)).orderBy(asc(meetingMinutes.version))).map((v) => ({ id: v.id, version: v.version, status: v.status, approved: isApproved(v), contentHash: v.contentHash, createdAt: v.createdAt, approvedAt: v.approvedAt }))
    : [];
  const confirmations = current && includeDrafts ? await db.select().from(meetingMinutesConfirmations).where(eq(meetingMinutesConfirmations.minutesId, current.id)) : undefined;
  const amendmentRows = await db
    .select({ a: meetingMinutesAmendments, version: meetingMinutes.version })
    .from(meetingMinutesAmendments)
    .innerJoin(meetingMinutes, eq(meetingMinutes.id, meetingMinutesAmendments.minutesId))
    .where(eq(meetingMinutes.meetingId, meeting.id))
    .orderBy(asc(meetingMinutesAmendments.createdAt));
  const amendments = amendmentRows.map(({ a, version }) => ({ id: a.id, version, note: a.note, createdAt: a.createdAt }));
  // The agenda item "Genehmigung des Protokolls" belongs to the next meeting of the same type.
  const next = includeDrafts && current && !isApproved(current) ? await nextMeetingOfType(meeting) : null;
  return { current: current ? shapeMinutes(current, confirmations) : null, versions, amendments, approvalHint: next };
}

async function nextMeetingOfType(meeting: MeetingRow): Promise<{ id: string; title: string; scheduledAt: Date } | null> {
  if (!meeting.scheduledAt) return null;
  const rows = await db.select({ id: meetings.id, title: meetings.title, scheduledAt: meetings.scheduledAt, status: meetings.status }).from(meetings).where(and(eq(meetings.clubId, meeting.clubId), eq(meetings.type, meeting.type)));
  const later = rows.filter((m) => m.scheduledAt && m.scheduledAt.getTime() > meeting.scheduledAt!.getTime() && m.status !== "abgesagt").sort((a, b) => a.scheduledAt!.getTime() - b.scheduledAt!.getTime());
  const first = later[0];
  return first ? { id: first.id, title: first.title, scheduledAt: first.scheduledAt! } : null;
}

/** Adds `minutes` (the visible text, or null) and `minutesStatus` to meeting rows; replaces the legacy free-text column. */
export async function attachMinutes<T extends { id: string }>(rows: T[], includeDrafts: boolean): Promise<Array<T & { minutes: string | null; minutesStatus: string | null }>> {
  if (rows.length === 0) return [];
  const versions = await db
    .select()
    .from(meetingMinutes)
    .where(and(inArray(meetingMinutes.meetingId, rows.map((r) => r.id)), includeDrafts ? undefined : and(isNotNull(meetingMinutes.approvedAt), inArray(meetingMinutes.status, ["genehmigt", "archiviert"]))))
    .orderBy(desc(meetingMinutes.version));
  const byMeeting = new Map<string, MeetingMinutesRow>();
  for (const v of versions) if (!byMeeting.has(v.meetingId)) byMeeting.set(v.meetingId, v);
  return rows.map((r) => ({ ...r, minutes: byMeeting.get(r.id)?.content ?? null, minutesStatus: byMeeting.get(r.id)?.status ?? null }));
}

// --- Export ----------------------------------------------------------------------------------------------------------------

interface ExportDoc {
  title: string;
  facts: Array<[string, string]>;
  sections: Array<{ heading: string; lines: string[]; pre?: string }>;
}

const escapeHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function renderMarkdown(doc: ExportDoc): string {
  const out = [`# ${doc.title}`, "", ...doc.facts.map(([k, v]) => `- **${k}:** ${v}`), ""];
  for (const s of doc.sections) {
    out.push(`## ${s.heading}`, "");
    if (s.lines.length > 0) out.push(...s.lines.map((l) => `- ${l}`), "");
    if (s.pre !== undefined) out.push(s.pre, "");
  }
  return out.join("\n");
}

/** Plain, self-contained HTML; every club text is escaped and the minutes text stays preformatted (no markdown rendering, no scripts). */
function renderHtml(doc: ExportDoc): string {
  const body = [
    `<h1>${escapeHtml(doc.title)}</h1>`,
    `<dl>${doc.facts.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join("")}</dl>`,
    ...doc.sections.map((s) => `<section><h2>${escapeHtml(s.heading)}</h2>${s.lines.length > 0 ? `<ul>${s.lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>` : ""}${s.pre !== undefined ? `<pre>${escapeHtml(s.pre)}</pre>` : ""}</section>`),
  ].join("\n");
  return `<!doctype html>\n<html lang="de"><head><meta charset="utf-8"><title>${escapeHtml(doc.title)}</title><style>body{font-family:sans-serif;max-width:48rem;margin:2rem auto;padding:0 1rem;line-height:1.5}dt{font-weight:bold}pre{white-space:pre-wrap;font-family:inherit}</style></head><body>\n${body}\n</body></html>\n`;
}

/** Export of the minutes the caller may see: attendance, quorum, invitation proof, resolutions with results, text, amendments, hash. */
export async function exportMinutes(args: { meeting: MeetingRow; includeDrafts: boolean; includeNames: boolean; format: "html" | "md" }): Promise<{ body: string; contentType: string }> {
  const { meeting } = args;
  const version = await visibleMinutes(meeting.id, args.includeDrafts);
  if (!version) throw new NotFoundError("Minutes not found");
  const timezone = await clubTimezone(meeting.clubId);
  const place = await locationName(meeting.clubId, meeting.locationId);

  const attendance = await db.select().from(meetingAttendance).where(eq(meetingAttendance.meetingId, meeting.id));
  const present = attendance.filter((a) => a.present);
  const people = args.includeNames ? await clubMembersByIds(db, meeting.clubId, present.flatMap((a) => (a.clubMemberId ? [a.clubMemberId] : []))) : new Map();
  const quorum = await computeQuorum(db, meeting.clubId, meeting);
  const resolutions = await db.select().from(meetingResolutions).where(eq(meetingResolutions.meetingId, meeting.id)).orderBy(asc(meetingResolutions.createdAt));
  const [invitation] = await db.select().from(meetingInvitations).where(eq(meetingInvitations.meetingId, meeting.id)).orderBy(asc(meetingInvitations.version)).limit(1);
  const amendments = (await readMinutes(meeting, args.includeDrafts)).amendments;

  const sections: ExportDoc["sections"] = [];
  if (invitation) {
    const period = invitation.periodCheck as { ok?: boolean; requiredDays?: number | null; daysAvailable?: number | null };
    const delivery = await deliverySummary(invitation.id);
    sections.push({
      heading: "Einladung",
      lines: [
        `Versand am ${formatWhen(invitation.sentAt, timezone)} an ${invitation.recipientCount} Empfänger`,
        period.ok ? "Einladungsfrist eingehalten" : `Einladungsfrist nicht eingehalten (verfügbar ${period.daysAvailable ?? "?"} Tage, erforderlich ${period.requiredDays ?? "?"} Tage)${invitation.exceptionReason ? `; Begründung: ${invitation.exceptionReason}` : ""}`,
        ...delivery.map((d) => `Zustellung ${d.channel}: ${d.count} ${d.status}`),
      ],
    });
  }
  sections.push({
    heading: "Anwesenheit und Beschlussfähigkeit",
    lines: [
      `Anwesend: ${present.length}, davon stimmberechtigt: ${quorum.presentEligible}, vertretene Vollmachten: ${quorum.proxiesRepresented}`,
      `Stimmberechtigte insgesamt: ${quorum.eligibleTotal}`,
      `Beschlussfähigkeit: ${quorum.result.replace(/_/g, " ")}${quorum.required !== null ? ` (erforderlich ${quorum.required})` : ""}`,
      ...(args.includeNames ? present.map((a) => (a.clubMemberId ? (people.get(a.clubMemberId)?.displayName ?? "(unbekannt)") : "(pseudonymisiert)")) : []),
    ],
  });
  sections.push({
    heading: "Beschlüsse",
    lines: resolutions.map((r) => `${r.description}: ${r.votesFor} Ja, ${r.votesAgainst} Nein, ${r.votesAbstain} Enthaltungen, ${r.result}${r.source === "digital" ? " (digitale Abstimmung)" : ""}${r.correctionNote ? `; Berichtigung: ${r.correctionNote}` : ""}`),
  });
  sections.push({ heading: "Protokoll", lines: [], pre: version.content });
  if (amendments.length > 0) sections.push({ heading: "Berichtigungsvermerke", lines: amendments.map((a) => `${formatWhen(a.createdAt, timezone)}: ${a.note}`) });
  sections.push({ heading: "Prüfsumme", lines: [`SHA-256 des Protokolltextes (Version ${version.version}): ${version.contentHash}`] });

  const doc: ExportDoc = {
    title: `Protokoll: ${meeting.title}`,
    facts: [
      ["Termin", formatWhen(meeting.scheduledAt, timezone)],
      ...(place ? ([["Ort", place]] as Array<[string, string]>) : []),
      ["Stand", `Version ${version.version}, ${isApproved(version) ? `genehmigt am ${formatWhen(version.approvedAt, timezone)}` : "nicht genehmigt (Entwurf)"}`],
    ],
    sections,
  };
  return args.format === "html" ? { body: renderHtml(doc), contentType: "text/html; charset=utf-8" } : { body: renderMarkdown(doc), contentType: "text/markdown; charset=utf-8" };
}
