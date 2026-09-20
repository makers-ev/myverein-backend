import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { inventoryDamageReports, inventoryItems, inventoryLoans } from "../db/schema/inventory.js";
import { locations } from "../db/schema/locations.js";
import { hasClubPermission } from "../lib/club-permissions.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import { effectiveLoanStatus, isMaintenanceDue, maintenanceDueDate } from "../lib/inventory-status.js";
import { clubGuard, type ClubEnv } from "../middleware/club-guard.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { sessionGuard } from "../middleware/session-guard.js";

export const inventoryItemRoutes = new Hono<ClubEnv>();

inventoryItemRoutes.use("*", rateLimit({ windowMs: 60_000, max: 60 }));
inventoryItemRoutes.use("*", sessionGuard);
inventoryItemRoutes.use("*", clubGuard);

/** Loads an inventory item scoped to `clubId` only. 404s (never 403) on a wrong-club or missing id. */
async function loadClubInventoryItem(id: string, clubId: string) {
  const row = await db.query.inventoryItems.findFirst({ where: and(eq(inventoryItems.id, id), eq(inventoryItems.clubId, clubId)) });
  if (!row) throw new NotFoundError("Inventory item not found");
  return row;
}

function requireInventoryWrite(roleTypes: readonly string[]) {
  if (!hasClubPermission(roleTypes, "inventory:write")) {
    throw new ForbiddenError("Missing inventory:write permission");
  }
}

/** Validates that `locationId` belongs to this club (same check as locations.ts's own key-holder validation). */
async function assertLocationInClub(locationId: string, clubId: string) {
  const location = await db.query.locations.findFirst({ where: and(eq(locations.id, locationId), eq(locations.clubId, clubId)) });
  if (!location) throw new ValidationError("locationId is not a location of this club");
}

/** Adds the live-derived maintenance status -- never stored, see lib/inventory-status.ts. */
function withMaintenanceStatus<T extends { maintenanceIntervalDays: number | null; lastMaintenanceAt: string | null; acquiredAt: string | null }>(
  item: T,
) {
  return { ...item, maintenanceDue: isMaintenanceDue(item, new Date()), maintenanceDueAt: maintenanceDueDate(item) };
}

/** Adds the live-derived "ueberfaellig" override -- never stored, see lib/inventory-status.ts. */
function withEffectiveLoanStatus<T extends { dueAt: Date | null; returnedAt: Date | null; status: string }>(loan: T) {
  return { ...loan, status: effectiveLoanStatus(loan, new Date()) };
}

// --- Inventory item CRUD -----------------------------------------------------------

inventoryItemRoutes.get("/", async (c) => {
  const clubId = c.get("clubId");
  const locationId = c.req.query("locationId");
  const category = c.req.query("category");

  const conditions = [eq(inventoryItems.clubId, clubId)];
  if (locationId) conditions.push(eq(inventoryItems.locationId, locationId));
  if (category) conditions.push(eq(inventoryItems.category, category));

  const rows = await db.query.inventoryItems.findMany({
    where: and(...conditions),
    orderBy: (i, { asc }) => [asc(i.name)],
  });
  return c.json({ data: rows.map(withMaintenanceStatus) });
});

inventoryItemRoutes.get("/:id", async (c) => {
  const clubId = c.get("clubId");
  const id = c.req.param("id");

  const row = await loadClubInventoryItem(id, clubId);
  return c.json({ data: withMaintenanceStatus(row) });
});

const createInventoryItemSchema = z.object({
  name: z.string().min(1).max(300),
  category: z.string().optional(),
  condition: z.string().min(1).max(100),
  locationId: z.string().uuid().optional(),
  acquisitionValueCents: z.number().int().nonnegative().optional(),
  acquiredAt: z.string().date().optional(),
  maintenanceIntervalDays: z.number().int().positive().optional(),
  lastMaintenanceAt: z.string().date().optional(),
});

inventoryItemRoutes.post(
  "/",
  zValidator("json", createInventoryItemSchema, (result) => {
    if (!result.success) throw new ValidationError("Invalid request body", { details: result.error.issues });
  }),
  async (c) => {
    const clubId = c.get("clubId");
    const roleTypes = c.get("clubRoleTypes");
    requireInventoryWrite(roleTypes);
    const body = c.req.valid("json");

    if (body.locationId) await assertLocationInClub(body.locationId, clubId);

    const [row] = await db
      .insert(inventoryItems)
      .values({
        clubId,
        name: body.name,
        category: body.category,
        condition: body.condition,
        locationId: body.locationId,
        acquisitionValueCents: body.acquisitionValueCents,
        acquiredAt: body.acquiredAt,
        maintenanceIntervalDays: body.maintenanceIntervalDays,
        lastMaintenanceAt: body.lastMaintenanceAt,
      })
      .returning();

    await db.insert(auditLog).values({ eventType: "inventory_item.create", subjectId: row.id, payload: { clubId, name: row.name } });

    return c.json({ data: withMaintenanceStatus(row) }, 201);
  },
);

const updateInventoryItemSchema = z.object({
  name: z.string().min(1).max(300).optional(),
  category: z.string().nullable().optional(),
  condition: z.string().min(1).max(100).optional(),
  locationId: z.string().uuid().nullable().optional(),
  acquisitionValueCents: z.number().int().nonnegative().nullable().optional(),
  acquiredAt: z.string().date().nullable().optional(),
  maintenanceIntervalDays: z.number().int().positive().nullable().optional(),
  lastMaintenanceAt: z.string().date().nullable().optional(),
});

inventoryItemRoutes.patch(
  "/:id",
  zValidator("json", updateInventoryItemSchema, (result) => {
    if (!result.success) throw new ValidationError("Invalid request body", { details: result.error.issues });
  }),
  async (c) => {
    const clubId = c.get("clubId");
    const roleTypes = c.get("clubRoleTypes");
    requireInventoryWrite(roleTypes);
    const id = c.req.param("id");
    const body = c.req.valid("json");

    await loadClubInventoryItem(id, clubId);

    if (body.locationId) await assertLocationInClub(body.locationId, clubId);

    const [row] = await db
      .update(inventoryItems)
      .set({ ...body, updatedAt: new Date() })
      .where(and(eq(inventoryItems.id, id), eq(inventoryItems.clubId, clubId)))
      .returning();

    await db.insert(auditLog).values({ eventType: "inventory_item.update", subjectId: id, payload: { clubId, changes: body } });

    return c.json({ data: withMaintenanceStatus(row) });
  },
);

inventoryItemRoutes.delete("/:id", async (c) => {
  const clubId = c.get("clubId");
  const roleTypes = c.get("clubRoleTypes");
  requireInventoryWrite(roleTypes);
  const id = c.req.param("id");

  await loadClubInventoryItem(id, clubId);

  await db.delete(inventoryItems).where(and(eq(inventoryItems.id, id), eq(inventoryItems.clubId, clubId)));
  await db.insert(auditLog).values({ eventType: "inventory_item.delete", subjectId: id, payload: { clubId } });

  return c.body(null, 204);
});

// --- Loans (self-service borrow/return) -----------------------------------------------------------

inventoryItemRoutes.get("/:id/loans", async (c) => {
  const clubId = c.get("clubId");
  const id = c.req.param("id");

  await loadClubInventoryItem(id, clubId);

  const rows = await db.query.inventoryLoans.findMany({
    where: eq(inventoryLoans.itemId, id),
    orderBy: (l, { desc }) => [desc(l.borrowedAt)],
  });
  return c.json({ data: rows.map(withEffectiveLoanStatus) });
});

const createLoanSchema = z.object({
  dueAt: z.string().datetime().optional(),
});

inventoryItemRoutes.post(
  "/:id/loans",
  zValidator("json", createLoanSchema, (result) => {
    if (!result.success) throw new ValidationError("Invalid request body", { details: result.error.issues });
  }),
  async (c) => {
    const clubId = c.get("clubId");
    const membership = c.get("membership");
    const id = c.req.param("id");
    const body = c.req.valid("json");

    await loadClubInventoryItem(id, clubId);

    const [row] = await db
      .insert(inventoryLoans)
      .values({
        itemId: id,
        memberId: membership.id,
        borrowedAt: new Date(),
        dueAt: body.dueAt ? new Date(body.dueAt) : undefined,
      })
      .returning();

    await db.insert(auditLog).values({
      eventType: "inventory_loan.create",
      subjectId: row.id,
      payload: { clubId, itemId: id, memberId: membership.id },
    });

    return c.json({ data: withEffectiveLoanStatus(row) }, 201);
  },
);

inventoryItemRoutes.patch("/:id/loans/:loanId", async (c) => {
  const clubId = c.get("clubId");
  const roleTypes = c.get("clubRoleTypes");
  const membership = c.get("membership");
  const id = c.req.param("id");
  const loanId = c.req.param("loanId");

  await loadClubInventoryItem(id, clubId);

  const existing = await db.query.inventoryLoans.findFirst({ where: and(eq(inventoryLoans.id, loanId), eq(inventoryLoans.itemId, id)) });
  if (!existing) throw new NotFoundError("Loan not found");

  const isBorrower = existing.memberId === membership.id;
  if (!isBorrower && !hasClubPermission(roleTypes, "inventory:write")) {
    throw new ForbiddenError("Missing inventory:write permission");
  }

  if (existing.returnedAt) throw new ConflictError("Loan has already been returned");

  const [row] = await db
    .update(inventoryLoans)
    .set({ returnedAt: new Date(), status: "zurueckgegeben" })
    .where(eq(inventoryLoans.id, loanId))
    .returning();

  await db.insert(auditLog).values({
    eventType: "inventory_loan.return",
    subjectId: loanId,
    payload: { clubId, itemId: id, memberId: existing.memberId },
  });

  return c.json({ data: withEffectiveLoanStatus(row) });
});

// --- Damage reports -----------------------------------------------------------

function withPhotoUrl<T extends { photoUrl: string | null }>(row: T): T & { photoUrl: string | null } {
  return { ...row, photoUrl: row.photoUrl ? `/media/${row.photoUrl}` : null };
}

inventoryItemRoutes.get("/:id/damage-reports", async (c) => {
  const clubId = c.get("clubId");
  const id = c.req.param("id");

  await loadClubInventoryItem(id, clubId);

  const rows = await db.query.inventoryDamageReports.findMany({
    where: eq(inventoryDamageReports.itemId, id),
    orderBy: (r, { desc }) => [desc(r.createdAt)],
  });
  return c.json({ data: rows.map(withPhotoUrl) });
});

const createDamageReportSchema = z.object({
  description: z.string().min(1).max(2000),
  photoKey: z.string().min(1).optional(),
});

inventoryItemRoutes.post(
  "/:id/damage-reports",
  zValidator("json", createDamageReportSchema, (result) => {
    if (!result.success) throw new ValidationError("Invalid request body", { details: result.error.issues });
  }),
  async (c) => {
    const clubId = c.get("clubId");
    const membership = c.get("membership");
    const id = c.req.param("id");
    const body = c.req.valid("json");

    await loadClubInventoryItem(id, clubId);

    // Same club-prefix shape as a real /media key ("<clubId>/..."), mirroring
    // the locationId check above -- GET /media/:key independently re-checks
    // this at read time too, but rejecting an obviously-foreign key up front
    // keeps a garbage/wrong-club value out of the row in the first place.
    if (body.photoKey && !body.photoKey.startsWith(`${clubId}/`)) {
      throw new ValidationError("photoKey is not a media key of this club");
    }

    const [row] = await db
      .insert(inventoryDamageReports)
      .values({
        itemId: id,
        reportedBy: membership.id,
        description: body.description,
        photoUrl: body.photoKey,
      })
      .returning();

    await db.insert(auditLog).values({
      eventType: "inventory_damage_report.create",
      subjectId: row.id,
      payload: { clubId, itemId: id, memberId: membership.id },
    });

    return c.json({ data: withPhotoUrl(row) }, 201);
  },
);

const updateDamageReportSchema = z.object({
  status: z.enum(["gemeldet", "in_bearbeitung", "behoben"]),
});

inventoryItemRoutes.patch(
  "/:id/damage-reports/:reportId",
  zValidator("json", updateDamageReportSchema, (result) => {
    if (!result.success) throw new ValidationError("Invalid request body", { details: result.error.issues });
  }),
  async (c) => {
    const clubId = c.get("clubId");
    const roleTypes = c.get("clubRoleTypes");
    requireInventoryWrite(roleTypes);
    const id = c.req.param("id");
    const reportId = c.req.param("reportId");
    const body = c.req.valid("json");

    await loadClubInventoryItem(id, clubId);

    const existing = await db.query.inventoryDamageReports.findFirst({
      where: and(eq(inventoryDamageReports.id, reportId), eq(inventoryDamageReports.itemId, id)),
    });
    if (!existing) throw new NotFoundError("Damage report not found");

    const [row] = await db
      .update(inventoryDamageReports)
      .set({ status: body.status, resolvedAt: body.status === "behoben" ? new Date() : null })
      .where(eq(inventoryDamageReports.id, reportId))
      .returning();

    await db.insert(auditLog).values({
      eventType: "inventory_damage_report.update",
      subjectId: reportId,
      payload: { clubId, itemId: id, status: body.status },
    });

    return c.json({ data: withPhotoUrl(row) });
  },
);
