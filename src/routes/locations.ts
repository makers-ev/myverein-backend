import { zValidator } from "@hono/zod-validator";
import { and, count, desc, eq, inArray } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";

import { member, user } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { locationLinks } from "../db/schema/location-links.js";
import { locationWifiNetworks, WIFI_SECURITY_TYPES, type LocationWifiNetworkRow } from "../db/schema/location-wifi.js";
import { LOCATION_VISIBILITIES, locationKeyHistory, locationKeyHolders, locations, type LocationRow, type LocationVisibility } from "../db/schema/locations.js";
import { clubMembers } from "../db/schema/club-members.js";
import { hasClubPermission } from "../lib/club-permissions.js";
import { notifyHandover } from "../lib/handover-notify.js";
import { wifiQrPayload } from "../lib/wifi-qr.js";
import { ConflictError, ForbiddenError, isUniqueViolation, NotFoundError, ValidationError } from "../lib/errors.js";
import { attachUploadedImage, markMediaDeleted, purgeMediaFile, signedMediaUrls } from "../lib/media.js";
import { clubGuard, type ClubEnv } from "../middleware/club-guard.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { sessionGuard } from "../middleware/session-guard.js";
import { writeAudit } from "../lib/audit.js";
import { locationBookingRoutes } from "./location-bookings.js";

export const locationRoutes = new Hono<ClubEnv>();

locationRoutes.use("*", rateLimit({ windowMs: 60_000, max: 60 }));
locationRoutes.use("*", sessionGuard);
locationRoutes.use("*", clubGuard);

/** Loads a location scoped to `clubId` only. 404s (never 403) on a wrong-club or missing id. */
async function loadClubLocation(id: string, clubId: string) {
  const row = await db.query.locations.findFirst({ where: and(eq(locations.id, id), eq(locations.clubId, clubId)) });
  if (!row) throw new NotFoundError("Location not found");
  return row;
}

function requireLocationsWrite(roleTypes: readonly string[]) {
  if (!hasClubPermission(roleTypes, "locations:write")) {
    throw new ForbiddenError("Missing locations:write permission");
  }
}

/** True for roles that may see access info (key holders, access notes) and 'vorstand'-level wifi/links. */
function canReadAccess(roleTypes: readonly string[]) {
  return hasClubPermission(roleTypes, "locations:write") || hasClubPermission(roleTypes, "locations:read_access");
}

/**
 * Visibility levels the caller may read: external guests only 'gast'; members 'gast' + 'mitglied';
 * 'vorstand' additionally needs locations:write / locations:read_access (B8).
 */
function readableVisibilities(c: Context<ClubEnv>): LocationVisibility[] {
  if (c.get("membership").role === "guest") return ["gast"];
  return canReadAccess(c.get("clubRoleTypes")) ? [...LOCATION_VISIBILITIES] : ["gast", "mitglied"];
}

/** API shape of a wifi network / link: `visibility` is the source of truth, `visibleToGuests` is a derived legacy flag. */
function withLegacyGuestFlag<T extends { visibility: string }>(row: T) {
  return { ...row, visibleToGuests: row.visibility === "gast" };
}

/**
 * Legacy clients send `visibleToGuests`; `visibility` wins if both are present. `visibleToGuests: false` only means
 * "not for guests": it lowers a `gast` row to `mitglied` but must never RAISE a `vorstand` row (the old flag knows no
 * third level), so on PATCH pass the row's `current` visibility. On create there is no current value (-> `mitglied`).
 */
function resolveVisibility(body: { visibility?: LocationVisibility; visibleToGuests?: boolean }, current?: string): LocationVisibility | undefined {
  if (body.visibility !== undefined) return body.visibility;
  if (body.visibleToGuests === undefined) return undefined;
  if (body.visibleToGuests) return "gast";
  if (current === undefined || current === "gast") return "mitglied";
  return undefined; // already mitglied or vorstand: unchanged
}

const visibilityField = z.enum(LOCATION_VISIBILITIES);
const securityField = z.enum(WIFI_SECURITY_TYPES);

/** API shape of a wifi network: legacy guest flag plus `qrPayload` (the `WIFI:` string for the QR code, built from `security`). */
function shapeWifi(row: LocationWifiNetworkRow) {
  return { ...withLegacyGuestFlag(row), qrPayload: wifiQrPayload(row) };
}

/**
 * Resolves security + password of a wifi write. Legacy clients send neither a type nor an explicit "open": an empty
 * password still means an open network, a password on a stored open network means WPA. An open network never keeps a
 * password; any other type needs one.
 */
function resolveWifiSecurity(input: { security?: (typeof WIFI_SECURITY_TYPES)[number]; password?: string }, current?: { security: string; password: string }) {
  const password = input.password ?? current?.password ?? "";
  let security = (input.security ?? (current?.security as (typeof WIFI_SECURITY_TYPES)[number] | undefined)) ?? (password === "" ? "open" : "wpa");
  if (input.security === undefined && input.password !== undefined) {
    if (input.password === "") security = "open";
    else if (security === "open") security = "wpa";
  }
  if (security === "open") return { security, password: "" };
  if (password === "") throw new ValidationError("A password is required unless security is 'open'");
  return { security, password };
}

/** Strips access info (access note) from a location when the caller lacks access rights; shape stays stable. */
function shapeLocation(row: LocationRow, roleTypes: readonly string[]) {
  if (canReadAccess(roleTypes)) return { ...row, accessRestricted: false };
  return { ...row, accessNote: null, accessRestricted: true };
}

/**
 * Response shape of locations: the stored `photoKey` is internal, clients get `photoUrl` -- a short-lived signed media
 * URL (null if there is no photo or the file is gone). Only called after the route's own permission check.
 */
async function withPhotoUrls<T extends { photoKey: string | null }>(clubId: string, rows: T[]) {
  const urls = await signedMediaUrls(clubId, rows.map((r) => r.photoKey), "location");
  return rows.map(({ photoKey, ...rest }) => ({ ...rest, photoUrl: photoKey ? (urls.get(photoKey) ?? null) : null }));
}

/** Claims a freshly uploaded image for a location (inside the caller's transaction). */
function claimLocationPhoto(tx: Parameters<typeof attachUploadedImage>[0], clubId: string, userId: string, locationId: string, photoKey: string) {
  return attachUploadedImage(tx, { clubId, storageKey: photoKey, uploadedBy: userId, owner: { type: "location", id: locationId } });
}

const photoUrlRemoved = z.never({ error: "photoUrl is no longer accepted: upload the image via POST /media and send its key as photoKey" }).optional();

// --- Location CRUD -----------------------------------------------------------

/**
 * Key holders of a location with a display name, so clients need not load the member directory: `memberName` comes
 * from the linked `club_members` row (also for departed members), else from the newest key-history snapshot, else null.
 * Only call after the access-info permission check.
 */
async function loadKeyHolders(locationId: string, clubId: string) {
  const holders = await db.query.locationKeyHolders.findMany({ where: eq(locationKeyHolders.locationId, locationId) });
  if (holders.length === 0) return [];
  const memberIds = holders.map((h) => h.memberId);
  const names = await db
    .select({ memberId: clubMembers.memberId, displayName: clubMembers.displayName })
    .from(clubMembers)
    .where(and(eq(clubMembers.clubId, clubId), inArray(clubMembers.memberId, memberIds)));
  const byMember = new Map(names.map((n) => [n.memberId, n.displayName]));
  const snapshots = await db
    .select({ memberId: locationKeyHistory.memberId, memberName: locationKeyHistory.memberName })
    .from(locationKeyHistory)
    .where(and(eq(locationKeyHistory.locationId, locationId), inArray(locationKeyHistory.memberId, memberIds)))
    .orderBy(desc(locationKeyHistory.createdAt), desc(locationKeyHistory.id));
  const snapshotByMember = new Map<string, string>();
  for (const s of snapshots) if (s.memberId && !snapshotByMember.has(s.memberId)) snapshotByMember.set(s.memberId, s.memberName);
  return holders.map((h) => ({ ...h, memberName: byMember.get(h.memberId) ?? snapshotByMember.get(h.memberId) ?? null, keyLabel: h.keyLabel ?? null }));
}

locationRoutes.get("/", async (c) => {
  const clubId = c.get("clubId");
  const rows = await db.query.locations.findMany({
    where: eq(locations.clubId, clubId),
    orderBy: (l, { asc }) => [asc(l.name)],
  });
  const shaped = rows.map((row) => shapeLocation(row, c.get("clubRoleTypes")));
  return c.json({ data: await withPhotoUrls(clubId, shaped) });
});

locationRoutes.get("/:id", async (c) => {
  const clubId = c.get("clubId");
  const id = c.req.param("id");

  const row = await loadClubLocation(id, clubId);
  const roleTypes = c.get("clubRoleTypes");
  // Key holders are access info: only with locations:write / locations:read_access (otherwise an empty list + accessRestricted).
  const keyHolders = canReadAccess(roleTypes) ? await loadKeyHolders(id, clubId) : [];

  const [shaped] = await withPhotoUrls(clubId, [shapeLocation(row, roleTypes)]);
  return c.json({ data: { ...shaped, keyHolders } });
});

const createLocationSchema = z.object({
  name: z.string().min(1).max(300),
  address: z.string().optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  openingHours: z.string().optional(),
  photoKey: z.string().min(1).max(300).optional(),
  photoUrl: photoUrlRemoved,
  contactPerson: z.string().optional(),
  accessNote: z.string().optional(),
  bookable: z.boolean().optional(),
});

locationRoutes.post(
  "/",
  zValidator("json", createLocationSchema, (result) => {
    if (!result.success) throw new ValidationError("Invalid request body", { details: result.error.issues });
  }),
  async (c) => {
    const clubId = c.get("clubId");
    const roleTypes = c.get("clubRoleTypes");
    requireLocationsWrite(roleTypes);
    const body = c.req.valid("json");

    const row = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(locations)
        .values({
          clubId,
          name: body.name,
          address: body.address,
          latitude: body.latitude === undefined ? undefined : String(body.latitude),
          longitude: body.longitude === undefined ? undefined : String(body.longitude),
          openingHours: body.openingHours,
          photoKey: body.photoKey,
          contactPerson: body.contactPerson,
          accessNote: body.accessNote,
          bookable: body.bookable,
        })
        .returning();
      if (body.photoKey) await claimLocationPhoto(tx, clubId, c.get("user").id, created!.id, body.photoKey);
      await writeAudit(tx, { eventType: "location.create", subjectId: created!.id, payload: { clubId, name: created!.name } });
      return created!;
    });

    return c.json({ data: (await withPhotoUrls(clubId, [row]))[0] }, 201);
  },
);

const updateLocationSchema = z.object({
  name: z.string().min(1).max(300).optional(),
  address: z.string().nullable().optional(),
  latitude: z.number().nullable().optional(),
  longitude: z.number().nullable().optional(),
  openingHours: z.string().nullable().optional(),
  photoKey: z.string().min(1).max(300).nullable().optional(),
  photoUrl: photoUrlRemoved,
  contactPerson: z.string().nullable().optional(),
  accessNote: z.string().nullable().optional(),
  bookable: z.boolean().optional(),
});

locationRoutes.patch(
  "/:id",
  zValidator("json", updateLocationSchema, (result) => {
    if (!result.success) throw new ValidationError("Invalid request body", { details: result.error.issues });
  }),
  async (c) => {
    const clubId = c.get("clubId");
    const roleTypes = c.get("clubRoleTypes");
    requireLocationsWrite(roleTypes);
    const id = c.req.param("id");
    const body = c.req.valid("json");

    const existing = await loadClubLocation(id, clubId);

    const replaced = body.photoKey !== undefined && existing.photoKey !== null && existing.photoKey !== body.photoKey;
    let removedPhoto = false;
    const row = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(locations)
        .set({
          ...body,
          latitude: body.latitude === undefined ? undefined : body.latitude === null ? null : String(body.latitude),
          longitude: body.longitude === undefined ? undefined : body.longitude === null ? null : String(body.longitude),
          updatedAt: new Date(),
        })
        .where(and(eq(locations.id, id), eq(locations.clubId, clubId)))
        .returning();
      if (body.photoKey && body.photoKey !== existing.photoKey) await claimLocationPhoto(tx, clubId, c.get("user").id, id, body.photoKey);
      // A replaced / removed photo is deleted (registry tombstone now, file after the commit).
      if (replaced) removedPhoto = await markMediaDeleted(existing.photoKey!, tx, clubId);
      await writeAudit(tx, { eventType: "location.update", subjectId: id, payload: { clubId, changedFields: Object.keys(body) } });
      return updated!;
    });
    if (removedPhoto) await purgeMediaFile(existing.photoKey!);

    return c.json({ data: (await withPhotoUrls(clubId, [row]))[0] });
  },
);

locationRoutes.delete("/:id", async (c) => {
  const clubId = c.get("clubId");
  const roleTypes = c.get("clubRoleTypes");
  requireLocationsWrite(roleTypes);
  const id = c.req.param("id");

  const existing = await loadClubLocation(id, clubId);
  let removedPhoto = false;
  await db.transaction(async (tx) => {
    await tx.delete(locations).where(and(eq(locations.id, id), eq(locations.clubId, clubId)));
    if (existing.photoKey) removedPhoto = await markMediaDeleted(existing.photoKey, tx, clubId);
    await writeAudit(tx, { eventType: "location.delete", subjectId: id, payload: { clubId } });
  });
  if (removedPhoto) await purgeMediaFile(existing.photoKey!);

  return c.body(null, 204);
});

// --- Key holders ---------------------------------------------------------------

const createKeyHolderSchema = z.object({
  memberId: z.string().min(1),
  /** Which key/code is handed over ("Schluessel Nr. 3"); shown in the history. */
  keyLabel: z.string().trim().max(120).optional(),
  note: z.string().trim().max(500).optional(),
});

const returnKeySchema = z.object({ note: z.string().trim().max(500).optional() });

locationRoutes.post(
  "/:id/key-holders",
  zValidator("json", createKeyHolderSchema, (result) => {
    if (!result.success) throw new ValidationError("Invalid request body", { details: result.error.issues });
  }),
  async (c) => {
    const clubId = c.get("clubId");
    const roleTypes = c.get("clubRoleTypes");
    requireLocationsWrite(roleTypes);
    const id = c.req.param("id");
    const body = c.req.valid("json");

    const location = await loadClubLocation(id, clubId);

    const [holder] = await db
      .select({ id: member.id, name: user.name })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(and(eq(member.id, body.memberId), eq(member.organizationId, clubId)));
    if (!holder) throw new ValidationError("memberId is not a member of this club");

    // Holder row, history entry and audit entry commit together (a duplicate aborts all three).
    let row;
    let historyId = "";
    try {
      row = await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(locationKeyHolders)
          .values({ locationId: id, memberId: body.memberId, keyLabel: body.keyLabel || null })
          .returning();
        const [entry] = await tx.insert(locationKeyHistory).values({
          locationId: id,
          action: "issued",
          memberId: body.memberId,
          memberName: holder.name,
          keyLabel: body.keyLabel || null,
          note: body.note || null,
          recordedBy: c.get("membership").id,
          recordedByName: c.get("user").name,
        }).returning({ id: locationKeyHistory.id });
        historyId = entry!.id;
        await writeAudit(tx, {
          eventType: "location_key_holder.create",
          subjectId: created!.id,
          payload: { clubId, locationId: id, memberId: body.memberId },
        });
        return created!;
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictError("Member already holds a key for this location");
      }
      throw err;
    }
    await notifyHandover({ clubId, kind: "key.issued", refId: historyId, accountMemberId: body.memberId, actorAccountMemberId: c.get("membership").id, subject: location.name, keyLabel: row.keyLabel });

    return c.json({ data: row }, 201);
  },
);

// The optional return note is tiny; a hard cap keeps a hostile body from being buffered.
const returnBodyLimit = bodyLimit({
  maxSize: 4 * 1024,
  onError: () => {
    throw new ValidationError("Request body too large");
  },
});

locationRoutes.delete("/:id/key-holders/:memberId", returnBodyLimit, async (c) => {
  const clubId = c.get("clubId");
  const roleTypes = c.get("clubRoleTypes");
  requireLocationsWrite(roleTypes);
  const id = c.req.param("id");
  const memberId = c.req.param("memberId");

  const location = await loadClubLocation(id, clubId);

  // Optional JSON body { note } (a return note); no body or an empty one is fine.
  const raw = await c.req.text();
  let note: string | undefined;
  if (raw.trim() !== "") {
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(raw);
    } catch {
      throw new ValidationError("Invalid request body");
    }
    const parsed = returnKeySchema.safeParse(parsedBody);
    if (!parsed.success) throw new ValidationError("Invalid request body", { details: parsed.error.issues });
    note = parsed.data.note;
  }

  const existing = await db.query.locationKeyHolders.findFirst({
    where: and(eq(locationKeyHolders.locationId, id), eq(locationKeyHolders.memberId, memberId)),
  });
  if (!existing) throw new NotFoundError("Key holder not found");

  const historyId = await db.transaction(async (tx) => {
    const [holder] = await tx.select({ name: user.name }).from(member).innerJoin(user, eq(user.id, member.userId)).where(eq(member.id, memberId));
    const deleted = await tx.delete(locationKeyHolders).where(eq(locationKeyHolders.id, existing.id)).returning({ id: locationKeyHolders.id });
    // A parallel return already removed the row: do not log it twice.
    if (deleted.length === 0) throw new NotFoundError("Key holder not found");
    const [entry] = await tx.insert(locationKeyHistory).values({
      locationId: id,
      action: "returned",
      memberId,
      memberName: holder?.name ?? "",
      keyLabel: existing.keyLabel,
      note: note || null,
      recordedBy: c.get("membership").id,
      recordedByName: c.get("user").name,
    }).returning({ id: locationKeyHistory.id });
    await writeAudit(tx, {
      eventType: "location_key_holder.delete",
      subjectId: existing.id,
      payload: { clubId, locationId: id, memberId },
    });
    return entry!.id;
  });
  await notifyHandover({ clubId, kind: "key.returned", refId: historyId, accountMemberId: memberId, actorAccountMemberId: c.get("membership").id, subject: location.name, keyLabel: existing.keyLabel });

  return c.body(null, 204);
});

const keyHistoryQuerySchema = z.object({
  memberId: z.string().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 * Key history of a location, newest first: `{ data: [{ id, action: 'issued'|'returned', memberId, memberName, keyLabel,
 * note, recordedBy, recordedByName, createdAt }], page, pageSize, total }`. Access info like the key-holder list: needs
 * `locations:write` or `locations:read_access` (403 otherwise; external guests never).
 */
locationRoutes.get(
  "/:id/key-history",
  zValidator("query", keyHistoryQuerySchema, (result) => {
    if (!result.success) throw new ValidationError("Invalid query", { details: result.error.issues });
  }),
  async (c) => {
    const clubId = c.get("clubId");
    const id = c.req.param("id");
    const query = c.req.valid("query");
    if (c.get("membership").role === "guest" || !canReadAccess(c.get("clubRoleTypes"))) {
      throw new ForbiddenError("Missing locations:read_access permission");
    }

    await loadClubLocation(id, clubId);

    const where = and(eq(locationKeyHistory.locationId, id), query.memberId ? eq(locationKeyHistory.memberId, query.memberId) : undefined);
    const [totalRow] = await db.select({ n: count() }).from(locationKeyHistory).where(where);
    const rows = await db
      .select()
      .from(locationKeyHistory)
      .where(where)
      .orderBy(desc(locationKeyHistory.createdAt), desc(locationKeyHistory.id))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);

    return c.json({
      data: rows.map(({ locationId: _locationId, ...rest }) => rest),
      page: query.page,
      pageSize: query.pageSize,
      total: totalRow?.n ?? 0,
    });
  },
);

// --- WiFi networks --------------------------------------------------------------

locationRoutes.get("/:id/wifi", async (c) => {
  const clubId = c.get("clubId");
  const id = c.req.param("id");

  await loadClubLocation(id, clubId);

  const rows = await db.query.locationWifiNetworks.findMany({
    where: and(eq(locationWifiNetworks.locationId, id), inArray(locationWifiNetworks.visibility, readableVisibilities(c))),
  });
  return c.json({ data: rows.map(shapeWifi) });
});

const createWifiSchema = z.object({
  label: z.string().min(1).max(200),
  ssid: z.string().min(1).max(200),
  password: z.string().max(200).optional(), // empty / omitted without `security` = open network (QR uses T:nopass)
  security: securityField.optional(),
  visibility: visibilityField.optional(),
  visibleToGuests: z.boolean().optional(), // legacy alias: true -> gast, false -> mitglied
});

locationRoutes.post(
  "/:id/wifi",
  zValidator("json", createWifiSchema, (result) => {
    if (!result.success) throw new ValidationError("Invalid request body", { details: result.error.issues });
  }),
  async (c) => {
    const clubId = c.get("clubId");
    const roleTypes = c.get("clubRoleTypes");
    requireLocationsWrite(roleTypes);
    const id = c.req.param("id");
    const body = c.req.valid("json");

    await loadClubLocation(id, clubId);

    const credentials = resolveWifiSecurity(body);
    const [row] = await db
      .insert(locationWifiNetworks)
      .values({
        locationId: id,
        label: body.label,
        ssid: body.ssid,
        password: credentials.password,
        security: credentials.security,
        visibility: resolveVisibility(body),
      })
      .returning();

    await writeAudit(db, {
      eventType: "location_wifi.create",
      subjectId: row.id,
      payload: { clubId, locationId: id, label: row.label },
    });

    return c.json({ data: shapeWifi(row) }, 201);
  },
);

const updateWifiSchema = z.object({
  label: z.string().min(1).max(200).optional(),
  ssid: z.string().min(1).max(200).optional(),
  password: z.string().max(200).optional(),
  security: securityField.optional(),
  visibility: visibilityField.optional(),
  visibleToGuests: z.boolean().optional(),
});

locationRoutes.patch(
  "/:id/wifi/:wifiId",
  zValidator("json", updateWifiSchema, (result) => {
    if (!result.success) throw new ValidationError("Invalid request body", { details: result.error.issues });
  }),
  async (c) => {
    const clubId = c.get("clubId");
    const roleTypes = c.get("clubRoleTypes");
    requireLocationsWrite(roleTypes);
    const id = c.req.param("id");
    const wifiId = c.req.param("wifiId");
    const body = c.req.valid("json");

    await loadClubLocation(id, clubId);

    const existing = await db.query.locationWifiNetworks.findFirst({
      where: and(eq(locationWifiNetworks.id, wifiId), eq(locationWifiNetworks.locationId, id)),
    });
    if (!existing) throw new NotFoundError("WiFi network not found");

    // Only the fields that were sent; an update without any effective change (e.g. the legacy visibleToGuests=false on a
    // row that is not 'gast') leaves the row as it is.
    const touchesCredentials = body.password !== undefined || body.security !== undefined;
    const credentials = touchesCredentials ? resolveWifiSecurity(body, existing) : undefined;
    const changes = Object.fromEntries(
      Object.entries({ label: body.label, ssid: body.ssid, password: credentials?.password, security: credentials?.security, visibility: resolveVisibility(body, existing.visibility) }).filter(
        ([, v]) => v !== undefined,
      ),
    );
    const [row] = Object.keys(changes).length === 0 ? [existing] : await db.update(locationWifiNetworks).set(changes).where(eq(locationWifiNetworks.id, wifiId)).returning();

    await writeAudit(db, {
      eventType: "location_wifi.update",
      subjectId: wifiId,
      payload: { clubId, locationId: id, label: row.label },
    });

    return c.json({ data: shapeWifi(row) });
  },
);

locationRoutes.delete("/:id/wifi/:wifiId", async (c) => {
  const clubId = c.get("clubId");
  const roleTypes = c.get("clubRoleTypes");
  requireLocationsWrite(roleTypes);
  const id = c.req.param("id");
  const wifiId = c.req.param("wifiId");

  await loadClubLocation(id, clubId);

  const existing = await db.query.locationWifiNetworks.findFirst({
    where: and(eq(locationWifiNetworks.id, wifiId), eq(locationWifiNetworks.locationId, id)),
  });
  if (!existing) throw new NotFoundError("WiFi network not found");

  await db.delete(locationWifiNetworks).where(eq(locationWifiNetworks.id, wifiId));
  await writeAudit(db, {
    eventType: "location_wifi.delete",
    subjectId: wifiId,
    payload: { clubId, locationId: id },
  });

  return c.body(null, 204);
});

// --- Links -----------------------------------------------------------------------

locationRoutes.get("/:id/links", async (c) => {
  const clubId = c.get("clubId");
  const id = c.req.param("id");

  await loadClubLocation(id, clubId);

  const rows = await db.query.locationLinks.findMany({
    where: and(eq(locationLinks.locationId, id), inArray(locationLinks.visibility, readableVisibilities(c))),
  });
  return c.json({ data: rows.map(withLegacyGuestFlag) });
});

const createLinkSchema = z.object({
  title: z.string().min(1).max(200),
  url: z.string().url(),
  icon: z.string().optional(),
  visibility: visibilityField.optional(),
  visibleToGuests: z.boolean().optional(),
});

locationRoutes.post(
  "/:id/links",
  zValidator("json", createLinkSchema, (result) => {
    if (!result.success) throw new ValidationError("Invalid request body", { details: result.error.issues });
  }),
  async (c) => {
    const clubId = c.get("clubId");
    const roleTypes = c.get("clubRoleTypes");
    requireLocationsWrite(roleTypes);
    const id = c.req.param("id");
    const body = c.req.valid("json");

    await loadClubLocation(id, clubId);

    const [row] = await db
      .insert(locationLinks)
      .values({
        locationId: id,
        title: body.title,
        url: body.url,
        icon: body.icon,
        visibility: resolveVisibility(body),
      })
      .returning();

    await writeAudit(db, {
      eventType: "location_link.create",
      subjectId: row.id,
      payload: { clubId, locationId: id, title: row.title },
    });

    return c.json({ data: withLegacyGuestFlag(row) }, 201);
  },
);

const updateLinkSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  url: z.string().url().optional(),
  icon: z.string().nullable().optional(),
  visibility: visibilityField.optional(),
  visibleToGuests: z.boolean().optional(),
});

locationRoutes.patch(
  "/:id/links/:linkId",
  zValidator("json", updateLinkSchema, (result) => {
    if (!result.success) throw new ValidationError("Invalid request body", { details: result.error.issues });
  }),
  async (c) => {
    const clubId = c.get("clubId");
    const roleTypes = c.get("clubRoleTypes");
    requireLocationsWrite(roleTypes);
    const id = c.req.param("id");
    const linkId = c.req.param("linkId");
    const body = c.req.valid("json");

    await loadClubLocation(id, clubId);

    const existing = await db.query.locationLinks.findFirst({
      where: and(eq(locationLinks.id, linkId), eq(locationLinks.locationId, id)),
    });
    if (!existing) throw new NotFoundError("Link not found");

    const changes = Object.fromEntries(
      Object.entries({ title: body.title, url: body.url, icon: body.icon, visibility: resolveVisibility(body, existing.visibility) }).filter(([, v]) => v !== undefined),
    );
    const [row] = Object.keys(changes).length === 0 ? [existing] : await db.update(locationLinks).set(changes).where(eq(locationLinks.id, linkId)).returning();

    await writeAudit(db, {
      eventType: "location_link.update",
      subjectId: linkId,
      payload: { clubId, locationId: id, changedFields: Object.keys(body) },
    });

    return c.json({ data: withLegacyGuestFlag(row) });
  },
);

locationRoutes.delete("/:id/links/:linkId", async (c) => {
  const clubId = c.get("clubId");
  const roleTypes = c.get("clubRoleTypes");
  requireLocationsWrite(roleTypes);
  const id = c.req.param("id");
  const linkId = c.req.param("linkId");

  await loadClubLocation(id, clubId);

  const existing = await db.query.locationLinks.findFirst({
    where: and(eq(locationLinks.id, linkId), eq(locationLinks.locationId, id)),
  });
  if (!existing) throw new NotFoundError("Link not found");

  await db.delete(locationLinks).where(eq(locationLinks.id, linkId));
  await writeAudit(db, {
    eventType: "location_link.delete",
    subjectId: linkId,
    payload: { clubId, locationId: id },
  });

  return c.body(null, 204);
});

// Wave 12 B19: occupancy plan and bookings of bookable locations (session + club guard come from this router).
locationRoutes.route("/", locationBookingRoutes);
