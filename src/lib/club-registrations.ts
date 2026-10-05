import { and, eq, inArray, sql } from "drizzle-orm";
import type { Context } from "hono";

import { organization } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import {
  clubRegistrationDocuments,
  clubRegistrations,
  type ClubRegistrationDocumentRow,
  type ClubRegistrationRow,
} from "../db/schema/club-registrations.js";
import { NotFoundError } from "./errors.js";
import { getObject } from "./storage.js";

/** Shared by the applicant API (routes/club-registrations.ts) and the reviewer API (routes/admin-club-registrations.ts). */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A non-uuid id can't match a uuid column (and would make Postgres throw) -- callers treat it as unknown (404). */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export interface RegistrationDocumentDto {
  id: string;
  kind: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

export interface RegistrationDto {
  id: string;
  clubName: string;
  legalForm: string;
  registerCourt: string | null;
  registerNumber: string | null;
  street: string;
  postalCode: string;
  city: string;
  websiteUrl: string | null;
  claimedRole: string;
  status: string;
  reviewNote: string | null;
  slugSuggestion: string | null;
  clubId: string | null;
  clubSlug: string | null;
  submittedAt: Date | null;
  createdAt: Date;
  documents: RegistrationDocumentDto[];
}

export function toDocumentDto(doc: ClubRegistrationDocumentRow): RegistrationDocumentDto {
  return { id: doc.id, kind: doc.kind, filename: doc.filename, mimeType: doc.mimeType, sizeBytes: doc.sizeBytes };
}

/**
 * Shapes registrations into the API contract, loading documents and (for
 * approved ones) the club slug in two batched queries. Never exposes
 * `storage_key`, `reviewed_by` or the applicant's user id.
 */
export async function shapeRegistrations(rows: ClubRegistrationRow[]): Promise<RegistrationDto[]> {
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const clubIds = rows.filter((r) => r.status === "approved" && r.clubId).map((r) => r.clubId!);

  const [docs, orgs] = await Promise.all([
    db.select().from(clubRegistrationDocuments).where(inArray(clubRegistrationDocuments.registrationId, ids)).orderBy(clubRegistrationDocuments.createdAt, clubRegistrationDocuments.id),
    clubIds.length > 0 ? db.select({ id: organization.id, slug: organization.slug }).from(organization).where(inArray(organization.id, clubIds)) : Promise.resolve([]),
  ]);

  const slugByClub = new Map(orgs.map((o) => [o.id, o.slug]));
  return rows.map((r) => ({
    id: r.id,
    clubName: r.clubName,
    legalForm: r.legalForm,
    registerCourt: r.registerCourt,
    registerNumber: r.registerNumber,
    street: r.street,
    postalCode: r.postalCode,
    city: r.city,
    websiteUrl: r.websiteUrl,
    claimedRole: r.claimedRole,
    status: r.status,
    reviewNote: r.reviewNote,
    slugSuggestion: r.slugSuggestion,
    clubId: r.clubId,
    clubSlug: r.status === "approved" && r.clubId ? (slugByClub.get(r.clubId) ?? null) : null,
    submittedAt: r.submittedAt,
    createdAt: r.createdAt,
    documents: docs.filter((d) => d.registrationId === r.id).map(toDocumentDto),
  }));
}

export async function shapeRegistration(row: ClubRegistrationRow): Promise<RegistrationDto> {
  return (await shapeRegistrations([row]))[0]!;
}

/** Register court + number reduced to a comparable key (case/whitespace-insensitive), or null if either is missing. */
export function registerKey(court: string | null | undefined, number: string | null | undefined): { court: string; number: string } | null {
  const c = (court ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  const n = (number ?? "").replace(/\s+/g, "").toLowerCase();
  return c && n ? { court: c, number: n } : null;
}

/** SQL fragment matching `registerKey` on the stored columns. */
export function registerKeyMatches(key: { court: string; number: string }) {
  return and(
    sql`lower(regexp_replace(trim(${clubRegistrations.registerCourt}), '\\s+', ' ', 'g')) = ${key.court}`,
    sql`lower(regexp_replace(${clubRegistrations.registerNumber}, '\\s+', '', 'g')) = ${key.number}`,
  );
}

export async function findDocument(registrationId: string, docId: string): Promise<ClubRegistrationDocumentRow> {
  if (!isUuid(docId)) throw new NotFoundError("Document not found");
  const doc = await db.query.clubRegistrationDocuments.findFirst({
    where: and(eq(clubRegistrationDocuments.id, docId), eq(clubRegistrationDocuments.registrationId, registrationId)),
  });
  if (!doc) throw new NotFoundError("Document not found");
  return doc;
}

/** Streams a stored proof document as an attachment. The content type comes from our own allowlist, never from the filename. */
export async function documentResponse(c: Context, doc: ClubRegistrationDocumentRow): Promise<Response> {
  let buffer: Buffer;
  try {
    buffer = await getObject(doc.storageKey);
  } catch {
    throw new NotFoundError("Document not found");
  }
  const asciiName = doc.filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  c.header("Content-Type", doc.mimeType);
  c.header("Content-Disposition", `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(doc.filename)}`);
  c.header("Cache-Control", "private, no-store");
  c.header("X-Content-Type-Options", "nosniff");
  return c.body(new Uint8Array(buffer));
}
