import { zValidator } from "@hono/zod-validator";
import { and, eq, inArray } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";

import { member } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { locationLinks } from "../db/schema/location-links.js";
import { locationWifiNetworks } from "../db/schema/location-wifi.js";
import { LOCATION_VISIBILITIES, locationKeyHolders, locations, type LocationRow, type LocationVisibility } from "../db/schema/locations.js";
import { hasClubPermission } from "../lib/club-permissions.js";
import { ConflictError, ForbiddenError, isUniqueViolation, NotFoundError, ValidationError } from "../lib/errors.js";
import { clubGuard, type ClubEnv } from "../middleware/club-guard.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { sessionGuard } from "../middleware/session-guard.js";

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

/** Legacy clients send `visibleToGuests`; `visibility` wins if both are present. */
function resolveVisibility(body: { visibility?: LocationVisibility; visibleToGuests?: boolean }): LocationVisibility | undefined {
  if (body.visibility !== undefined) return body.visibility;
  if (body.visibleToGuests === undefined) return undefined;
  return body.visibleToGuests ? "gast" : "mitglied";
}

const visibilityField = z.enum(LOCATION_VISIBILITIES);

/** Strips access info (access note) from a location when the caller lacks access rights; shape stays stable. */
function shapeLocation(row: LocationRow, roleTypes: readonly string[]) {
  if (canReadAccess(roleTypes)) return { ...row, accessRestricted: false };
  return { ...row, accessNote: null, accessRestricted: true };
}

// --- Location CRUD -----------------------------------------------------------

locationRoutes.get("/", async (c) => {
  const clubId = c.get("clubId");
  const rows = await db.query.locations.findMany({
    where: eq(locations.clubId, clubId),
    orderBy: (l, { asc }) => [asc(l.name)],
  });
  return c.json({ data: rows.map((row) => shapeLocation(row, c.get("clubRoleTypes"))) });
});

locationRoutes.get("/:id", async (c) => {
  const clubId = c.get("clubId");
  const id = c.req.param("id");

  const row = await loadClubLocation(id, clubId);
  const roleTypes = c.get("clubRoleTypes");
  // Key holders are access info: only with locations:write / locations:read_access (otherwise an empty list + accessRestricted).
  const keyHolders = canReadAccess(roleTypes)
    ? await db.query.locationKeyHolders.findMany({ where: eq(locationKeyHolders.locationId, id) })
    : [];

  return c.json({ data: { ...shapeLocation(row, roleTypes), keyHolders } });
});

const createLocationSchema = z.object({
  name: z.string().min(1).max(300),
  address: z.string().optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  openingHours: z.string().optional(),
  photoUrl: z.string().optional(),
  contactPerson: z.string().optional(),
  accessNote: z.string().optional(),
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

    const [row] = await db
      .insert(locations)
      .values({
        clubId,
        name: body.name,
        address: body.address,
        latitude: body.latitude === undefined ? undefined : String(body.latitude),
        longitude: body.longitude === undefined ? undefined : String(body.longitude),
        openingHours: body.openingHours,
        photoUrl: body.photoUrl,
        contactPerson: body.contactPerson,
        accessNote: body.accessNote,
      })
      .returning();

    await db.insert(auditLog).values({ eventType: "location.create", subjectId: row.id, payload: { clubId, name: row.name } });

    return c.json({ data: row }, 201);
  },
);

const updateLocationSchema = z.object({
  name: z.string().min(1).max(300).optional(),
  address: z.string().nullable().optional(),
  latitude: z.number().nullable().optional(),
  longitude: z.number().nullable().optional(),
  openingHours: z.string().nullable().optional(),
  photoUrl: z.string().nullable().optional(),
  contactPerson: z.string().nullable().optional(),
  accessNote: z.string().nullable().optional(),
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

    await loadClubLocation(id, clubId);

    const [row] = await db
      .update(locations)
      .set({
        ...body,
        latitude: body.latitude === undefined ? undefined : body.latitude === null ? null : String(body.latitude),
        longitude: body.longitude === undefined ? undefined : body.longitude === null ? null : String(body.longitude),
        updatedAt: new Date(),
      })
      .where(and(eq(locations.id, id), eq(locations.clubId, clubId)))
      .returning();

    await db.insert(auditLog).values({ eventType: "location.update", subjectId: id, payload: { clubId, changes: body } });

    return c.json({ data: row });
  },
);

locationRoutes.delete("/:id", async (c) => {
  const clubId = c.get("clubId");
  const roleTypes = c.get("clubRoleTypes");
  requireLocationsWrite(roleTypes);
  const id = c.req.param("id");

  await loadClubLocation(id, clubId);

  await db.delete(locations).where(and(eq(locations.id, id), eq(locations.clubId, clubId)));
  await db.insert(auditLog).values({ eventType: "location.delete", subjectId: id, payload: { clubId } });

  return c.body(null, 204);
});

// --- Key holders ---------------------------------------------------------------

const createKeyHolderSchema = z.object({
  memberId: z.string().min(1),
});

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

    await loadClubLocation(id, clubId);

    const holderMember = await db.query.member.findFirst({ where: and(eq(member.id, body.memberId), eq(member.organizationId, clubId)) });
    if (!holderMember) throw new ValidationError("memberId is not a member of this club");

    let row;
    try {
      [row] = await db.insert(locationKeyHolders).values({ locationId: id, memberId: body.memberId }).returning();
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictError("Member already holds a key for this location");
      }
      throw err;
    }

    await db.insert(auditLog).values({
      eventType: "location_key_holder.create",
      subjectId: row.id,
      payload: { clubId, locationId: id, memberId: body.memberId },
    });

    return c.json({ data: row }, 201);
  },
);

locationRoutes.delete("/:id/key-holders/:memberId", async (c) => {
  const clubId = c.get("clubId");
  const roleTypes = c.get("clubRoleTypes");
  requireLocationsWrite(roleTypes);
  const id = c.req.param("id");
  const memberId = c.req.param("memberId");

  await loadClubLocation(id, clubId);

  const existing = await db.query.locationKeyHolders.findFirst({
    where: and(eq(locationKeyHolders.locationId, id), eq(locationKeyHolders.memberId, memberId)),
  });
  if (!existing) throw new NotFoundError("Key holder not found");

  await db.delete(locationKeyHolders).where(eq(locationKeyHolders.id, existing.id));
  await db.insert(auditLog).values({
    eventType: "location_key_holder.delete",
    subjectId: existing.id,
    payload: { clubId, locationId: id, memberId },
  });

  return c.body(null, 204);
});

// --- WiFi networks --------------------------------------------------------------

locationRoutes.get("/:id/wifi", async (c) => {
  const clubId = c.get("clubId");
  const id = c.req.param("id");

  await loadClubLocation(id, clubId);

  const rows = await db.query.locationWifiNetworks.findMany({
    where: and(eq(locationWifiNetworks.locationId, id), inArray(locationWifiNetworks.visibility, readableVisibilities(c))),
  });
  return c.json({ data: rows.map(withLegacyGuestFlag) });
});

const createWifiSchema = z.object({
  label: z.string().min(1).max(200),
  ssid: z.string().min(1).max(200),
  password: z.string().default(""), // empty = open network (QR uses T:nopass)
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

    const [row] = await db
      .insert(locationWifiNetworks)
      .values({
        locationId: id,
        label: body.label,
        ssid: body.ssid,
        password: body.password,
        visibility: resolveVisibility(body),
      })
      .returning();

    await db.insert(auditLog).values({
      eventType: "location_wifi.create",
      subjectId: row.id,
      payload: { clubId, locationId: id, label: row.label },
    });

    return c.json({ data: withLegacyGuestFlag(row) }, 201);
  },
);

const updateWifiSchema = z.object({
  label: z.string().min(1).max(200).optional(),
  ssid: z.string().min(1).max(200).optional(),
  password: z.string().optional(),
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

    const [row] = await db
      .update(locationWifiNetworks)
      .set({ label: body.label, ssid: body.ssid, password: body.password, visibility: resolveVisibility(body) })
      .where(eq(locationWifiNetworks.id, wifiId))
      .returning();

    await db.insert(auditLog).values({
      eventType: "location_wifi.update",
      subjectId: wifiId,
      payload: { clubId, locationId: id, label: row.label },
    });

    return c.json({ data: withLegacyGuestFlag(row) });
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
  await db.insert(auditLog).values({
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

    await db.insert(auditLog).values({
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

    const [row] = await db
      .update(locationLinks)
      .set({ title: body.title, url: body.url, icon: body.icon, visibility: resolveVisibility(body) })
      .where(eq(locationLinks.id, linkId))
      .returning();

    await db.insert(auditLog).values({
      eventType: "location_link.update",
      subjectId: linkId,
      payload: { clubId, locationId: id, changes: body },
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
  await db.insert(auditLog).values({
    eventType: "location_link.delete",
    subjectId: linkId,
    payload: { clubId, locationId: id },
  });

  return c.body(null, 204);
});
