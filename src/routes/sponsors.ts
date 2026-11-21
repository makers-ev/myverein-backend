import { zValidator } from "@hono/zod-validator";
import { and, asc, eq, ilike, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";

import { db } from "../db/client.js";
import { sponsorContacts, sponsors, SPONSOR_VISIBILITIES } from "../db/schema/sponsors.js";
import { writeAudit } from "../lib/audit.js";
import { hasClubPermission } from "../lib/club-permissions.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import { deleteMedia, discardStoredFile, IMAGE_TYPES, MAX_LOGO_BYTES, storeUpload } from "../lib/media.js";
import { checkStorageThresholds } from "../lib/media-quota.js";
import { todayBerlin } from "../lib/member-lifecycle.js";
import { likePattern } from "../lib/club-search.js";
import { loadSponsor, shapeContact, shapeSponsors, SPONSOR_LOGO_OWNER, SPONSOR_STATUSES, sponsorStatus, isExpiringSoon } from "../lib/sponsors.js";
import { cleanText } from "../lib/text-policy.js";
import { clubGuard, type ClubEnv } from "../middleware/club-guard.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { sessionGuard } from "../middleware/session-guard.js";

/**
 * Sponsors and partners of a club (Wave 15 B1), mounted at `/sponsors`. Deny-by-default: reading needs `sponsors:read` (board),
 * every change `sponsors:write` (vorsitz, stellv_vorsitz, kassenwart, schriftfuehrer); plain members, guardians and external
 * roles get 403. The logo goes through the central media layer (PNG/JPEG/WebP, magic bytes, EXIF strip, quota) and is handed out
 * as a signed URL only. No amounts, no invoices: billing is outside MyVerein.
 */
export const sponsorRoutes = new Hono<ClubEnv>();

sponsorRoutes.use("*", rateLimit({ windowMs: 60_000, max: 60 }));
sponsorRoutes.use("*", sessionGuard);
sponsorRoutes.use("*", clubGuard);

const hook = (result: { success: boolean; error?: { issues: unknown } }) => {
  if (!result.success) throw new ValidationError("Invalid request", { details: result.error?.issues });
};

function requireRead(c: Context<ClubEnv>): void {
  if (!hasClubPermission(c.get("clubRoleTypes"), "sponsors:read")) throw new ForbiddenError("Missing sponsors:read permission");
}

function requireWrite(c: Context<ClubEnv>): void {
  if (!hasClubPermission(c.get("clubRoleTypes"), "sponsors:write")) throw new ForbiddenError("Missing sponsors:write permission");
}

const optionalText = (max: number, multiline = false) =>
  z.union([cleanText(z.string().trim().max(max), multiline), z.null()]).transform((v) => (v === null || v === "" ? null : v));

/** An external http(s) link the board types in (never a file). */
export const externalLink = z
  .union([z.string().trim().max(300), z.null()])
  .transform((v) => (v === null || v === "" ? null : v))
  .refine((v) => v === null || /^https?:\/\/[^\s<>"]+$/i.test(v), { message: "must be an http(s) link" });

const isoDay = z.union([z.iso.date(), z.null()]);

const sponsorFields = {
  name: cleanText(z.string().trim().min(1).max(120)),
  website: externalLink.optional(),
  description: optionalText(2000, true).optional(),
  consideration: optionalText(1000, true).optional(),
  startsOn: isoDay.optional(),
  endsOn: isoDay.optional(),
  visibility: z.enum(SPONSOR_VISIBILITIES).optional(),
  notes: optionalText(2000, true).optional(),
};

const periodOk = (v: { startsOn?: string | null; endsOn?: string | null }) => !v.startsOn || !v.endsOn || v.endsOn >= v.startsOn;
const periodIssue = { message: "endsOn must not be before startsOn", path: ["endsOn"] };

const createSchema = z
  .object({
    ...sponsorFields,
    contacts: z
      .array(
        z.object({
          name: cleanText(z.string().trim().min(1).max(120)),
          role: optionalText(80).optional(),
          email: z.union([z.string().trim().toLowerCase().max(320).pipe(z.email()), z.literal(""), z.null()]).optional(),
          phone: optionalText(40).optional(),
          isPrimary: z.boolean().optional(),
        }),
      )
      .max(10)
      .optional(),
  })
  .refine(periodOk, periodIssue);

const updateSchema = z
  .object({ ...sponsorFields, name: sponsorFields.name.optional() })
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to change" })
  .refine(periodOk, periodIssue);

const listQuery = z.object({
  status: z.enum([...SPONSOR_STATUSES, "laeuft_aus"]).optional(),
  visibility: z.enum(SPONSOR_VISIBILITIES).optional(),
  q: z.string().trim().min(1).max(100).optional(),
});

/** Sponsors of the club, newest contract end last; filters `status` (incl. `laeuft_aus` = active and ending soon), `visibility`, `q` (name). */
sponsorRoutes.get("/", zValidator("query", listQuery, hook), async (c) => {
  requireRead(c);
  const clubId = c.get("clubId");
  const q = c.req.valid("query");
  const rows = await db
    .select()
    .from(sponsors)
    .where(and(eq(sponsors.clubId, clubId), q.visibility ? eq(sponsors.visibility, q.visibility) : undefined, q.q ? ilike(sponsors.name, likePattern(q.q)) : undefined))
    .orderBy(sql`lower(${sponsors.name})`, asc(sponsors.id))
    .limit(500);
  const today = todayBerlin();
  const filtered = rows.filter((r) => {
    if (!q.status) return true;
    if (q.status === "laeuft_aus") return isExpiringSoon(r, today);
    return sponsorStatus(r, today) === q.status;
  });
  c.header("Cache-Control", "private, no-store");
  return c.json({ data: await shapeSponsors(clubId, filtered, today) });
});

sponsorRoutes.get("/:id", async (c) => {
  requireRead(c);
  const clubId = c.get("clubId");
  const row = await loadSponsor(clubId, c.req.param("id"));
  c.header("Cache-Control", "private, no-store");
  return c.json({ data: (await shapeSponsors(clubId, [row], todayBerlin()))[0] });
});

sponsorRoutes.post("/", zValidator("json", createSchema, hook), async (c) => {
  requireWrite(c);
  const clubId = c.get("clubId");
  const body = c.req.valid("json");
  const actor = c.get("membership").id;
  const created = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(sponsors)
      .values({
        clubId,
        name: body.name,
        website: body.website ?? null,
        description: body.description ?? null,
        consideration: body.consideration ?? null,
        startsOn: body.startsOn ?? null,
        endsOn: body.endsOn ?? null,
        visibility: body.visibility ?? "intern",
        notes: body.notes ?? null,
        createdBy: actor,
      })
      .returning();
    const contacts = body.contacts ?? [];
    if (contacts.length > 0) {
      const firstPrimary = contacts.findIndex((x) => x.isPrimary);
      await tx.insert(sponsorContacts).values(contacts.map((x, i) => ({ sponsorId: row!.id, name: x.name, role: x.role ?? null, email: x.email || null, phone: x.phone ?? null, isPrimary: i === firstPrimary })));
    }
    await writeAudit(tx, { eventType: "sponsor.create", subjectId: row!.id, payload: { clubId, sponsorId: row!.id, visibility: row!.visibility, contacts: contacts.length } });
    return row!;
  });
  return c.json({ data: (await shapeSponsors(clubId, [created], todayBerlin()))[0] }, 201);
});

sponsorRoutes.patch("/:id", zValidator("json", updateSchema, hook), async (c) => {
  requireWrite(c);
  const clubId = c.get("clubId");
  const body = c.req.valid("json");
  const existing = await loadSponsor(clubId, c.req.param("id"));
  const startsOn = body.startsOn !== undefined ? body.startsOn : existing.startsOn;
  const endsOn = body.endsOn !== undefined ? body.endsOn : existing.endsOn;
  if (startsOn && endsOn && endsOn < startsOn) throw new ValidationError("endsOn must not be before startsOn", { details: { code: "invalid_period" } });
  const set = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx.update(sponsors).set({ ...set, updatedAt: new Date() }).where(and(eq(sponsors.id, existing.id), eq(sponsors.clubId, clubId))).returning();
    if (!row) throw new NotFoundError("Sponsor not found");
    await writeAudit(tx, { eventType: "sponsor.update", subjectId: row.id, payload: { clubId, sponsorId: row.id, changedFields: Object.keys(set) } });
    return row;
  });
  return c.json({ data: (await shapeSponsors(clubId, [updated], todayBerlin()))[0] });
});

sponsorRoutes.delete("/:id", async (c) => {
  requireWrite(c);
  const clubId = c.get("clubId");
  const existing = await loadSponsor(clubId, c.req.param("id"));
  await db.transaction(async (tx) => {
    await tx.delete(sponsors).where(and(eq(sponsors.id, existing.id), eq(sponsors.clubId, clubId)));
    await writeAudit(tx, { eventType: "sponsor.delete", subjectId: existing.id, payload: { clubId, sponsorId: existing.id, hadLogo: existing.logoKey !== null } });
  });
  if (existing.logoKey) await deleteMedia(existing.logoKey, clubId);
  return c.body(null, 204);
});

// --- Logo ---------------------------------------------------------------------------------------------------------------

const logoBody = bodyLimit({
  maxSize: MAX_LOGO_BYTES + 64 * 1024,
  onError: () => {
    throw new ValidationError(`Logo exceeds maximum size of ${MAX_LOGO_BYTES} bytes`);
  },
});

/** Multipart `file`: PNG, JPEG or WebP (max 2 MB, magic bytes checked, metadata stripped). Replaces an existing logo. */
sponsorRoutes.put("/:id/logo", rateLimit({ windowMs: 60_000, max: 30, key: (c) => `sponsor-logo:${c.get("user").id}` }), logoBody, async (c) => {
  requireWrite(c);
  const clubId = c.get("clubId");
  const existing = await loadSponsor(clubId, c.req.param("id"));
  const body = await c.req.parseBody();
  const file = body["file"];
  if (!(file instanceof File)) throw new ValidationError("Missing file upload (field name: file)");

  let oldKey: string | null = null;
  let newKey: string | null = null;
  try {
    await db.transaction(async (tx) => {
      const [locked] = await tx.select({ key: sponsors.logoKey }).from(sponsors).where(and(eq(sponsors.id, existing.id), eq(sponsors.clubId, clubId))).for("update");
      if (!locked) throw new NotFoundError("Sponsor not found");
      oldKey = locked.key;
      const media = await storeUpload({
        file,
        clubId,
        storagePrefix: `${clubId}/sponsors`,
        kind: "image",
        allowedTypes: IMAGE_TYPES,
        maxBytes: MAX_LOGO_BYTES,
        visibility: "private",
        owner: { type: SPONSOR_LOGO_OWNER, id: existing.id },
        uploadedBy: c.get("user").id,
        executor: tx,
      });
      newKey = media.storageKey;
      await tx.update(sponsors).set({ logoKey: media.storageKey, updatedAt: new Date() }).where(eq(sponsors.id, existing.id));
      await writeAudit(tx, { eventType: "sponsor.update", subjectId: existing.id, payload: { clubId, sponsorId: existing.id, changedFields: ["logo"] } });
    });
  } catch (err) {
    if (newKey) await discardStoredFile(newKey);
    throw err;
  }
  if (oldKey) await deleteMedia(oldKey, clubId);
  await checkStorageThresholds(clubId);
  return c.json({ data: (await shapeSponsors(clubId, [await loadSponsor(clubId, existing.id)], todayBerlin()))[0] });
});

sponsorRoutes.delete("/:id/logo", async (c) => {
  requireWrite(c);
  const clubId = c.get("clubId");
  const existing = await loadSponsor(clubId, c.req.param("id"));
  const oldKey = await db.transaction(async (tx) => {
    const [locked] = await tx.select({ key: sponsors.logoKey }).from(sponsors).where(eq(sponsors.id, existing.id)).for("update");
    if (!locked?.key) return null;
    await tx.update(sponsors).set({ logoKey: null, updatedAt: new Date() }).where(eq(sponsors.id, existing.id));
    await writeAudit(tx, { eventType: "sponsor.update", subjectId: existing.id, payload: { clubId, sponsorId: existing.id, changedFields: ["logo"] } });
    return locked.key;
  });
  if (oldKey) await deleteMedia(oldKey, clubId);
  return c.body(null, 204);
});

// --- Contacts -------------------------------------------------------------------------------------------------------------

const contactSchema = z.object({
  name: cleanText(z.string().trim().min(1).max(120)),
  role: optionalText(80).optional(),
  email: z.union([z.string().trim().toLowerCase().max(320).pipe(z.email()), z.literal(""), z.null()]).optional(),
  phone: optionalText(40).optional(),
  isPrimary: z.boolean().optional(),
});
const contactPatchSchema = contactSchema.partial().refine((v) => Object.keys(v).length > 0, { message: "Nothing to change" });

const MAX_CONTACTS = 10;

sponsorRoutes.post("/:id/contacts", zValidator("json", contactSchema, hook), async (c) => {
  requireWrite(c);
  const clubId = c.get("clubId");
  const sponsor = await loadSponsor(clubId, c.req.param("id"));
  const body = c.req.valid("json");
  const created = await db.transaction(async (tx) => {
    await tx.select({ id: sponsors.id }).from(sponsors).where(eq(sponsors.id, sponsor.id)).for("update");
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(sponsorContacts).where(eq(sponsorContacts.sponsorId, sponsor.id));
    if (n >= MAX_CONTACTS) throw new ValidationError(`At most ${MAX_CONTACTS} contacts per sponsor`, { details: { code: "contact_limit" } });
    if (body.isPrimary) await tx.update(sponsorContacts).set({ isPrimary: false }).where(eq(sponsorContacts.sponsorId, sponsor.id));
    const [row] = await tx.insert(sponsorContacts).values({ sponsorId: sponsor.id, name: body.name, role: body.role ?? null, email: body.email || null, phone: body.phone ?? null, isPrimary: body.isPrimary ?? false }).returning();
    await writeAudit(tx, { eventType: "sponsor.contact_change", subjectId: sponsor.id, payload: { clubId, sponsorId: sponsor.id, contactId: row!.id, action: "create" } });
    return row!;
  });
  return c.json({ data: shapeContact(created) }, 201);
});

async function loadContact(sponsorId: string, contactId: string) {
  const row = await db.query.sponsorContacts.findFirst({ where: and(eq(sponsorContacts.id, contactId), eq(sponsorContacts.sponsorId, sponsorId)) });
  if (!row) throw new NotFoundError("Contact not found");
  return row;
}

sponsorRoutes.patch("/:id/contacts/:contactId", zValidator("json", contactPatchSchema, hook), async (c) => {
  requireWrite(c);
  const clubId = c.get("clubId");
  const sponsor = await loadSponsor(clubId, c.req.param("id"));
  const contact = await loadContact(sponsor.id, c.req.param("contactId"));
  const body = c.req.valid("json");
  const updated = await db.transaction(async (tx) => {
    if (body.isPrimary) await tx.update(sponsorContacts).set({ isPrimary: false }).where(eq(sponsorContacts.sponsorId, sponsor.id));
    const set = Object.fromEntries(Object.entries({ ...body, email: body.email === undefined ? undefined : body.email || null }).filter(([, v]) => v !== undefined));
    const [row] = await tx.update(sponsorContacts).set(set).where(eq(sponsorContacts.id, contact.id)).returning();
    await writeAudit(tx, { eventType: "sponsor.contact_change", subjectId: sponsor.id, payload: { clubId, sponsorId: sponsor.id, contactId: contact.id, action: "update" } });
    return row!;
  });
  return c.json({ data: shapeContact(updated) });
});

sponsorRoutes.delete("/:id/contacts/:contactId", async (c) => {
  requireWrite(c);
  const clubId = c.get("clubId");
  const sponsor = await loadSponsor(clubId, c.req.param("id"));
  const contact = await loadContact(sponsor.id, c.req.param("contactId"));
  await db.transaction(async (tx) => {
    await tx.delete(sponsorContacts).where(eq(sponsorContacts.id, contact.id));
    await writeAudit(tx, { eventType: "sponsor.contact_change", subjectId: sponsor.id, payload: { clubId, sponsorId: sponsor.id, contactId: contact.id, action: "delete" } });
  });
  return c.body(null, 204);
});
