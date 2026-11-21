import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { db } from "../db/client.js";
import { clubMembers } from "../db/schema/club-members.js";
import { memberFieldDefinitions, memberFieldValues } from "../db/schema/forms.js";
import { AGE_MODES, computeAssociationReport, DEFAULT_AGE_BANDS, DEFAULT_COLUMNS, normalizeGender, REPORT_COLUMNS, reportToCsvTable, UNKNOWN } from "../lib/association-report.js";
import { writeAudit } from "../lib/audit.js";
import { computeClubStats } from "../lib/club-stats.js";
import { loadClubStatsInput } from "../lib/club-stats-load.js";
import { hasClubPermission } from "../lib/club-permissions.js";
import { ForbiddenError, ValidationError } from "../lib/errors.js";
import { buildCsv, isRealIsoDate } from "../lib/member-csv.js";
import { todayBerlin } from "../lib/member-lifecycle.js";
import { clubGuard, type ClubEnv } from "../middleware/club-guard.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { sessionGuard } from "../middleware/session-guard.js";

export const clubStatsRoutes = new Hono<ClubEnv>();

clubStatsRoutes.use("*", rateLimit({ windowMs: 60_000, max: 30 }));
clubStatsRoutes.use("*", sessionGuard);
clubStatsRoutes.use("*", clubGuard);

/**
 * Association KPIs for the board (vorsitz, stellv_vorsitz, schriftfuehrer, kassenwart, beisitzer): counts only, no
 * personal data. Rules and shape: README "Club KPIs" and `lib/club-stats.ts`.
 */
clubStatsRoutes.get("/", async (c) => {
  const clubId = c.get("clubId");
  if (!hasClubPermission(c.get("clubRoleTypes"), "club_stats:read")) throw new ForbiddenError("Missing board role for club statistics");

  const input = await loadClubStatsInput(clubId);
  return c.json({ data: computeClubStats(input, todayBerlin()) });
});

const csvList = (value: string | undefined) => (value === undefined ? [] : value.split(",").map((v) => v.trim()).filter((v) => v !== ""));

const reportQuery = z.object({
  stichtag: z.string().refine((v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && isRealIsoDate(v) && v >= "1900-01-01" && v <= "2100-12-31").optional(),
  columns: z.string().max(100).optional().transform(csvList).pipe(z.array(z.enum(REPORT_COLUMNS)).max(REPORT_COLUMNS.length)),
  ageBands: z.string().max(100).optional().transform(csvList),
  ageMode: z.enum(AGE_MODES).default("jahrgang"),
  genderField: z.string().min(1).max(100).optional(),
  format: z.enum(["json", "csv"]).default("json"),
  delimiter: z.enum([";", ","]).default(";"),
});

/** Ascending integer upper bounds (0..120, at most 10), e.g. `6,14,18`; anything else is `invalid_age_bands`. */
function parseAgeBands(raw: string[]): number[] {
  if (raw.length === 0) return [...DEFAULT_AGE_BANDS];
  const bands = raw.map((v) => (/^\d{1,3}$/.test(v) ? Number(v) : NaN));
  const ok = raw.length <= 10 && bands.every((n, i) => Number.isInteger(n) && n >= 0 && n <= 120 && (i === 0 || n > bands[i - 1]!));
  if (!ok) throw new ValidationError("Age bands must be ascending whole numbers", { details: { code: "invalid_age_bands" } });
  return bands;
}

/** Gender value per club member from a select/text custom field (select values are shown by their label). */
async function loadGenders(clubId: string, key: string, canReadSensitive: boolean): Promise<Map<string, string>> {
  const [def] = await db.select().from(memberFieldDefinitions).where(and(eq(memberFieldDefinitions.clubId, clubId), eq(memberFieldDefinitions.key, key)));
  if (!def || (def.fieldType !== "select" && def.fieldType !== "text")) throw new ValidationError("Unknown gender field", { details: { code: "unknown_gender_field" } });
  if (def.sensitive && !canReadSensitive) throw new ForbiddenError("Sensitive field needs permission to read sensitive member data");
  const labels = new Map<string, string>();
  if (def.fieldType === "select" && Array.isArray(def.options)) for (const o of def.options as Array<{ value: string; label?: string }>) labels.set(o.value, o.label ?? o.value);
  const rows = await db
    .select({ clubMemberId: memberFieldValues.clubMemberId, value: memberFieldValues.value })
    .from(memberFieldValues)
    .innerJoin(clubMembers, eq(clubMembers.id, memberFieldValues.clubMemberId))
    .where(and(eq(memberFieldValues.fieldId, def.id), eq(clubMembers.clubId, clubId)));
  const out = new Map<string, string>();
  for (const r of rows) {
    if (typeof r.value !== "string") continue;
    const text = normalizeGender(labels.get(r.value) ?? r.value);
    if (text !== UNKNOWN) out.set(r.clubMemberId, text);
  }
  return out;
}

/**
 * Association report (Wave 15 B6, Verbandsmeldung): member counts on a reference day by department, age group, gender and
 * category as JSON preview or CSV. Counts only, no names. A gender column from a sensitive custom field additionally needs
 * `members:read_sensitive`. Rules: README "Association report" and `lib/association-report.ts`.
 */
clubStatsRoutes.get("/association-report", rateLimit({ windowMs: 60_000, max: 10, key: (c) => `association-report:${c.get("user").id}` }), async (c) => {
  const clubId = c.get("clubId");
  const roleTypes = c.get("clubRoleTypes");
  if (!hasClubPermission(roleTypes, "club_stats:read")) throw new ForbiddenError("Missing board role for club statistics");

  const parsed = reportQuery.safeParse(c.req.query());
  if (!parsed.success) throw new ValidationError("Invalid request", { details: parsed.error.issues });
  const q = parsed.data;
  const columns = q.columns.length > 0 ? q.columns : [...DEFAULT_COLUMNS];
  const ageBands = parseAgeBands(q.ageBands);
  const stichtag = q.stichtag ?? todayBerlin();

  let genders: Map<string, string> | undefined;
  if (columns.includes("gender")) {
    if (!q.genderField) throw new ValidationError("A gender field is required for the gender column", { details: { code: "gender_field_required" } });
    genders = await loadGenders(clubId, q.genderField, hasClubPermission(roleTypes, "members:read_sensitive"));
  }

  const report = computeAssociationReport(await loadClubStatsInput(clubId), { stichtag, columns, ageBands, ageMode: q.ageMode, ...(genders ? { genders } : {}) });
  c.header("Cache-Control", "private, no-store");
  if (q.format === "json") return c.json({ data: report });

  const table = reportToCsvTable(report);
  await writeAudit(db, { eventType: "association_report.export", actorUserId: c.get("user").id, clubId, payload: { clubId, stichtag, columns: report.columns.join(","), rows: report.rows.length } });
  c.header("Content-Type", "text/csv; charset=utf-8");
  c.header("Content-Disposition", `attachment; filename="verbandsmeldung-${stichtag}.csv"`);
  c.header("X-Content-Type-Options", "nosniff");
  return c.body(buildCsv(table.header, table.rows, q.delimiter));
});
