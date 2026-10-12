import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";

import { db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import {
  CLAIMABLE_ROLES,
  CLUB_LEGAL_FORMS,
  clubRegistrationDocuments,
  clubRegistrations,
  REGISTRATION_DOCUMENT_KINDS,
  type ClubRegistrationRow,
  type RegistrationDocumentKind,
} from "../db/schema/club-registrations.js";
import { slugifyClubName, uniqueClubSlug } from "../lib/club-slug.js";
import { inBackground, sendRegistrationReceivedMail, sendRegistrationReviewNotifyMail } from "../lib/club-registration-mail.js";
import {
  documentResponse,
  findDocument,
  isUuid,
  recordAdminDocumentAccess,
  registerKey,
  registerKeyMatches,
  shapeRegistration,
  shapeRegistrations,
  toDocumentDto,
} from "../lib/club-registrations.js";
import { ConflictError, ForbiddenError, isUniqueViolation, NotFoundError, ValidationError } from "../lib/errors.js";
import { discardStoredFile, markMediaDeleted, MAX_DOCUMENT_BYTES, purgeMediaFile, storeUpload } from "../lib/media.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { sessionGuard, type SessionEnv } from "../middleware/session-guard.js";

/**
 * Applicant side of "Verein gruenden" (Wave 6). Session-only (no clubGuard --
 * the applicant has no club yet) and requires a verified e-mail address. A
 * registration is private to its applicant: someone else's id is always 404.
 * The club itself only comes into existence when a platform admin approves
 * (see admin-club-registrations.ts).
 */
export const clubRegistrationRoutes = new Hono<SessionEnv>();

export const MAX_DOCUMENTS_PER_REGISTRATION = 5;
/** Proof documents: PDF, JPEG, PNG (magic bytes, size, metadata strip and registry: central media layer, `src/lib/media.ts`). */
const PROOF_TYPES = ["application/pdf", "image/jpeg", "image/png"] as const;

/** Proofs that count towards E2 per legal form. `sonstiges` alone never suffices. */
const QUALIFYING_KINDS: Record<string, RegistrationDocumentKind[]> = {
  e_v: ["registerauszug", "satzung", "freistellungsbescheid", "gruendungsprotokoll"],
  nicht_eingetragen: ["satzung", "gruendungsprotokoll"],
  sonstige: ["registerauszug", "satzung", "freistellungsbescheid", "gruendungsprotokoll"],
};

clubRegistrationRoutes.use("*", rateLimit({ windowMs: 60_000, max: 60 }));
clubRegistrationRoutes.use("*", sessionGuard);
clubRegistrationRoutes.use("*", async (c, next) => {
  if (!c.get("user").emailVerified) throw new ForbiddenError("A verified email address is required to register a club");
  await next();
});

// Per-user (not per-IP) limits: they cap mail flooding through needs_info -> submit cycles and upload/delete churn,
// and can't be dodged by rotating the client IP header. Each limiter instance has its own buckets.
const perUser = (c: { get: (k: "user") => { id: string } }) => `user:${c.get("user").id}`;
const submitLimiter = rateLimit({ windowMs: 24 * 60 * 60_000, max: 5, key: perUser });
const documentLimiter = rateLimit({ windowMs: 60 * 60_000, max: 30, key: perUser }); // shared by upload + delete
/** Reviewers are mailed at most once per registration within this window, however often it is resubmitted. */
const REVIEWER_MAIL_THROTTLE_MS = 60 * 60_000;

// --- validation --------------------------------------------------------

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === "" ? null : v))
    .nullish();

const websiteUrl = z
  .string()
  .trim()
  .max(300)
  .transform((v) => (v === "" ? null : v))
  .refine((v) => {
    if (v === null) return true;
    try {
      const u = new URL(v);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch {
      return false;
    }
  }, "websiteUrl must be an http(s) URL")
  .nullish();

const fields = {
  clubName: z.string().trim().min(2).max(120),
  legalForm: z.enum(CLUB_LEGAL_FORMS),
  registerCourt: optionalText(120),
  registerNumber: optionalText(60),
  street: z.string().trim().min(1).max(200),
  postalCode: z.string().trim().min(3).max(12),
  city: z.string().trim().min(1).max(120),
  websiteUrl,
  claimedRole: z.enum(CLAIMABLE_ROLES),
};

const createSchema = z.object({ ...fields, claimedRole: fields.claimedRole.default("vorsitz") });
const patchSchema = z.object(fields).partial();

const validationHook = (result: { success: boolean; error?: { issues: unknown } }) => {
  if (!result.success) throw new ValidationError("Invalid request body", { details: result.error?.issues });
};

/** `e_v` needs Registergericht + Registernummer. */
function assertRegisterFields(legalForm: string, court: string | null | undefined, number: string | null | undefined) {
  if (legalForm === "e_v" && (!court || !number)) {
    throw new ValidationError("registerCourt and registerNumber are required for legalForm e_v");
  }
}

// --- helpers -----------------------------------------------------------

async function loadOwn(id: string, userId: string): Promise<ClubRegistrationRow> {
  if (!isUuid(id)) throw new NotFoundError("Registration not found");
  const row = await db.query.clubRegistrations.findFirst({
    where: and(eq(clubRegistrations.id, id), eq(clubRegistrations.userId, userId)),
  });
  if (!row) throw new NotFoundError("Registration not found");
  return row;
}

function assertEditable(row: ClubRegistrationRow) {
  if (row.status !== "draft" && row.status !== "needs_info") {
    throw new ConflictError("Registration can only be changed while it is a draft or needs more information");
  }
}

// --- routes ------------------------------------------------------------

// Strict creation limit (abuse protection): 10 registrations per hour per client.
clubRegistrationRoutes.post(
  "/",
  rateLimit({ windowMs: 60 * 60_000, max: 10 }),
  zValidator("json", createSchema, validationHook),
  async (c) => {
    const currentUser = c.get("user");
    const body = c.req.valid("json");
    assertRegisterFields(body.legalForm, body.registerCourt, body.registerNumber);

    let row: ClubRegistrationRow;
    try {
      row = await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(clubRegistrations)
          .values({
            userId: currentUser.id,
            clubName: body.clubName,
            legalForm: body.legalForm,
            registerCourt: body.registerCourt ?? null,
            registerNumber: body.registerNumber ?? null,
            street: body.street,
            postalCode: body.postalCode,
            city: body.city,
            websiteUrl: body.websiteUrl ?? null,
            claimedRole: body.claimedRole,
          })
          .returning();
        await tx.insert(auditLog).values({
          eventType: "club_registration.create",
          subjectId: created.id,
          payload: { userId: currentUser.id, clubName: created.clubName },
        });
        return created;
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError("You already have an open club registration");
      throw err;
    }

    return c.json({ data: { registration: await shapeRegistration(row) } }, 201);
  },
);

// Registered before "/:id" so "mine" is not read as an id.
clubRegistrationRoutes.get("/mine", async (c) => {
  const rows = await db
    .select()
    .from(clubRegistrations)
    .where(eq(clubRegistrations.userId, c.get("user").id))
    .orderBy(desc(clubRegistrations.createdAt), desc(clubRegistrations.id));
  return c.json({ data: await shapeRegistrations(rows) });
});

clubRegistrationRoutes.get("/:id", async (c) => {
  const row = await loadOwn(c.req.param("id"), c.get("user").id);
  return c.json({ data: { registration: await shapeRegistration(row) } });
});

clubRegistrationRoutes.patch("/:id", zValidator("json", patchSchema, validationHook), async (c) => {
  const currentUser = c.get("user");
  const body = c.req.valid("json");
  const existing = await loadOwn(c.req.param("id"), currentUser.id);
  assertEditable(existing);

  const merged = {
    legalForm: body.legalForm ?? existing.legalForm,
    registerCourt: body.registerCourt !== undefined ? body.registerCourt : existing.registerCourt,
    registerNumber: body.registerNumber !== undefined ? body.registerNumber : existing.registerNumber,
  };
  assertRegisterFields(merged.legalForm, merged.registerCourt, merged.registerNumber);

  const [updated] = await db
    .update(clubRegistrations)
    .set({
      ...(body.clubName !== undefined ? { clubName: body.clubName } : {}),
      ...(body.legalForm !== undefined ? { legalForm: body.legalForm } : {}),
      ...(body.registerCourt !== undefined ? { registerCourt: body.registerCourt } : {}),
      ...(body.registerNumber !== undefined ? { registerNumber: body.registerNumber } : {}),
      ...(body.street !== undefined ? { street: body.street } : {}),
      ...(body.postalCode !== undefined ? { postalCode: body.postalCode } : {}),
      ...(body.city !== undefined ? { city: body.city } : {}),
      ...(body.websiteUrl !== undefined ? { websiteUrl: body.websiteUrl } : {}),
      ...(body.claimedRole !== undefined ? { claimedRole: body.claimedRole } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(clubRegistrations.id, existing.id), inArray(clubRegistrations.status, ["draft", "needs_info"])))
    .returning();
  if (!updated) throw new ConflictError("Registration can only be changed while it is a draft or needs more information");

  return c.json({ data: { registration: await shapeRegistration(updated) } });
});

clubRegistrationRoutes.post(
  "/:id/documents",
  documentLimiter,
  bodyLimit({
    maxSize: MAX_DOCUMENT_BYTES + 64 * 1024, // multipart framing overhead on top of the file itself
    onError: () => {
      throw new ValidationError(`File exceeds maximum size of ${MAX_DOCUMENT_BYTES} bytes`);
    },
  }),
  async (c) => {
    const registration = await loadOwn(c.req.param("id"), c.get("user").id);
    assertEditable(registration);

    const body = await c.req.parseBody();
    const file = body["file"];
    if (!(file instanceof File)) throw new ValidationError("Missing file upload (field name: file)");
    const kind = z.enum(REGISTRATION_DOCUMENT_KINDS).safeParse(body["kind"]);
    if (!kind.success) throw new ValidationError(`kind must be one of: ${REGISTRATION_DOCUMENT_KINDS.join(", ")}`);

    // Lock the registration row so parallel uploads can't exceed the per-registration cap.
    const stored: { key: string | null } = { key: null };
    try {
      const doc = await db.transaction(async (tx) => {
        const [locked] = await tx.execute<{ status: string }>(sql`SELECT status FROM club_registrations WHERE id = ${registration.id} FOR UPDATE`).then((r) => r.rows);
        if (!locked || (locked.status !== "draft" && locked.status !== "needs_info")) {
          throw new ConflictError("Registration can only be changed while it is a draft or needs more information");
        }
        const [{ count }] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(clubRegistrationDocuments)
          .where(eq(clubRegistrationDocuments.registrationId, registration.id));
        if (count >= MAX_DOCUMENTS_PER_REGISTRATION) {
          throw new ValidationError(`At most ${MAX_DOCUMENTS_PER_REGISTRATION} documents per registration`);
        }

        // Private path outside the club-scoped namespace; registered as a SENSITIVE file, so it is never reachable
        // through a signed URL, only through the audited download routes below.
        const media = await storeUpload({
          file,
          clubId: null,
          storagePrefix: `registrations/${registration.id}`,
          kind: "document",
          allowedTypes: PROOF_TYPES,
          maxBytes: MAX_DOCUMENT_BYTES,
          sensitive: true,
          owner: { type: "club_registration", id: registration.id },
          uploadedBy: registration.userId,
          executor: tx,
        });
        stored.key = media.storageKey;
        const [created] = await tx
          .insert(clubRegistrationDocuments)
          .values({ registrationId: registration.id, kind: kind.data, storageKey: media.storageKey, filename: media.originalFilename, mimeType: media.mimeType, sizeBytes: media.sizeBytes })
          .returning();
        await tx.insert(auditLog).values({
          eventType: "club_registration.document_add",
          subjectId: registration.id,
          payload: { documentId: created.id, kind: kind.data, userId: registration.userId },
        });
        return created;
      });
      return c.json({ data: { document: toDocumentDto(doc) } }, 201);
    } catch (err) {
      // The transaction rolled back (registry row included): drop the file that was already written.
      if (stored.key) await discardStoredFile(stored.key);
      throw err;
    }
  },
);

clubRegistrationRoutes.get("/:id/documents/:docId", async (c) => {
  const currentUser = c.get("user");
  const id = c.req.param("id");
  // Applicant, or a platform admin for submitted (non-draft) registrations -- consistent with /admin, where drafts
  // are 404. Everyone else gets the same 404 as for an unknown id.
  let registration = isUuid(id)
    ? await db.query.clubRegistrations.findFirst({ where: and(eq(clubRegistrations.id, id), eq(clubRegistrations.userId, currentUser.id)) })
    : undefined;
  const viaAdmin = !registration && currentUser.role === "admin" && isUuid(id);
  if (viaAdmin) {
    registration = await db.query.clubRegistrations.findFirst({ where: and(eq(clubRegistrations.id, id), ne(clubRegistrations.status, "draft")) });
  }
  if (!registration) throw new NotFoundError("Registration not found");
  const doc = await findDocument(registration.id, c.req.param("docId"));
  if (viaAdmin) await recordAdminDocumentAccess(currentUser.id, registration.id, doc);
  return documentResponse(c, doc, currentUser.id);
});

clubRegistrationRoutes.delete("/:id/documents/:docId", documentLimiter, async (c) => {
  const registration = await loadOwn(c.req.param("id"), c.get("user").id);
  assertEditable(registration);
  const doc = await findDocument(registration.id, c.req.param("docId"));

  await db.transaction(async (tx) => {
    // Same lock as submit/upload: a concurrent submit either sees the document or the deletion is refused.
    const [locked] = await tx.select({ status: clubRegistrations.status }).from(clubRegistrations).where(eq(clubRegistrations.id, registration.id)).for("update");
    if (!locked || (locked.status !== "draft" && locked.status !== "needs_info")) {
      throw new ConflictError("Registration can only be changed while it is a draft or needs more information");
    }
    const deleted = await tx.delete(clubRegistrationDocuments).where(eq(clubRegistrationDocuments.id, doc.id)).returning({ id: clubRegistrationDocuments.id });
    if (deleted.length === 0) throw new NotFoundError("Document not found");
    await tx.insert(auditLog).values({
      eventType: "club_registration.document_remove",
      subjectId: registration.id,
      payload: { documentId: doc.id, kind: doc.kind, userId: registration.userId },
    });
  });
  // The key comes from our own document row (never from the client), so the file can be purged unconditionally -- also
  // for pre-registry documents that have no media_files row.
  await markMediaDeleted(doc.storageKey);
  await purgeMediaFile(doc.storageKey);

  return c.body(null, 204);
});

clubRegistrationRoutes.post("/:id/submit", submitLimiter, async (c) => {
  const currentUser = c.get("user");
  const registration = await loadOwn(c.req.param("id"), currentUser.id);
  assertEditable(registration);

  // Best-effort suggestion; the authoritative slug is assigned (and collision-checked) on approval.
  const slugSuggestion = await uniqueClubSlug(db, slugifyClubName(registration.clubName));

  const submitted = await db.transaction(async (tx) => {
    // Lock first, then validate everything against the locked state: a concurrent document delete/upload or PATCH
    // can't slip in between the checks and the status change.
    const [locked] = await tx.select().from(clubRegistrations).where(eq(clubRegistrations.id, registration.id)).for("update");
    if (!locked) throw new NotFoundError("Registration not found");
    assertEditable(locked);
    assertRegisterFields(locked.legalForm, locked.registerCourt, locked.registerNumber);

    // E2: at least one qualifying proof for the legal form.
    const docs = await tx.select({ kind: clubRegistrationDocuments.kind }).from(clubRegistrationDocuments).where(eq(clubRegistrationDocuments.registrationId, locked.id));
    const qualifying = QUALIFYING_KINDS[locked.legalForm] ?? [];
    if (!docs.some((d) => (qualifying as string[]).includes(d.kind))) {
      throw new ValidationError(`At least one proof document is required (${qualifying.join(", ")})`);
    }

    // Duplicate guard: same Registergericht + number as an already approved club. The message deliberately
    // reveals nothing about that club (no name/slug/id).
    const key = registerKey(locked.registerCourt, locked.registerNumber);
    if (key) {
      const [dup] = await tx
        .select({ id: clubRegistrations.id })
        .from(clubRegistrations)
        .where(and(eq(clubRegistrations.status, "approved"), ne(clubRegistrations.id, locked.id), registerKeyMatches(key)))
        .limit(1);
      if (dup) throw new ConflictError("A club with these register details already exists. Please join it with a membership application instead.");
    }

    const [row] = await tx
      .update(clubRegistrations)
      .set({ status: "pending", submittedAt: new Date(), slugSuggestion, reviewNote: null, updatedAt: new Date() })
      .where(eq(clubRegistrations.id, locked.id))
      .returning();
    await tx.insert(auditLog).values({
      eventType: "club_registration.submit",
      subjectId: row.id,
      payload: { userId: currentUser.id, from: locked.status, slugSuggestion },
    });
    return { row, previousSubmittedAt: locked.submittedAt };
  });

  // After commit, best effort: a failing mail must never undo the status change.
  const applicant = { name: currentUser.name, email: currentUser.email };
  inBackground(sendRegistrationReceivedMail(applicant, submitted.row.clubName, submitted.row.id));
  // Throttle reviewer mails per registration so needs_info -> submit cycles can't flood the reviewers.
  const prev = submitted.previousSubmittedAt;
  if (!prev || Date.now() - prev.getTime() >= REVIEWER_MAIL_THROTTLE_MS) {
    inBackground(sendRegistrationReviewNotifyMail(applicant, submitted.row.clubName, submitted.row.id));
  }

  return c.json({ data: { registration: await shapeRegistration(submitted.row) } });
});
