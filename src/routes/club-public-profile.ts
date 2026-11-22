import { zValidator } from "@hono/zod-validator";
import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";

import { member, organization, user } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { calendars } from "../db/schema/calendars.js";
import { clubPublicProfiles, type PublicProfileContent } from "../db/schema/club-public-profiles.js";
import { clubSettings } from "../db/schema/club-settings.js";
import { departments } from "../db/schema/departments.js";
import { mediaFiles } from "../db/schema/media-files.js";
import { writeAudit } from "../lib/audit.js";
import { hasClubPermission } from "../lib/club-permissions.js";
import { ForbiddenError, ValidationError } from "../lib/errors.js";
import { deleteMedia, IMAGE_TYPES, MAX_PHOTO_BYTES, signedMediaUrls, storeUpload } from "../lib/media.js";
import { draftOf, imageKeysOf, loadProfileRow, MAX_GALLERY_IMAGES, MAX_PROFILE_IMAGES, normalizeContent, PUBLIC_PROFILE_OWNER, publicSettings, sameContent, syncPublicMedia } from "../lib/public-profile.js";
import { latestPublishedNotice } from "../lib/privacy-notice.js";
import { cleanText } from "../lib/text-policy.js";
import { clubGuard, type ClubEnv } from "../middleware/club-guard.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { sessionGuard } from "../middleware/session-guard.js";
import { externalLink } from "./sponsors.js";

/**
 * Editor of the public club page (Wave 15 B3), mounted at `/club-public-profile`. Only `public_profile:write` (vorsitz,
 * stellv_vorsitz, schriftfuehrer); everybody else 403. The board edits a DRAFT, previews it (signed image URLs) and releases it
 * with an explicit publish step; the public endpoint only reads the published snapshot and only while
 * `club_settings.public_profile_enabled` is on (default off). Contact data may only be published after the board confirmed it
 * is a club address or the person agreed (no personal data without consent, Wave 10).
 */
export const clubPublicProfileRoutes = new Hono<ClubEnv>();

clubPublicProfileRoutes.use("*", rateLimit({ windowMs: 60_000, max: 60 }));
clubPublicProfileRoutes.use("*", sessionGuard);
clubPublicProfileRoutes.use("*", clubGuard);
clubPublicProfileRoutes.use("*", async (c, next) => {
  if (!hasClubPermission(c.get("clubRoleTypes"), "public_profile:write")) throw new ForbiddenError("Missing public_profile:write permission");
  c.header("Cache-Control", "private, no-store");
  await next();
});

const hook = (result: { success: boolean; error?: { issues: unknown } }) => {
  if (!result.success) throw new ValidationError("Invalid request", { details: result.error?.issues });
};

const optionalText = (max: number, multiline = false) =>
  z.union([cleanText(z.string().trim().max(max), multiline), z.null()]).transform((v) => (v === null || v === "" ? null : v));
const key = z.string().min(1).max(300);

const profileSchema = z
  .object({
    tagline: optionalText(160),
    description: optionalText(5000, true),
    city: optionalText(80),
    address: optionalText(300, true),
    contactEmail: z.union([z.string().trim().toLowerCase().max(320).pipe(z.email()), z.literal(""), z.null()]).transform((v) => v || null),
    contactPhone: optionalText(40),
    website: externalLink,
    logoKey: z.union([key, z.null()]),
    coverKey: z.union([key, z.null()]),
    galleryKeys: z.array(key).max(MAX_GALLERY_IMAGES),
    departmentIds: z.array(z.uuid()).max(50),
    eventCalendarIds: z.array(z.uuid()).max(20),
    showSponsors: z.boolean(),
    leadFormEnabled: z.boolean(),
    trialTrainingEnabled: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to change" });

async function memberName(memberId: string | null): Promise<{ memberId: string; name: string } | null> {
  if (!memberId) return null;
  const [row] = await db.select({ name: user.name }).from(member).innerJoin(user, eq(user.id, member.userId)).where(eq(member.id, memberId));
  return row ? { memberId, name: row.name } : null;
}

async function withPreviewUrls(clubId: string, content: PublicProfileContent) {
  const urls = await signedMediaUrls(clubId, imageKeysOf(content), PUBLIC_PROFILE_OWNER);
  const url = (k: string | null) => (k ? (urls.get(k) ?? null) : null);
  return { ...content, logoUrl: url(content.logoKey), coverUrl: url(content.coverKey), galleryUrls: content.galleryKeys.map((k) => urls.get(k) ?? null) };
}

async function editorView(clubId: string) {
  const [row, settings, [org]] = await Promise.all([loadProfileRow(clubId), publicSettings(clubId), db.select({ slug: organization.slug }).from(organization).where(eq(organization.id, clubId))]);
  const draft = draftOf(row);
  const published = row?.published ? normalizeContent(row.published) : null;
  return {
    settings,
    draft: await withPreviewUrls(clubId, draft),
    published: published ? { ...(await withPreviewUrls(clubId, published)), publishedAt: row!.publishedAt, publishedBy: await memberName(row!.publishedBy) } : null,
    hasUnpublishedChanges: published ? !sameContent(draft, published) : true,
    slug: org?.slug ?? "",
    publicPath: `/v/${org?.slug ?? ""}`,
  };
}

clubPublicProfileRoutes.get("/", async (c) => c.json({ data: await editorView(c.get("clubId")) }));

/** Validates referenced images (uploaded for the page, this club, live), departments and calendars of the club. */
async function assertReferences(clubId: string, next: PublicProfileContent): Promise<void> {
  const keys = imageKeysOf(next);
  if (keys.length > 0) {
    const rows = await db.select({ key: mediaFiles.storageKey }).from(mediaFiles).where(and(inArray(mediaFiles.storageKey, keys), eq(mediaFiles.clubId, clubId), eq(mediaFiles.ownerType, PUBLIC_PROFILE_OWNER), eq(mediaFiles.kind, "image"), isNull(mediaFiles.deletedAt)));
    const known = new Set(rows.map((r) => r.key));
    const unknown = keys.filter((k) => !known.has(k));
    if (unknown.length > 0) throw new ValidationError("Unknown image: upload it via POST /club-public-profile/images first", { details: { code: "unknown_image" } });
  }
  if (next.departmentIds.length > 0) {
    const rows = await db.select({ id: departments.id }).from(departments).where(and(eq(departments.clubId, clubId), inArray(departments.id, next.departmentIds)));
    if (rows.length !== new Set(next.departmentIds).size) throw new ValidationError("Unknown department", { details: { code: "unknown_department" } });
  }
  if (next.eventCalendarIds.length > 0) {
    const rows = await db.select({ id: calendars.id }).from(calendars).where(and(eq(calendars.clubId, clubId), inArray(calendars.id, next.eventCalendarIds)));
    if (rows.length !== new Set(next.eventCalendarIds).size) throw new ValidationError("Unknown calendar", { details: { code: "unknown_calendar" } });
  }
}

/** Removes page images that neither the draft nor the published version uses and that are older than an hour. */
async function cleanupImages(clubId: string): Promise<void> {
  const row = await loadProfileRow(clubId);
  const used = new Set([...imageKeysOf(draftOf(row)), ...(row?.published ? imageKeysOf(normalizeContent(row.published)) : [])]);
  const stale = await db
    .select({ key: mediaFiles.storageKey })
    .from(mediaFiles)
    .where(and(eq(mediaFiles.clubId, clubId), eq(mediaFiles.ownerType, PUBLIC_PROFILE_OWNER), isNull(mediaFiles.deletedAt), lt(mediaFiles.createdAt, new Date(Date.now() - 3_600_000))));
  for (const { key: k } of stale) if (!used.has(k)) await deleteMedia(k, clubId);
}

clubPublicProfileRoutes.put("/", zValidator("json", profileSchema, hook), async (c) => {
  const clubId = c.get("clubId");
  const body = c.req.valid("json");
  const current = draftOf(await loadProfileRow(clubId));
  const next = { ...current, ...Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)) } as PublicProfileContent;
  next.galleryKeys = [...new Set(next.galleryKeys)];
  next.departmentIds = [...new Set(next.departmentIds)];
  next.eventCalendarIds = [...new Set(next.eventCalendarIds)];
  await assertReferences(clubId, next);
  const actor = c.get("membership").id;
  await db.transaction(async (tx) => {
    await tx
      .insert(clubPublicProfiles)
      .values({ clubId, ...next, updatedBy: actor })
      .onConflictDoUpdate({ target: clubPublicProfiles.clubId, set: { ...next, updatedBy: actor, updatedAt: new Date() } });
    await writeAudit(tx, { eventType: "public_profile.update", subjectId: clubId, payload: { clubId, changedFields: Object.keys(body) } });
  });
  await cleanupImages(clubId);
  return c.json({ data: await editorView(clubId) });
});

const imageBody = bodyLimit({
  maxSize: MAX_PHOTO_BYTES + 64 * 1024,
  onError: () => {
    throw new ValidationError(`Image exceeds maximum size of ${MAX_PHOTO_BYTES} bytes`);
  },
});

/** Multipart `file` (PNG/JPEG/WebP, max 5 MB): stored privately; it becomes public only as part of the published page. */
clubPublicProfileRoutes.post("/images", rateLimit({ windowMs: 60_000, max: 30, key: (c) => `public-profile-image:${c.get("user").id}` }), imageBody, async (c) => {
  const clubId = c.get("clubId");
  const body = await c.req.parseBody();
  const file = body["file"];
  if (!(file instanceof File)) throw new ValidationError("Missing file upload (field name: file)");
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(mediaFiles).where(and(eq(mediaFiles.clubId, clubId), eq(mediaFiles.ownerType, PUBLIC_PROFILE_OWNER), isNull(mediaFiles.deletedAt)));
  if (n >= MAX_PROFILE_IMAGES) throw new ValidationError(`At most ${MAX_PROFILE_IMAGES} images for the public page`, { details: { code: "image_limit" } });
  const row = await storeUpload({
    file,
    clubId,
    storagePrefix: `${clubId}/public`,
    kind: "image",
    allowedTypes: IMAGE_TYPES,
    maxBytes: MAX_PHOTO_BYTES,
    visibility: "private",
    owner: { type: PUBLIC_PROFILE_OWNER, id: clubId },
    uploadedBy: c.get("user").id,
  });
  const urls = await signedMediaUrls(clubId, [row.storageKey], PUBLIC_PROFILE_OWNER);
  return c.json({ data: { key: row.storageKey, previewUrl: urls.get(row.storageKey) ?? null, mimeType: row.mimeType, sizeBytes: row.sizeBytes } }, 201);
});

/**
 * The enquiry form collects personal data, so it may only go public together with the club's published privacy notice
 * (Wave 10 B11): otherwise `422 privacy_notice_required`.
 */
async function assertNoticeForLeadForm(clubId: string, leadFormEnabled: boolean): Promise<void> {
  if (!leadFormEnabled) return;
  if (!(await latestPublishedNotice(clubId))) {
    throw new ValidationError("Publish the club's privacy notice before switching the enquiry form on", { details: { code: "privacy_notice_required" } });
  }
}

const publishSchema = z.object({ contactConsentConfirmed: z.boolean().optional(), enable: z.boolean().optional() });

clubPublicProfileRoutes.post("/publish", zValidator("json", publishSchema, hook), async (c) => {
  const clubId = c.get("clubId");
  const body = c.req.valid("json");
  const row = await loadProfileRow(clubId);
  const draft = draftOf(row);
  await assertReferences(clubId, draft);
  await assertNoticeForLeadForm(clubId, draft.leadFormEnabled);
  const hasContact = draft.contactEmail !== null || draft.contactPhone !== null;
  if (hasContact && body.contactConsentConfirmed !== true) {
    throw new ValidationError("Confirm that the contact may be published (club address or consent of the person)", { details: { code: "contact_consent_required" } });
  }
  const actor = c.get("membership").id;
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .insert(clubPublicProfiles)
      .values({ clubId, ...draft, published: draft, publishedAt: now, publishedBy: actor, contactConsentAt: hasContact ? now : null, updatedBy: actor })
      .onConflictDoUpdate({ target: clubPublicProfiles.clubId, set: { published: draft, publishedAt: now, publishedBy: actor, contactConsentAt: hasContact ? now : null, updatedAt: now } });
    if (body.enable) await tx.insert(clubSettings).values({ clubId, publicProfileEnabled: true }).onConflictDoUpdate({ target: clubSettings.clubId, set: { publicProfileEnabled: true, updatedAt: now } });
    await writeAudit(tx, { eventType: "public_profile.publish", subjectId: clubId, payload: { clubId, contactConfirmed: hasContact, enabled: body.enable === true } });
  });
  await syncPublicMedia(clubId);
  await cleanupImages(clubId);
  return c.json({ data: await editorView(clubId) });
});

clubPublicProfileRoutes.post("/unpublish", async (c) => {
  const clubId = c.get("clubId");
  await db.transaction(async (tx) => {
    await tx.update(clubPublicProfiles).set({ published: null, publishedAt: null, publishedBy: null, updatedAt: new Date() }).where(eq(clubPublicProfiles.clubId, clubId));
    await writeAudit(tx, { eventType: "public_profile.unpublish", subjectId: clubId, payload: { clubId } });
  });
  await syncPublicMedia(clubId);
  await cleanupImages(clubId);
  return c.json({ data: await editorView(clubId) });
});

const settingsSchema = z
  .object({ publicProfileEnabled: z.boolean().optional(), discoverable: z.boolean().optional(), publicIndexingEnabled: z.boolean().optional() })
  .refine((v) => v.publicProfileEnabled !== undefined || v.discoverable !== undefined || v.publicIndexingEnabled !== undefined, { message: "Nothing to change" });

clubPublicProfileRoutes.put("/settings", zValidator("json", settingsSchema, hook), async (c) => {
  const clubId = c.get("clubId");
  const body = c.req.valid("json");
  if (body.publicProfileEnabled) {
    const row = await loadProfileRow(clubId);
    await assertNoticeForLeadForm(clubId, row?.published ? normalizeContent(row.published).leadFormEnabled : false);
  }
  const set = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
  await db.transaction(async (tx) => {
    await tx.insert(clubSettings).values({ clubId, ...set }).onConflictDoUpdate({ target: clubSettings.clubId, set: { ...set, updatedAt: new Date() } });
    await writeAudit(tx, { eventType: "public_profile.settings", subjectId: clubId, payload: { clubId, publicProfileEnabled: body.publicProfileEnabled, discoverable: body.discoverable, publicIndexingEnabled: body.publicIndexingEnabled } });
  });
  await syncPublicMedia(clubId);
  return c.json({ data: await editorView(clubId) });
});
