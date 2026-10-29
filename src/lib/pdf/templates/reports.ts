import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";

import { member as accountMember, user } from "../../../auth/auth-schema.js";
import { db } from "../../../db/client.js";
import { clubMemberDepartments, clubMembers, memberCategories } from "../../../db/schema/club-members.js";
import { departments } from "../../../db/schema/departments.js";
import { writeAudit } from "../../audit.js";
import { hasClubPermission } from "../../club-permissions.js";
import { computeClubStats, type ClubStats, type StatsMember } from "../../club-stats.js";
import { loadClubStatsInput } from "../../club-stats-load.js";
import { ConflictError, ForbiddenError, NotFoundError } from "../../errors.js";
import { effectiveStatus, isLeftStatus, todayBerlin } from "../../member-lifecycle.js";
import { defineTemplate } from "../registry.js";
import { dateDe } from "./shared.js";

/** Reports of the club (Wave 13 B10): member list and annual report. Both are archive documents in a board folder. */

export const MEMBER_LIST_COLUMNS = ["memberNumber", "name", "category", "status", "joinedAt", "birthDate", "address", "phone", "email", "departments"] as const;
export type MemberListColumn = (typeof MEMBER_LIST_COLUMNS)[number];
export const MEMBER_LIST_MAX_ROWS = 5000;

const COLUMN_SPEC: Record<MemberListColumn, { title: string; width: number }> = {
  memberNumber: { title: "Nr.", width: 1.2 },
  name: { title: "Name", width: 3 },
  category: { title: "Kategorie", width: 2 },
  status: { title: "Status", width: 1.5 },
  joinedAt: { title: "Eintritt", width: 1.5 },
  birthDate: { title: "Geburtsdatum", width: 1.5 },
  address: { title: "Anschrift", width: 4 },
  phone: { title: "Telefon", width: 2 },
  email: { title: "E-Mail", width: 3 },
  departments: { title: "Abteilungen", width: 3 },
};

interface MemberListData {
  asOf: string;
  columns: MemberListColumn[];
  includeLeft: boolean;
  total: number;
  truncated: boolean;
  rows: string[][];
}

const memberListParams = z
  .object({
    columns: z.array(z.enum(MEMBER_LIST_COLUMNS)).min(1).max(MEMBER_LIST_COLUMNS.length).default(["memberNumber", "name", "category", "status", "joinedAt"]),
    asOf: z.string().date().optional(),
    includeLeft: z.boolean().default(false),
    departmentId: z.uuid().optional(),
  })
  .strict();

export const mitgliederlisteTemplate = defineTemplate({
  id: "mitgliederliste",
  version: 1,
  label: "Mitgliederliste",
  description: "Liste der Mitglieder zu einem Stichtag mit frei wählbaren Spalten. Enthält personenbezogene Daten, Erzeugung wird protokolliert.",
  destination: "archive",
  permission: "documents:generate",
  docType: "mitgliederliste",
  sensitive: true,
  folder: { systemKey: "mitgliederlisten", name: "Mitgliederlisten" },
  sync: true,
  paramsSchema: memberListParams,
  authorize: async (actor, params) => {
    if (actor.isGuest || !hasClubPermission(actor.roleTypes, "members:read_sensitive")) throw new ForbiddenError("Missing members:read_sensitive permission");
    const today = todayBerlin();
    if (params.asOf !== undefined && params.asOf > today) throw new ConflictError("The reference date must not be in the future", { details: { code: "as_of_in_future" } });
    if (params.departmentId) {
      const [dept] = await db.select({ id: departments.id }).from(departments).where(and(eq(departments.id, params.departmentId), eq(departments.clubId, actor.clubId))).limit(1);
      if (!dept) throw new NotFoundError("Department not found");
    }
    await writeAudit(db, { eventType: "member_list.generate", subjectId: actor.clubId, actorUserId: actor.userId, clubId: actor.clubId, payload: { clubId: actor.clubId, columns: params.columns, asOf: params.asOf ?? today, includeLeft: params.includeLeft } });
  },
  build: async (clubId, params) => {
    const asOf = params.asOf ?? todayBerlin();
    const members = await db
      .select({ row: clubMembers, categoryName: memberCategories.name, accountEmail: user.email })
      .from(clubMembers)
      .leftJoin(memberCategories, eq(memberCategories.id, clubMembers.categoryId))
      .leftJoin(accountMember, eq(accountMember.id, clubMembers.memberId))
      .leftJoin(user, eq(user.id, accountMember.userId))
      .where(and(eq(clubMembers.clubId, clubId), sql`${clubMembers.joinedAt} <= ${asOf}`, sql`${clubMembers.status} <> 'interessent'`));
    const ids = members.map((m) => m.row.id);
    const assignments = ids.length
      ? await db
          .select({ clubMemberId: clubMemberDepartments.clubMemberId, departmentId: clubMemberDepartments.departmentId, name: departments.name })
          .from(clubMemberDepartments)
          .innerJoin(departments, eq(departments.id, clubMemberDepartments.departmentId))
          .where(and(inArray(clubMemberDepartments.clubMemberId, ids), sql`${clubMemberDepartments.since} <= ${asOf}`, or(isNull(clubMemberDepartments.until), sql`${clubMemberDepartments.until} > ${asOf}`)))
      : [];
    const deptsOf = new Map<string, Array<{ id: string; name: string }>>();
    for (const a of assignments) deptsOf.set(a.clubMemberId, [...(deptsOf.get(a.clubMemberId) ?? []), { id: a.departmentId, name: a.name }]);

    const rows = members
      .map((m) => ({ ...m, status: m.row.leftAt !== null && m.row.leftAt > asOf ? "aktiv" : effectiveStatus(m.row, asOf) }))
      // At the reference date a person with a later exit date was still a member; one with `left_at <= asOf` already left.
      .filter((m) => (params.includeLeft ? true : !isLeftStatus(m.status) && !(m.row.leftAt !== null && m.row.leftAt <= asOf)))
      .filter((m) => !params.departmentId || (deptsOf.get(m.row.id) ?? []).some((d) => d.id === params.departmentId))
      .sort((a, b) => (a.row.lastName ?? a.row.displayName).localeCompare(b.row.lastName ?? b.row.displayName, "de") || a.row.displayName.localeCompare(b.row.displayName, "de") || a.row.id.localeCompare(b.row.id));
    const total = rows.length;
    const cell = (m: (typeof rows)[number], column: MemberListColumn): string => {
      switch (column) {
        case "memberNumber":
          return m.row.memberNumber ?? "";
        case "name":
          return m.row.displayName;
        case "category":
          return m.categoryName ?? "";
        case "status":
          return m.status;
        case "joinedAt":
          return dateDe(m.row.joinedAt);
        case "birthDate":
          return dateDe(m.row.birthDate);
        case "address":
          return [m.row.street, [m.row.postalCode, m.row.city].filter(Boolean).join(" ")].filter(Boolean).join(", ");
        case "phone":
          return m.row.phone ?? "";
        case "email":
          return m.accountEmail ?? m.row.contactEmail ?? "";
        case "departments":
          return (deptsOf.get(m.row.id) ?? []).map((d) => d.name).join(", ");
      }
    };
    const data: MemberListData = {
      asOf,
      columns: params.columns,
      includeLeft: params.includeLeft,
      total,
      truncated: total > MEMBER_LIST_MAX_ROWS,
      rows: rows.slice(0, MEMBER_LIST_MAX_ROWS).map((m) => params.columns.map((col) => cell(m, col))),
    };
    return { data, title: `Mitgliederliste ${dateDe(asOf)}`, filename: `mitgliederliste-${asOf}.pdf` };
  },
  layout: (built) => {
    const d = built.data as MemberListData;
    const wide = d.columns.length > 4;
    return {
      format: "a4" as const,
      landscape: wide,
      title: built.title,
      blocks: [
        { type: "heading", text: `Mitgliederliste, Stand ${dateDe(d.asOf)}` },
        { type: "paragraph", text: `${d.total} ${d.total === 1 ? "Eintrag" : "Einträge"}${d.includeLeft ? " (inklusive ausgetretener Mitglieder)" : ""}. Vertraulich: enthält personenbezogene Daten, nur für den Vereinsgebrauch.${d.truncated ? ` Die Liste wurde auf ${MEMBER_LIST_MAX_ROWS} Einträge gekürzt.` : ""}` },
        { type: "table", columns: d.columns.map((c) => COLUMN_SPEC[c]), rows: d.rows },
      ],
    };
  },
});

// --- annual report -------------------------------------------------------------------------------------------------

interface AnnualData {
  year: number;
  asOf: string;
  partialYear: boolean;
  stats: ClubStats;
}

/** Members as they were on `asOf` (join and exit dates decide); the stored status of a later exit does not count as left yet. */
export function membersAsOf(members: StatsMember[], asOf: string): StatsMember[] {
  return members
    .filter((m) => m.status === "interessent" || m.joinedAt <= asOf)
    .map((m) => (m.leftAt !== null && m.leftAt > asOf ? { ...m, status: "aktiv", leftAt: null } : m));
}

export const jahresberichtTemplate = defineTemplate({
  id: "jahresbericht",
  version: 1,
  label: "Jahresbericht Mitglieder",
  description: "Mitgliederzahlen eines Jahres: Bestand, Zu- und Abgänge je Monat, Verteilung nach Kategorie, Abteilung und Altersgruppe. Nur Zahlen, keine Namen.",
  destination: "archive",
  permission: "documents:generate",
  docType: "jahresbericht",
  sensitive: true,
  folder: { systemKey: "berichte", name: "Berichte" },
  sync: true,
  paramsSchema: z.object({ year: z.number().int().min(2000).max(2200).optional() }).strict(),
  authorize: async (actor, params) => {
    if (actor.isGuest || !hasClubPermission(actor.roleTypes, "club_stats:read")) throw new ForbiddenError("Missing club_stats:read permission");
    if (params.year !== undefined && params.year > Number(todayBerlin().slice(0, 4))) throw new ConflictError("The year must not be in the future", { details: { code: "year_in_future" } });
  },
  build: async (clubId, params) => {
    const today = todayBerlin();
    const year = params.year ?? Number(today.slice(0, 4));
    const yearEnd = `${year}-12-31`;
    const asOf = yearEnd > today ? today : yearEnd;
    const input = await loadClubStatsInput(clubId);
    const stats = computeClubStats({ ...input, members: membersAsOf(input.members, asOf) }, asOf);
    const data: AnnualData = { year, asOf, partialYear: asOf !== yearEnd, stats };
    return { data, title: `Jahresbericht Mitglieder ${year}`, filename: `jahresbericht-mitglieder-${year}.pdf` };
  },
  layout: (built) => {
    const d = built.data as AnnualData;
    const s = d.stats;
    const share = (n: number, total: number) => (total > 0 ? `${Math.round((n / total) * 100)} %` : "-");
    const monthLabel = (m: string) => `${m.slice(5)}/${m.slice(0, 4)}`;
    const joined = s.movement.reduce((sum, m) => sum + m.joined, 0);
    const left = s.movement.reduce((sum, m) => sum + m.left, 0);
    return {
      format: "a4" as const,
      title: built.title,
      blocks: [
        { type: "heading", text: `Jahresbericht Mitglieder ${d.year}` },
        { type: "paragraph", text: `Stand ${dateDe(d.asOf)}${d.partialYear ? " (laufendes Jahr, noch nicht abgeschlossen)" : ""}. Der Bestand wird aus Eintritts- und Austrittsdatum berechnet; Kategorie und Abteilung entsprechen dem heutigen Stand.` },
        { type: "heading", text: "Kennzahlen", level: 2 },
        { type: "keyValue", rows: [["Mitglieder", String(s.members.total)], ["davon mit Konto", String(s.members.withAccount)], ["davon ohne Konto", String(s.members.withoutAccount)], ["Zugänge in den letzten 12 Monaten", String(joined)], ["Abgänge in den letzten 12 Monaten", String(left)]] },
        { type: "heading", text: "Zu- und Abgänge je Monat", level: 2 },
        { type: "table", columns: [{ title: "Monat", width: 2 }, { title: "Zugänge", width: 1 }, { title: "Abgänge", width: 1 }], rows: s.movement.map((m) => [monthLabel(m.month), String(m.joined), String(m.left)]) },
        { type: "heading", text: "Nach Kategorie", level: 2 },
        { type: "table", columns: [{ title: "Kategorie", width: 3 }, { title: "Mitglieder", width: 1 }, { title: "Anteil", width: 1 }], rows: s.byCategory.map((c) => [c.name, String(c.count), share(c.count, s.members.total)]) },
        { type: "heading", text: "Nach Abteilung", level: 2 },
        s.byDepartment.length > 0
          ? { type: "table", columns: [{ title: "Abteilung", width: 3 }, { title: "Mitglieder", width: 1 }, { title: "Anteil", width: 1 }], rows: s.byDepartment.map((x) => [x.name, String(x.count), share(x.count, s.members.total)]) }
          : { type: "paragraph", text: "Der Verein hat keine Abteilungen." },
        { type: "heading", text: "Altersstruktur", level: 2 },
        { type: "table", columns: [{ title: "Alter", width: 2 }, { title: "Mitglieder", width: 1 }, { title: "Anteil", width: 1 }], rows: [...s.ageBuckets.map((b) => [b.label, String(b.count), share(b.count, s.members.total)]), ...(s.ageUnknown > 0 ? [["unbekannt", String(s.ageUnknown), share(s.ageUnknown, s.members.total)]] : [])] },
      ],
    };
  },
});
