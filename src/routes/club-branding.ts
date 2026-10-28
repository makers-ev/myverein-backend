import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";

import { db } from "../db/client.js";
import { clubSettings } from "../db/schema/club-settings.js";
import { writeAudit } from "../lib/audit.js";
import { DEFAULT_ACCENT_COLOR, DEFAULT_PRIMARY_COLOR } from "../lib/branding.js";
import { hasClubPermission } from "../lib/club-permissions.js";
import { ForbiddenError, ValidationError } from "../lib/errors.js";
import { contrastAgainstWhite, imageDimensions } from "../lib/image-dimensions.js";
import { discardStoredFile, deleteMedia, DOCUMENT_OWNER_TYPES, MAX_LOGO_BYTES, signedMediaUrl, sniffMimeType, storeUpload } from "../lib/media.js";
import { checkStorageThresholds } from "../lib/media-quota.js";
import { renderEphemeral } from "../lib/pdf/render.js";
import { registerBuiltinTemplates } from "../lib/pdf/templates/index.js";
import { cleanText } from "../lib/text-policy.js";
import { clubGuard, denyExternalGuests, type ClubEnv } from "../middleware/club-guard.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { sessionGuard } from "../middleware/session-guard.js";

/**
 * Branding of generated documents (Wave 13 B7), mounted at `/club-settings/branding`: logo (PNG/JPEG only, never SVG),
 * two colours with a contrast check against white, and the letterhead as plain text. Every member reads it (it is what
 * documents look like); only `branding:write` changes it. The logo is a registered media file: served as a short-lived
 * signed URL issued after the session and club check, never as a public link.
 */
export const clubBrandingRoutes = new Hono<ClubEnv>();

registerBuiltinTemplates();

clubBrandingRoutes.use("*", rateLimit({ windowMs: 60_000, max: 60 }));
clubBrandingRoutes.use("*", sessionGuard);
clubBrandingRoutes.use("*", clubGuard);

/** Minimum contrast against white: the primary colour carries text (headings, table header), the accent only lines. */
export const MIN_PRIMARY_CONTRAST = 4.5;
export const MIN_ACCENT_CONTRAST = 3;
export const MIN_LOGO_SIDE = 32;
export const MAX_LOGO_SIDE = 4000;
export const MAX_LOGO_PIXELS = 12_000_000;

function requireWrite(c: { get(key: "clubRoleTypes"): string[] }): void {
  if (!hasClubPermission(c.get("clubRoleTypes"), "branding:write")) throw new ForbiddenError("Missing branding:write permission");
}

async function shapeBranding(clubId: string) {
  const [row] = await db.select().from(clubSettings).where(eq(clubSettings.clubId, clubId)).limit(1);
  const logoUrl = row?.brandLogoKey ? await signedMediaUrl(clubId, row.brandLogoKey, DOCUMENT_OWNER_TYPES.branding) : null;
  return {
    primaryColor: row?.brandPrimaryColor ?? null,
    accentColor: row?.brandAccentColor ?? null,
    effective: { primaryColor: row?.brandPrimaryColor ?? DEFAULT_PRIMARY_COLOR, accentColor: row?.brandAccentColor ?? DEFAULT_ACCENT_COLOR },
    letterhead: {
      address: row?.letterheadAddress ?? null,
      register: row?.letterheadRegister ?? null,
      representatives: row?.letterheadRepresentatives ?? null,
      contact: row?.letterheadContact ?? null,
      footer: row?.letterheadFooter ?? null,
    },
    logo: row?.brandLogoKey && logoUrl ? { url: logoUrl } : null,
  };
}

clubBrandingRoutes.get("/", async (c) => {
  denyExternalGuests(c);
  return c.json({ data: await shapeBranding(c.get("clubId")) });
});

const color = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, { message: "must be #RRGGBB" })
  .transform((v) => v.toLowerCase());
const text = (max: number, multiline: boolean) =>
  z.union([cleanText(z.string().trim().max(max), multiline), z.null()]).transform((v) => (v === null || v === "" ? null : v));

const patchSchema = z.object({
  primaryColor: z.union([color, z.null()]).optional(),
  accentColor: z.union([color, z.null()]).optional(),
  address: text(300, true).optional(),
  register: text(200, true).optional(),
  representatives: text(300, true).optional(),
  contact: text(300, true).optional(),
  footer: text(160, false).optional(),
});

const invalid = (result: { success: boolean; error?: { issues: unknown } }) => {
  if (!result.success) throw new ValidationError("Invalid request body", { details: result.error?.issues });
};

function assertContrast(field: "primaryColor" | "accentColor", value: string, min: number): void {
  const ratio = Math.round(contrastAgainstWhite(value) * 100) / 100;
  if (ratio < min) throw new ValidationError(`${field} is too light for documents (contrast ${ratio}:1 against white, at least ${min}:1 needed)`, { details: { code: "low_contrast", field, ratio, min } });
}

/** Partial update; `null` or an empty text clears a value. */
clubBrandingRoutes.patch("/", zValidator("json", patchSchema, invalid), async (c) => {
  requireWrite(c);
  const clubId = c.get("clubId");
  const body = c.req.valid("json");
  if (body.primaryColor) assertContrast("primaryColor", body.primaryColor, MIN_PRIMARY_CONTRAST);
  if (body.accentColor) assertContrast("accentColor", body.accentColor, MIN_ACCENT_CONTRAST);
  const set = {
    ...(body.primaryColor !== undefined ? { brandPrimaryColor: body.primaryColor } : {}),
    ...(body.accentColor !== undefined ? { brandAccentColor: body.accentColor } : {}),
    ...(body.address !== undefined ? { letterheadAddress: body.address } : {}),
    ...(body.register !== undefined ? { letterheadRegister: body.register } : {}),
    ...(body.representatives !== undefined ? { letterheadRepresentatives: body.representatives } : {}),
    ...(body.contact !== undefined ? { letterheadContact: body.contact } : {}),
    ...(body.footer !== undefined ? { letterheadFooter: body.footer } : {}),
  };
  if (Object.keys(set).length > 0) {
    await db.transaction(async (tx) => {
      await tx.insert(clubSettings).values({ clubId, ...set }).onConflictDoUpdate({ target: clubSettings.clubId, set: { ...set, updatedAt: new Date() } });
      await writeAudit(tx, { eventType: "club_settings.update", subjectId: clubId, payload: { clubId, changedFields: Object.keys(set).map((k) => `branding.${k}`), changedBy: c.get("membership").id } });
    });
  }
  return c.json({ data: await shapeBranding(clubId) });
});

const uploadBody = bodyLimit({
  maxSize: MAX_LOGO_BYTES + 64 * 1024,
  onError: () => {
    throw new ValidationError(`Logo exceeds maximum size of ${MAX_LOGO_BYTES} bytes`);
  },
});

/** Multipart `file`: a PNG or JPEG logo (max 2 MB, 32-4000 px per side, max 12 megapixels); metadata is stripped. */
clubBrandingRoutes.put("/logo", rateLimit({ windowMs: 60_000, max: 30, key: (c) => `branding-logo:${c.get("user").id}` }), uploadBody, async (c) => {
  requireWrite(c);
  const clubId = c.get("clubId");
  const body = await c.req.parseBody();
  const file = body["file"];
  if (!(file instanceof File)) throw new ValidationError("Missing file upload (field name: file)");
  const head = Buffer.from(await file.arrayBuffer());
  const mime = sniffMimeType(head);
  if (mime !== "image/png" && mime !== "image/jpeg") throw new ValidationError("The logo has to be a PNG or JPEG image (no SVG, no other formats)", { details: { code: "logo_type" } });
  const dims = imageDimensions(head, mime);
  const bad = !dims || dims.width < MIN_LOGO_SIDE || dims.height < MIN_LOGO_SIDE || dims.width > MAX_LOGO_SIDE || dims.height > MAX_LOGO_SIDE || dims.width * dims.height > MAX_LOGO_PIXELS;
  if (bad) throw new ValidationError(`The logo must be between ${MIN_LOGO_SIDE} and ${MAX_LOGO_SIDE} pixels per side`, { details: { code: "logo_dimensions" } });

  let oldKey: string | null = null;
  let newKey: string | null = null;
  try {
    await db.transaction(async (tx) => {
      await tx.insert(clubSettings).values({ clubId }).onConflictDoNothing();
      const [locked] = await tx.select({ key: clubSettings.brandLogoKey }).from(clubSettings).where(eq(clubSettings.clubId, clubId)).for("update");
      oldKey = locked?.key ?? null;
      const media = await storeUpload({
        file,
        clubId,
        storagePrefix: `${clubId}/branding`,
        kind: "image",
        allowedTypes: ["image/png", "image/jpeg"],
        maxBytes: MAX_LOGO_BYTES,
        visibility: "club",
        owner: { type: DOCUMENT_OWNER_TYPES.branding, id: clubId },
        uploadedBy: c.get("user").id,
        executor: tx,
      });
      newKey = media.storageKey;
      await tx.update(clubSettings).set({ brandLogoKey: media.storageKey, updatedAt: new Date() }).where(eq(clubSettings.clubId, clubId));
      await writeAudit(tx, { eventType: "club_settings.update", subjectId: clubId, payload: { clubId, changedFields: ["branding.logo"], changedBy: c.get("membership").id } });
    });
  } catch (err) {
    if (newKey) await discardStoredFile(newKey);
    throw err;
  }
  if (oldKey) await deleteMedia(oldKey, clubId);
  await checkStorageThresholds(clubId);
  return c.json({ data: await shapeBranding(clubId) });
});

clubBrandingRoutes.delete("/logo", async (c) => {
  requireWrite(c);
  const clubId = c.get("clubId");
  const oldKey = await db.transaction(async (tx) => {
    const [locked] = await tx.select({ key: clubSettings.brandLogoKey }).from(clubSettings).where(eq(clubSettings.clubId, clubId)).for("update");
    if (!locked?.key) return null;
    await tx.update(clubSettings).set({ brandLogoKey: null, updatedAt: new Date() }).where(eq(clubSettings.clubId, clubId));
    await writeAudit(tx, { eventType: "club_settings.update", subjectId: clubId, payload: { clubId, changedFields: ["branding.logo"], changedBy: c.get("membership").id } });
    return locked.key;
  });
  if (oldKey) await deleteMedia(oldKey, clubId);
  return c.body(null, 204);
});

/** A one-page test PDF with the current branding and dummy data (nothing is stored, nothing counts against the quota). */
clubBrandingRoutes.post("/preview", rateLimit({ windowMs: 60_000, max: 10, key: (c) => `branding-preview:${c.get("user").id}` }), async (c) => {
  requireWrite(c);
  const { bytes, filename } = await renderEphemeral("branding-test", c.get("clubId"), {});
  c.header("Content-Type", "application/pdf");
  c.header("Content-Disposition", `inline; filename="${filename}"`);
  c.header("Cache-Control", "private, no-store");
  c.header("X-Content-Type-Options", "nosniff");
  return c.body(new Uint8Array(bytes));
});
