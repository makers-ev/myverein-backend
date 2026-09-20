import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { organization, user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { locations } from "../db/schema/locations.js";
import { toAppError } from "../lib/errors.js";
import { inventoryItemRoutes } from "./inventory-items.js";

/**
 * Integration test against a real Postgres (DATABASE_URL), following
 * locations.test.ts's / events.test.ts's pattern: real sign-up/sign-in/
 * createOrganization, no mocking. Covers inventory item CRUD scoping,
 * cross-club IDOR (404), inventory:write permission gating on item
 * mutations, locationId cross-club validation, self-service loan
 * create/return (borrower-or-inventory:write on return, double-return
 * conflict), and self-service damage report create + inventory:write-gated
 * status updates.
 */

const app = new Hono();
app.route("/inventory-items", inventoryItemRoutes);
app.onError((err, c) => {
  const appError = toAppError(err);
  return c.json(appError.toJSON(), appError.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503);
});

const suffix = Date.now();

async function signUpAndVerify(email: string, name: string) {
  const { user: created } = await auth.api.createUser({
    body: { email, password: "test-password-123!", name },
  });
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, created.id));
  const signIn = await auth.api.signInEmail({ body: { email, password: "test-password-123!" }, asResponse: true });
  const cookie = signIn.headers.get("set-cookie") ?? "";
  return { userId: created.id, cookie: cookie.split(";")[0] };
}

describe("inventory-items routes", () => {
  let clubAId: string;
  let clubBId: string;
  let userIds: string[] = [];
  let cookieBoard: string;
  let cookieMember1: string;
  let cookieMember2: string;
  let cookieB: string;
  let member1Id: string;
  let member2Id: string;
  let clubALocationId: string;
  let clubBLocationId: string;

  beforeAll(async () => {
    const board = await signUpAndVerify(`inv-board-${suffix}@example.com`, "Board Founder");
    const m1 = await signUpAndVerify(`inv-m1-${suffix}@example.com`, "Member One");
    const m2 = await signUpAndVerify(`inv-m2-${suffix}@example.com`, "Member Two");
    const bFounder = await signUpAndVerify(`inv-b-${suffix}@example.com`, "Club B Founder");
    userIds = [board.userId, m1.userId, m2.userId, bFounder.userId];

    cookieBoard = board.cookie;
    cookieMember1 = m1.cookie;
    cookieMember2 = m2.cookie;
    cookieB = bFounder.cookie;

    const clubA = await auth.api.createOrganization({
      body: { name: `Inventory Club A ${suffix}`, slug: `inventory-club-a-${suffix}`, userId: board.userId },
    });
    const clubB = await auth.api.createOrganization({
      body: { name: `Inventory Club B ${suffix}`, slug: `inventory-club-b-${suffix}`, userId: bFounder.userId },
    });
    clubAId = clubA!.id;
    clubBId = clubB!.id;

    await auth.api.addMember({ body: { userId: m1.userId, organizationId: clubAId, role: "member" } });
    await auth.api.addMember({ body: { userId: m2.userId, organizationId: clubAId, role: "member" } });

    const boardMember = await db.query.member.findFirst({ where: (m, { and, eq }) => and(eq(m.organizationId, clubAId), eq(m.userId, board.userId)) });
    const member1 = await db.query.member.findFirst({ where: (m, { and, eq }) => and(eq(m.organizationId, clubAId), eq(m.userId, m1.userId)) });
    const member2 = await db.query.member.findFirst({ where: (m, { and, eq }) => and(eq(m.organizationId, clubAId), eq(m.userId, m2.userId)) });
    member1Id = member1!.id;
    member2Id = member2!.id;

    // Grants boardMember inventory:write, so cookieBoard acts as the "board"
    // caller throughout; cookieMember1/cookieMember2 stay non-privileged.
    await db.insert(clubRoles).values({ memberId: boardMember!.id, roleType: "vorsitz" });

    const [locA] = await db.insert(locations).values({ clubId: clubAId, name: "Lager A" }).returning();
    const [locB] = await db.insert(locations).values({ clubId: clubBId, name: "Lager B" }).returning();
    clubALocationId = locA.id;
    clubBLocationId = locB.id;
  }, 30_000);

  afterAll(async () => {
    await db.delete(organization).where(eq(organization.id, clubAId));
    await db.delete(organization).where(eq(organization.id, clubBId));
    for (const id of userIds) {
      await db.delete(user).where(eq(user.id, id));
    }
    await closeDatabase();
  });

  it("rejects an unauthenticated request with 401", async () => {
    const res = await app.request(`/inventory-items?clubId=${clubAId}`);
    expect(res.status).toBe(401);
  });

  // --- Item CRUD -----------------------------------------------------------

  let itemId: string;

  it("rejects POST / from a member without inventory:write", async () => {
    const res = await app.request(`/inventory-items?clubId=${clubAId}`, {
      method: "POST",
      headers: { cookie: cookieMember1, "content-type": "application/json" },
      body: JSON.stringify({ name: "Illegal Beamer", condition: "gut" }),
    });
    expect(res.status).toBe(403);
  });

  it("returns 422 creating an item with a locationId from another club", async () => {
    const res = await app.request(`/inventory-items?clubId=${clubAId}`, {
      method: "POST",
      headers: { cookie: cookieBoard, "content-type": "application/json" },
      body: JSON.stringify({ name: "Beamer", condition: "gut", locationId: clubBLocationId }),
    });
    expect(res.status).toBe(422);
  });

  it("creates an inventory item with inventory:write", async () => {
    const res = await app.request(`/inventory-items?clubId=${clubAId}`, {
      method: "POST",
      headers: { cookie: cookieBoard, "content-type": "application/json" },
      body: JSON.stringify({
        name: "Beamer",
        category: "technik",
        condition: "gut",
        locationId: clubALocationId,
        acquisitionValueCents: 45000,
        acquiredAt: "2024-05-01",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string; name: string; category: string; locationId: string } };
    expect(body.data.name).toBe("Beamer");
    expect(body.data.category).toBe("technik");
    expect(body.data.locationId).toBe(clubALocationId);
    itemId = body.data.id;
  });

  it("lists the club's inventory items, filterable by locationId and category", async () => {
    const res = await app.request(`/inventory-items?clubId=${clubAId}`, { headers: { cookie: cookieBoard } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.some((i) => i.id === itemId)).toBe(true);

    const filteredRes = await app.request(`/inventory-items?clubId=${clubAId}&locationId=${clubALocationId}&category=technik`, {
      headers: { cookie: cookieBoard },
    });
    const filteredBody = (await filteredRes.json()) as { data: Array<{ id: string }> };
    expect(filteredBody.data.some((i) => i.id === itemId)).toBe(true);

    const emptyRes = await app.request(`/inventory-items?clubId=${clubAId}&category=nonexistent`, { headers: { cookie: cookieBoard } });
    const emptyBody = (await emptyRes.json()) as { data: Array<{ id: string }> };
    expect(emptyBody.data.some((i) => i.id === itemId)).toBe(false);
  });

  it("returns 404 (cross-club IDOR) for GET /:id under the wrong club", async () => {
    const res = await app.request(`/inventory-items/${itemId}?clubId=${clubBId}`, { headers: { cookie: cookieB } });
    expect(res.status).toBe(404);
  });

  it("returns the item under its own club", async () => {
    const res = await app.request(`/inventory-items/${itemId}?clubId=${clubAId}`, { headers: { cookie: cookieBoard } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toBe(itemId);
  });

  it("rejects PATCH /:id from a member without inventory:write", async () => {
    const res = await app.request(`/inventory-items/${itemId}?clubId=${clubAId}`, {
      method: "PATCH",
      headers: { cookie: cookieMember1, "content-type": "application/json" },
      body: JSON.stringify({ name: "Hacked" }),
    });
    expect(res.status).toBe(403);
  });

  it("returns 422 updating an item's locationId to another club's location", async () => {
    const res = await app.request(`/inventory-items/${itemId}?clubId=${clubAId}`, {
      method: "PATCH",
      headers: { cookie: cookieBoard, "content-type": "application/json" },
      body: JSON.stringify({ locationId: clubBLocationId }),
    });
    expect(res.status).toBe(422);
  });

  it("updates an inventory item with inventory:write, unsetting locationId", async () => {
    const res = await app.request(`/inventory-items/${itemId}?clubId=${clubAId}`, {
      method: "PATCH",
      headers: { cookie: cookieBoard, "content-type": "application/json" },
      body: JSON.stringify({ condition: "beschaedigt", locationId: null }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { condition: string; locationId: string | null } };
    expect(body.data.condition).toBe("beschaedigt");
    expect(body.data.locationId).toBeNull();
  });

  // --- Loans -----------------------------------------------------------

  describe("loans", () => {
    let loan1Id: string;
    let loan2Id: string;

    it("lets any club member borrow the item for themselves", async () => {
      // No body at all (dueAt is optional) -- deliberately no content-type
      // header either, matching how a real client omits it when there's no
      // body to send (see events.test.ts's bodyless RSVP POST for the same
      // pattern); hono/zod-validator only parses "json" when a
      // Content-Type: application/json header is actually present.
      const res = await app.request(`/inventory-items/${itemId}/loans?clubId=${clubAId}`, {
        method: "POST",
        headers: { cookie: cookieMember1 },
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { data: { id: string; memberId: string; status: string; returnedAt: string | null } };
      expect(body.data.memberId).toBe(member1Id);
      expect(body.data.status).toBe("ausgeliehen");
      expect(body.data.returnedAt).toBeNull();
      loan1Id = body.data.id;
    });

    it("creates a second loan for the same member (used to test self-return below)", async () => {
      const res = await app.request(`/inventory-items/${itemId}/loans?clubId=${clubAId}`, {
        method: "POST",
        headers: { cookie: cookieMember1, "content-type": "application/json" },
        body: JSON.stringify({ dueAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { data: { id: string; dueAt: string | null } };
      expect(body.data.dueAt).not.toBeNull();
      loan2Id = body.data.id;
    });

    it("lists loans for the item, newest first", async () => {
      const res = await app.request(`/inventory-items/${itemId}/loans?clubId=${clubAId}`, { headers: { cookie: cookieBoard } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Array<{ id: string }> };
      expect(body.data[0]?.id).toBe(loan2Id);
      expect(body.data.map((l) => l.id)).toContain(loan1Id);
    });

    it("rejects a third member returning someone else's loan without inventory:write", async () => {
      const res = await app.request(`/inventory-items/${itemId}/loans/${loan1Id}?clubId=${clubAId}`, {
        method: "PATCH",
        headers: { cookie: cookieMember2 },
      });
      expect(res.status).toBe(403);
    });

    it("lets the borrower return their own loan", async () => {
      const res = await app.request(`/inventory-items/${itemId}/loans/${loan2Id}?clubId=${clubAId}`, {
        method: "PATCH",
        headers: { cookie: cookieMember1 },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { status: string; returnedAt: string | null } };
      expect(body.data.status).toBe("zurueckgegeben");
      expect(body.data.returnedAt).not.toBeNull();
    });

    it("lets a board member (inventory:write) process a return on someone else's behalf", async () => {
      const res = await app.request(`/inventory-items/${itemId}/loans/${loan1Id}?clubId=${clubAId}`, {
        method: "PATCH",
        headers: { cookie: cookieBoard },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { status: string } };
      expect(body.data.status).toBe("zurueckgegeben");
    });

    it("rejects returning an already-returned loan with 409", async () => {
      const res = await app.request(`/inventory-items/${itemId}/loans/${loan1Id}?clubId=${clubAId}`, {
        method: "PATCH",
        headers: { cookie: cookieBoard },
      });
      expect(res.status).toBe(409);
    });

    it("returns 404 for a loan id that doesn't belong to this item", async () => {
      const otherItemRes = await app.request(`/inventory-items?clubId=${clubAId}`, {
        method: "POST",
        headers: { cookie: cookieBoard, "content-type": "application/json" },
        body: JSON.stringify({ name: "Other Item", condition: "gut" }),
      });
      const otherItemBody = (await otherItemRes.json()) as { data: { id: string } };

      const res = await app.request(`/inventory-items/${otherItemBody.data.id}/loans/${loan1Id}?clubId=${clubAId}`, {
        method: "PATCH",
        headers: { cookie: cookieBoard },
      });
      expect(res.status).toBe(404);
    });
  });

  // --- Damage reports -----------------------------------------------------------

  describe("damage reports", () => {
    let reportId: string;

    it("lets any club member self-report damage, deriving a photoUrl from photoKey", async () => {
      const res = await app.request(`/inventory-items/${itemId}/damage-reports?clubId=${clubAId}`, {
        method: "POST",
        headers: { cookie: cookieMember2, "content-type": "application/json" },
        body: JSON.stringify({ description: "Linse zerkratzt", photoKey: `${clubAId}/some-uuid-photo.jpg` }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        data: { id: string; reportedBy: string; description: string; status: string; photoUrl: string | null };
      };
      expect(body.data.reportedBy).toBe(member2Id);
      expect(body.data.description).toBe("Linse zerkratzt");
      expect(body.data.status).toBe("gemeldet");
      expect(body.data.photoUrl).toBe(`/media/${clubAId}/some-uuid-photo.jpg`);
      reportId = body.data.id;
    });

    it("lists damage reports for the item, newest first", async () => {
      const res = await app.request(`/inventory-items/${itemId}/damage-reports?clubId=${clubAId}`, { headers: { cookie: cookieBoard } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Array<{ id: string }> };
      expect(body.data.some((r) => r.id === reportId)).toBe(true);
    });

    it("rejects a status update from a member without inventory:write", async () => {
      const res = await app.request(`/inventory-items/${itemId}/damage-reports/${reportId}?clubId=${clubAId}`, {
        method: "PATCH",
        headers: { cookie: cookieMember2, "content-type": "application/json" },
        body: JSON.stringify({ status: "in_bearbeitung" }),
      });
      expect(res.status).toBe(403);
    });

    it("lets a board member (inventory:write) triage the report to behoben, setting resolvedAt", async () => {
      const res = await app.request(`/inventory-items/${itemId}/damage-reports/${reportId}?clubId=${clubAId}`, {
        method: "PATCH",
        headers: { cookie: cookieBoard, "content-type": "application/json" },
        body: JSON.stringify({ status: "behoben" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { status: string; resolvedAt: string | null } };
      expect(body.data.status).toBe("behoben");
      expect(body.data.resolvedAt).not.toBeNull();
    });

    it("clears resolvedAt when the status moves away from behoben", async () => {
      const res = await app.request(`/inventory-items/${itemId}/damage-reports/${reportId}?clubId=${clubAId}`, {
        method: "PATCH",
        headers: { cookie: cookieBoard, "content-type": "application/json" },
        body: JSON.stringify({ status: "in_bearbeitung" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { status: string; resolvedAt: string | null } };
      expect(body.data.status).toBe("in_bearbeitung");
      expect(body.data.resolvedAt).toBeNull();
    });

    it("returns 404 for a report id that doesn't belong to this item", async () => {
      const otherItemRes = await app.request(`/inventory-items?clubId=${clubAId}`, {
        method: "POST",
        headers: { cookie: cookieBoard, "content-type": "application/json" },
        body: JSON.stringify({ name: "Another Item", condition: "gut" }),
      });
      const otherItemBody = (await otherItemRes.json()) as { data: { id: string } };

      const res = await app.request(`/inventory-items/${otherItemBody.data.id}/damage-reports/${reportId}?clubId=${clubAId}`, {
        method: "PATCH",
        headers: { cookie: cookieBoard, "content-type": "application/json" },
        body: JSON.stringify({ status: "gemeldet" }),
      });
      expect(res.status).toBe(404);
    });
  });

  // --- Delete ----------------------------------------------------------------

  describe("DELETE /:id", () => {
    let deleteItemId: string;

    beforeAll(async () => {
      const res = await app.request(`/inventory-items?clubId=${clubAId}`, {
        method: "POST",
        headers: { cookie: cookieBoard, "content-type": "application/json" },
        body: JSON.stringify({ name: "To be deleted", condition: "gut" }),
      });
      const body = (await res.json()) as { data: { id: string } };
      deleteItemId = body.data.id;
    });

    it("rejects DELETE from a member without inventory:write", async () => {
      const res = await app.request(`/inventory-items/${deleteItemId}?clubId=${clubAId}`, {
        method: "DELETE",
        headers: { cookie: cookieMember1 },
      });
      expect(res.status).toBe(403);
    });

    it("deletes with inventory:write", async () => {
      const res = await app.request(`/inventory-items/${deleteItemId}?clubId=${clubAId}`, {
        method: "DELETE",
        headers: { cookie: cookieBoard },
      });
      expect(res.status).toBe(204);

      const getRes = await app.request(`/inventory-items/${deleteItemId}?clubId=${clubAId}`, { headers: { cookie: cookieBoard } });
      expect(getRes.status).toBe(404);
    });
  });
});
