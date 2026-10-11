import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { and, eq, isNotNull } from "drizzle-orm";

import { member, user } from "../auth/auth-schema.js";
import { clubMembers, memberCategories, type MemberCategoryRow } from "../db/schema/club-members.js";
import { DEFAULT_CATEGORY_KEY, type DbExecutor } from "./club-members.js";
import { ValidationError } from "./errors.js";
import {
  CsvParseError,
  detectDelimiter,
  importMaxBytes,
  importMaxRows,
  normalizeHeader,
  parseCsv,
  parseFlexibleDate,
  unescapeFormula,
  type CsvDelimiter,
} from "./member-csv.js";
import { todayBerlin } from "./member-lifecycle.js";

/**
 * Member CSV import (Wave 7 B10): column mapping, per-row validation and duplicate detection (dry-run report), plus the
 * stateless confirmation token that ties a commit to the exact file that was checked. No database writes here.
 */

/** Fields a CSV column can map to (= the keys of the export, except the read-only `departments`/`accountEmail`/`leftAt`). */
export const IMPORT_FIELDS = [
  "memberNumber",
  "displayName",
  "firstName",
  "lastName",
  "birthDate",
  "category",
  "status",
  "joinedAt",
  "street",
  "postalCode",
  "city",
  "phone",
  "contactEmail",
  "emergencyContactName",
  "emergencyContactPhone",
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

/** German headers of the downloadable template / export (also accepted on import). */
export const IMPORT_TEMPLATE_HEADERS: Record<ImportField, string> = {
  memberNumber: "Mitgliedsnummer",
  displayName: "Name",
  firstName: "Vorname",
  lastName: "Nachname",
  birthDate: "Geburtsdatum",
  category: "Kategorie",
  status: "Status",
  joinedAt: "Eintrittsdatum",
  street: "Straße",
  postalCode: "PLZ",
  city: "Ort",
  phone: "Telefon",
  contactEmail: "E-Mail",
  emergencyContactName: "Notfallkontakt",
  emergencyContactPhone: "Notfalltelefon",
};

/** Accepted header spellings (normalised via `normalizeHeader`) per field. */
const HEADER_ALIASES: Record<ImportField, string[]> = {
  memberNumber: ["mitgliedsnummer", "mitgliedsnr", "mitgliednr", "mitgliedsno", "nummer", "membernumber", "memberno", "number"],
  displayName: ["name", "anzeigename", "vollername", "displayname", "fullname", "mitglied"],
  firstName: ["vorname", "firstname", "givenname"],
  lastName: ["nachname", "familienname", "lastname", "surname"],
  birthDate: ["geburtsdatum", "geburtstag", "geboren", "birthdate", "birthday", "dateofbirth", "dob"],
  category: ["kategorie", "mitgliedsart", "mitgliedschaftsart", "beitragsart", "category", "categorykey"],
  status: ["status", "mitgliedsstatus"],
  joinedAt: ["eintrittsdatum", "eintritt", "eintrittam", "beitritt", "beitrittsdatum", "joinedat", "joindate", "joined"],
  street: ["strasse", "strassehausnummer", "adresse", "street", "address"],
  postalCode: ["plz", "postleitzahl", "postalcode", "zip", "zipcode"],
  city: ["ort", "stadt", "wohnort", "city"],
  phone: ["telefon", "telefonnummer", "tel", "handy", "mobil", "phone", "mobile"],
  contactEmail: ["email", "emailadresse", "mail", "contactemail", "kontaktemail"],
  emergencyContactName: ["notfallkontakt", "notfallkontaktname", "notfallperson", "emergencycontact", "emergencycontactname"],
  emergencyContactPhone: ["notfalltelefon", "notfallkontakttelefon", "notfallnummer", "emergencycontactphone", "emergencyphone"],
};

/** Statuses an import may set (leaving the club goes through the exit workflow, like `POST /club-members`). */
export const IMPORT_STATUSES = ["interessent", "probe", "aktiv", "ruhend"] as const;

const MAX_COLUMNS = 60;
const MAX_CELL = 500;
const LIMITS: Partial<Record<ImportField, number>> = {
  memberNumber: 50,
  displayName: 200,
  firstName: 100,
  lastName: 100,
  street: 200,
  postalCode: 20,
  city: 120,
  phone: 50,
  contactEmail: 320,
  emergencyContactName: 200,
  emergencyContactPhone: 50,
};

export interface RowIssue {
  field: ImportField | null;
  code: "required" | "invalid_date" | "invalid_category" | "invalid_status" | "invalid_email" | "too_long" | "invalid_value" | "member_number_taken" | "member_number_duplicate_in_file";
  message: string;
}

export interface DuplicateInfo {
  reason: "name_birthdate" | "email";
  /** Existing member of the club, or null when the earlier occurrence is in the same file. */
  clubMemberId: string | null;
  /** 1-based line of the earlier occurrence in the file (in-file duplicates only). */
  line: number | null;
}

export interface ImportRowReport {
  /** 1-based line in the file (header = line 1). */
  line: number;
  status: "ok" | "duplicate" | "error";
  issues: RowIssue[];
  duplicates: DuplicateInfo[];
}

export interface ValidImportRow {
  line: number;
  values: {
    memberNumber: string | null;
    displayName: string;
    firstName: string | null;
    lastName: string | null;
    birthDate: string | null;
    categoryId: string;
    status: (typeof IMPORT_STATUSES)[number];
    joinedAt: string;
    street: string | null;
    postalCode: string | null;
    city: string | null;
    phone: string | null;
    contactEmail: string | null;
    emergencyContactName: string | null;
    emergencyContactPhone: string | null;
  };
}

export interface ImportAnalysis {
  delimiter: CsvDelimiter;
  /** Header (as in the file) -> field it was mapped to. */
  columns: Array<{ header: string; field: ImportField | null }>;
  rows: ImportRowReport[];
  valid: ValidImportRow[];
  summary: { rows: number; ok: number; duplicates: number; errors: number };
}

export interface ImportOptions {
  /** Explicit column mapping: header text as in the file -> field (or "ignore"). Overrides the automatic header detection. */
  mapping?: Record<string, ImportField | "ignore">;
  /** Category used for rows without a category value (default "aktiv"). */
  defaultCategoryKey?: string;
}

const squash = (v: string) => v.trim().replace(/\s+/g, " ");
const nameKey = (v: string) => squash(v).toLowerCase();
const controlChars = (v: string) => [...v].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Maps the header row to fields (explicit mapping first, then aliases); a field is only mapped once (first column wins). */
export function mapColumns(headers: string[], mapping?: ImportOptions["mapping"]): ImportAnalysis["columns"] {
  const aliasToField = new Map<string, ImportField>();
  for (const field of IMPORT_FIELDS) {
    aliasToField.set(normalizeHeader(IMPORT_TEMPLATE_HEADERS[field]), field);
    aliasToField.set(normalizeHeader(field), field);
    for (const alias of HEADER_ALIASES[field]) aliasToField.set(normalizeHeader(alias), field);
  }
  const used = new Set<ImportField>();
  return headers.map((header) => {
    const explicit = mapping?.[header];
    const field = explicit !== undefined ? (explicit === "ignore" ? null : explicit) : (aliasToField.get(normalizeHeader(header)) ?? null);
    if (field === null || used.has(field)) return { header, field: null };
    used.add(field);
    return { header, field };
  });
}

/**
 * Parses and checks a CSV file against the club's current data. Throws a 422 for file-level problems (too large, too many
 * rows, unparseable, no usable header / no name column); everything row-level ends up in the report. Row-level messages
 * never echo cell values (the report may be logged or screenshotted by clients).
 */
export async function analyzeImport(executor: DbExecutor, clubId: string, csv: string, options: ImportOptions = {}): Promise<ImportAnalysis> {
  if (Buffer.byteLength(csv, "utf8") > importMaxBytes()) throw new ValidationError(`CSV exceeds the maximum size of ${importMaxBytes()} bytes`, { details: { code: "csv_too_large" } });

  const delimiter = detectDelimiter(csv);
  let table: string[][];
  try {
    table = parseCsv(csv, delimiter);
  } catch (err) {
    if (err instanceof CsvParseError) throw new ValidationError("The CSV file is malformed (unterminated quote)", { details: { code: "csv_malformed" } });
    throw err;
  }
  if (table.length === 0) throw new ValidationError("The CSV file is empty", { details: { code: "csv_empty" } });
  const [headerRow, ...dataRows] = table as [string[], ...string[][]];
  if (headerRow.length > MAX_COLUMNS) throw new ValidationError(`The CSV file has more than ${MAX_COLUMNS} columns`, { details: { code: "csv_too_many_columns" } });
  if (dataRows.length === 0) throw new ValidationError("The CSV file contains no data rows", { details: { code: "csv_empty" } });
  if (dataRows.length > importMaxRows()) throw new ValidationError(`The CSV file has more than ${importMaxRows()} data rows`, { details: { code: "csv_too_many_rows", maxRows: importMaxRows() } });

  const columns = mapColumns(headerRow.map((h) => h.trim()), options.mapping);
  const mapped = new Set(columns.map((c) => c.field));
  if (!mapped.has("displayName") && !(mapped.has("firstName") && mapped.has("lastName"))) {
    throw new ValidationError("No name column found: the file needs 'Name' or both 'Vorname' and 'Nachname'", { details: { code: "csv_missing_name_column", columns } });
  }

  // Club state the rows are checked against.
  const categoryRows = await executor.select().from(memberCategories).where(eq(memberCategories.clubId, clubId));
  const categories = new Map<string, MemberCategoryRow>();
  for (const c of categoryRows) {
    if (c.archivedAt) continue;
    categories.set(c.key.toLowerCase(), c);
    categories.set(nameKey(c.name), c);
  }
  const defaultKey = (options.defaultCategoryKey ?? DEFAULT_CATEGORY_KEY).trim().toLowerCase();
  const defaultCategory = categories.get(defaultKey);

  const existing = await executor
    .select({ id: clubMembers.id, displayName: clubMembers.displayName, birthDate: clubMembers.birthDate, contactEmail: clubMembers.contactEmail, memberNumber: clubMembers.memberNumber })
    .from(clubMembers)
    .where(eq(clubMembers.clubId, clubId));
  const accountEmails = await executor
    .select({ clubMemberId: clubMembers.id, email: user.email })
    .from(clubMembers)
    .innerJoin(member, eq(member.id, clubMembers.memberId))
    .innerJoin(user, eq(user.id, member.userId))
    .where(and(eq(clubMembers.clubId, clubId), isNotNull(clubMembers.memberId)));

  const byNameBirth = new Map<string, string>();
  const byEmail = new Map<string, string>();
  const numbers = new Set<string>();
  for (const e of existing) {
    if (e.birthDate) byNameBirth.set(`${nameKey(e.displayName)}|${e.birthDate}`, e.id);
    if (e.contactEmail) byEmail.set(e.contactEmail.trim().toLowerCase(), e.id);
    if (e.memberNumber) numbers.add(e.memberNumber);
  }
  for (const a of accountEmails) byEmail.set(a.email.trim().toLowerCase(), a.clubMemberId);

  const today = todayBerlin();
  const seenNameBirth = new Map<string, number>();
  const seenEmail = new Map<string, number>();
  const seenNumbers = new Map<string, number>();

  const rows: ImportRowReport[] = [];
  const valid: ValidImportRow[] = [];

  dataRows.forEach((cells, index) => {
    const line = index + 2;
    const issues: RowIssue[] = [];
    const raw: Partial<Record<ImportField, string>> = {};
    columns.forEach((col, i) => {
      if (!col.field) return;
      const cell = unescapeFormula(cells[i] ?? "").trim();
      if (cell !== "") raw[col.field] = cell;
    });
    const issue = (field: ImportField | null, code: RowIssue["code"], message: string) => issues.push({ field, code, message });

    for (const [field, value] of Object.entries(raw) as Array<[ImportField, string]>) {
      if (value.length > (LIMITS[field] ?? MAX_CELL)) issue(field, "too_long", `Value is longer than ${LIMITS[field] ?? MAX_CELL} characters`);
      else if (controlChars(value)) issue(field, "invalid_value", "Value contains control characters");
    }

    const displayName = squash(raw.displayName ?? [raw.firstName, raw.lastName].filter(Boolean).join(" "));
    if (displayName === "") issue("displayName", "required", "Name is required (Name, or Vorname and Nachname)");

    let birthDate: string | null = null;
    if (raw.birthDate) {
      birthDate = parseFlexibleDate(raw.birthDate);
      if (!birthDate) issue("birthDate", "invalid_date", "Not a valid date (use YYYY-MM-DD or DD.MM.YYYY)");
      else if (birthDate > today || birthDate < "1900-01-01") issue("birthDate", "invalid_date", "Birth date is out of range");
    }
    let joinedAt = today;
    if (raw.joinedAt) {
      const parsed = parseFlexibleDate(raw.joinedAt);
      if (!parsed) issue("joinedAt", "invalid_date", "Not a valid date (use YYYY-MM-DD or DD.MM.YYYY)");
      else joinedAt = parsed;
    }

    let category: MemberCategoryRow | undefined;
    if (raw.category) {
      category = categories.get(nameKey(raw.category));
      if (!category) issue("category", "invalid_category", "Unknown or archived category (key or name of a category of this club)");
    } else {
      category = defaultCategory;
      if (!category) issue("category", "invalid_category", "No category given and the default category does not exist");
    }

    let status: (typeof IMPORT_STATUSES)[number] = "aktiv";
    if (raw.status) {
      const s = raw.status.trim().toLowerCase();
      if ((IMPORT_STATUSES as readonly string[]).includes(s)) status = s as (typeof IMPORT_STATUSES)[number];
      else issue("status", "invalid_status", `Status must be one of ${IMPORT_STATUSES.join(", ")} (leaving the club is not an import)`);
    }

    const email = raw.contactEmail?.toLowerCase();
    if (raw.contactEmail && !EMAIL_RE.test(raw.contactEmail)) issue("contactEmail", "invalid_email", "Not a valid e-mail address");

    if (raw.memberNumber) {
      if (numbers.has(raw.memberNumber)) issue("memberNumber", "member_number_taken", "Member number is already in use in this club");
      else if (seenNumbers.has(raw.memberNumber)) issue("memberNumber", "member_number_duplicate_in_file", "Member number appears more than once in the file");
    }

    const duplicates: DuplicateInfo[] = [];
    if (issues.length === 0) {
      if (birthDate) {
        const key = `${nameKey(displayName)}|${birthDate}`;
        const existingId = byNameBirth.get(key);
        const earlier = seenNameBirth.get(key);
        if (existingId) duplicates.push({ reason: "name_birthdate", clubMemberId: existingId, line: null });
        else if (earlier !== undefined) duplicates.push({ reason: "name_birthdate", clubMemberId: null, line: earlier });
      }
      if (email && EMAIL_RE.test(email)) {
        const existingId = byEmail.get(email);
        const earlier = seenEmail.get(email);
        if (existingId) duplicates.push({ reason: "email", clubMemberId: existingId, line: null });
        else if (earlier !== undefined) duplicates.push({ reason: "email", clubMemberId: null, line: earlier });
      }
    }

    if (issues.length > 0) {
      rows.push({ line, status: "error", issues, duplicates: [] });
      return;
    }
    if (duplicates.length > 0) {
      rows.push({ line, status: "duplicate", issues: [], duplicates });
      return;
    }

    // Only rows that will really be created reserve their identifying values (a skipped duplicate must not hide the next row).
    if (birthDate) seenNameBirth.set(`${nameKey(displayName)}|${birthDate}`, line);
    if (email) seenEmail.set(email, line);
    if (raw.memberNumber) seenNumbers.set(raw.memberNumber, line);
    rows.push({ line, status: "ok", issues: [], duplicates: [] });
    valid.push({
      line,
      values: {
        memberNumber: raw.memberNumber ?? null,
        displayName,
        firstName: raw.firstName ? squash(raw.firstName) : null,
        lastName: raw.lastName ? squash(raw.lastName) : null,
        birthDate,
        categoryId: category!.id,
        status,
        joinedAt,
        street: raw.street ?? null,
        postalCode: raw.postalCode ?? null,
        city: raw.city ?? null,
        phone: raw.phone ?? null,
        contactEmail: raw.contactEmail ?? null,
        emergencyContactName: raw.emergencyContactName ?? null,
        emergencyContactPhone: raw.emergencyContactPhone ?? null,
      },
    });
  });

  const summary = {
    rows: rows.length,
    ok: rows.filter((r) => r.status === "ok").length,
    duplicates: rows.filter((r) => r.status === "duplicate").length,
    errors: rows.filter((r) => r.status === "error").length,
  };
  return { delimiter, columns, rows, valid, summary };
}

// --- Confirmation token ---------------------------------------------------------------------------------------

const TOKEN_TTL_MS = 30 * 60 * 1000;

function tokenSecret(): string {
  const value = process.env.BETTER_AUTH_SECRET;
  if (!value) throw new Error("BETTER_AUTH_SECRET must be set to sign import confirmation tokens");
  return value;
}

/** Fingerprint of everything that influences the result of an import: file content, mapping and default category. */
export function importFingerprint(csv: string, options: ImportOptions): string {
  return createHash("sha256")
    .update(JSON.stringify([csv, Object.entries(options.mapping ?? {}).sort(([a], [b]) => a.localeCompare(b)), (options.defaultCategoryKey ?? "").trim().toLowerCase()]))
    .digest("hex");
}

const tokenSignature = (payload: string) => createHmac("sha256", tokenSecret()).update(`member-import:${payload}`).digest("base64url");

/** Stateless token `<payload>.<hmac>` binding club + user + file fingerprint + expiry; issued by the dry run, required by the commit. */
export function createImportToken(clubId: string, userId: string, fingerprint: string, now = Date.now()): { token: string; expiresAt: Date } {
  const expiresAtMs = now + TOKEN_TTL_MS;
  const payload = Buffer.from(JSON.stringify({ c: clubId, u: userId, f: fingerprint, e: expiresAtMs })).toString("base64url");
  return { token: `${payload}.${tokenSignature(payload)}`, expiresAt: new Date(expiresAtMs) };
}

/** True if the token was issued for exactly this club, user and file and has not expired. Never throws on garbage. */
export function verifyImportToken(token: string, clubId: string, userId: string, fingerprint: string, now = Date.now()): boolean {
  const [payload, signature, ...rest] = token.split(".");
  if (!payload || !signature || rest.length > 0) return false;
  const expected = Buffer.from(tokenSignature(payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return false;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { c?: unknown; u?: unknown; f?: unknown; e?: unknown };
    return parsed.c === clubId && parsed.u === userId && parsed.f === fingerprint && typeof parsed.e === "number" && parsed.e >= now;
  } catch {
    return false;
  }
}
