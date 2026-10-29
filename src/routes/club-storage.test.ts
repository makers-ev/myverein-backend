import { randomUUID } from "node:crypto";
import { utimes } from "node:fs/promises";
import path from "node:path";

import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { messageDeliveries } from "../db/schema/communication.js";
import { clubSettings } from "../db/schema/club-settings.js";
import { mediaFiles } from "../db/schema/media-files.js";
import { storeGeneratedPdf, sweepOrphanFiles } from "../lib/media.js";
import { PDF_BYTES } from "../lib/media-fixtures.js";
import { putObject, UPLOADS_DIR } from "../lib/storage.js";
import { adminStorageRoutes } from "./admin-storage.js";
import { clubStorageRoutes } from "./club-storage.js";
import { createClub, dropClubs, installErrorHandler, requester, signUpAndVerify, type Account } from "./forms-test-support.js";

/**
 * Wave 13 B3: storage usage, per-club quota (also under real parallel writes), 80/100 % notices, orphan sweep, admin quota.
 * Scoped to its own clubs (shared database: no global counts).
 */
const app = new Hono();
app.route("/club-storage", clubStorageRoutes);
app.route("/admin", adminStorageRoutes);
installErrorHandler(app);
const call = requester(app);
const suffix = Date.now();

/** A tiny but valid PDF, padded with a trailing comment to the wanted size. */
const pdf = (size: number) => Buffer.concat([PDF_BYTES, Buffer.alloc(Math.max(0, size - PDF_BYTES.length), 0x20)]);

describe("club storage and quota", () => {
  let club: Awaited<ReturnType<typeof createClub>>;
  let other: Awaited<ReturnType<typeof createClub>>;
  let admin: Account;
  const created: string[] = [];

  beforeAll(async () => {
    club = await createClub("storage", suffix, { kassenwart: "kassenwart", trainer: "trainer", plain: null });
    other = await createClub("storageo", suffix);
    admin = await signUpAndVerify(`storage-admin-${suffix}@example.com`, "Storage Admin");
    await db.update(user).set({ role: "admin" }).where(eq(user.id, admin.userId));
    created.push(admin.userId);
  }, 60_000);

  afterAll(async () => {
    await dropClubs([club.clubId, other.clubId], [...club.userIds, ...other.userIds, ...created]);
    await closeDatabase();
  });

  const store = (clubId: string, size: number) => storeGeneratedPdf({ buffer: pdf(size), clubId, filename: "x.pdf", owner: { type: "generated_pdf", id: null }, sensitive: true, uploadedBy: null });

  it("shows usage to storage:read holders only, with areas and the effective quota", async () => {
    await store(club.clubId, 1000);
    const res = await call(club.founder, "/club-storage", { clubId: club.clubId });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { usedBytes: number; quotaBytes: number; percent: number; areas: Record<string, number>; trashBytes: number } };
    expect(data.usedBytes).toBe(1000);
    expect(data.areas).toMatchObject({ generated: 1000, documents: 0, personal: 0, branding: 0, other: 0 });
    expect(data.trashBytes).toBe(0);
    expect(data.quotaBytes).toBeGreaterThan(1000);
    expect((await call(club.members.kassenwart!, "/club-storage", { clubId: club.clubId })).status).toBe(200);
    expect((await call(club.members.trainer!, "/club-storage", { clubId: club.clubId })).status).toBe(403);
    expect((await call(club.members.plain!, "/club-storage", { clubId: club.clubId })).status).toBe(403);
    expect((await call(club.founder, "/club-storage", { clubId: other.clubId })).status).toBe(404);
  });

  it("applies the club's own quota and lets exactly as many parallel writes through as fit", async () => {
    const n = 1000;
    await db.insert(clubSettings).values({ clubId: club.clubId, storageQuotaBytes: n + 2500 }).onConflictDoUpdate({ target: clubSettings.clubId, set: { storageQuotaBytes: n + 2500 } });
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => store(club.clubId, 1000)));
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(2);
    expect(failed).toHaveLength(6);
    for (const f of failed) expect(f.reason).toMatchObject({ code: "QUOTA_EXCEEDED", status: 422, details: { code: "club_quota", quotaBytes: n + 2500 } });
    const live = await db.select().from(mediaFiles).where(and(eq(mediaFiles.clubId, club.clubId)));
    expect(live.filter((r) => !r.deletedAt).reduce((s, r) => s + r.sizeBytes, 0)).toBeLessThanOrEqual(n + 2500);
    // The rejected writes left no file behind.
    expect(live.filter((r) => !r.deletedAt)).toHaveLength(3);
  });

  it("reports 80 % and 100 % once each to the people with storage:read and resets below 80 %", async () => {
    await db.update(clubSettings).set({ storageQuotaBytes: 4000, storageNoticeLevel: 0 }).where(eq(clubSettings.clubId, club.clubId));
    const count = async (key: string) => (await db.select({ id: messageDeliveries.id }).from(messageDeliveries).where(and(eq(messageDeliveries.clubId, club.clubId), eq(messageDeliveries.eventKey, key)))).length;
    // 3000 of 4000 bytes are used = 75 %: nothing yet. +400 = 85 %.
    await store(club.clubId, 400);
    expect(await count("storage.threshold_80")).toBeGreaterThan(0);
    const firstCount = await count("storage.threshold_80");
    await store(club.clubId, 100); // 87.5 %: still the same level, no second message
    expect(await count("storage.threshold_80")).toBe(firstCount);
    await store(club.clubId, 500); // 100 %
    expect(await count("storage.threshold_100")).toBeGreaterThan(0);
    const [s] = await db.select().from(clubSettings).where(eq(clubSettings.clubId, club.clubId));
    expect(s!.storageNoticeLevel).toBe(100);
    // Only the board roles with storage:read were addressed: the plain member got nothing.
    const recipients = await db.select({ userId: messageDeliveries.userId }).from(messageDeliveries).where(and(eq(messageDeliveries.clubId, club.clubId), eq(messageDeliveries.eventKey, "storage.threshold_100")));
    expect(recipients.map((r) => r.userId)).not.toContain(club.members.plain!.userId);
    expect(recipients.map((r) => r.userId)).not.toContain(club.members.trainer!.userId);
  });

  it("sweeps files without a registry row in the document namespaces, but not young files, registered files or legacy namespaces", async () => {
    await db.update(clubSettings).set({ storageQuotaBytes: 1_000_000 }).where(eq(clubSettings.clubId, club.clubId));
    const dir = `${club.clubId}/documents`;
    const old = await putObject({ prefix: dir, extension: "pdf", buffer: pdf(100) });
    const young = await putObject({ prefix: dir, extension: "pdf", buffer: pdf(100) });
    const legacy = await putObject({ prefix: club.clubId, extension: "png", buffer: Buffer.from("legacy") });
    const registered = await store(club.clubId, 100);
    const longAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
    await utimes(path.join(UPLOADS_DIR, old.key), longAgo, longAgo);
    await utimes(path.join(UPLOADS_DIR, legacy.key), longAgo, longAgo);
    await utimes(path.join(UPLOADS_DIR, registered.storageKey), longAgo, longAgo);

    expect(await sweepOrphanFiles([club.clubId])).toBeGreaterThanOrEqual(1);
    const exists = async (key: string) => (await import("node:fs/promises")).stat(path.join(UPLOADS_DIR, key)).then(() => true, () => false);
    expect(await exists(old.key)).toBe(false);
    expect(await exists(young.key)).toBe(true);
    expect(await exists(legacy.key)).toBe(true);
    expect(await exists(registered.storageKey)).toBe(true);
  });

  it("rejects a generated file that is not a PDF or is empty", async () => {
    await expect(storeGeneratedPdf({ buffer: Buffer.from("hello"), clubId: club.clubId, filename: "a.pdf", owner: { type: "generated_pdf", id: null }, sensitive: true, uploadedBy: null })).rejects.toMatchObject({ status: 422 });
    await expect(storeGeneratedPdf({ buffer: Buffer.alloc(0), clubId: club.clubId, filename: "a.pdf", owner: { type: "generated_pdf", id: null }, sensitive: true, uploadedBy: null })).rejects.toMatchObject({ status: 422 });
  });

  describe("admin overview", () => {
    it("lists usage and quota of a club without any file data, for platform admins only", async () => {
      const res = await call(admin, `/admin/club-storage?q=${encodeURIComponent(club.slug)}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Array<{ clubId: string; usedBytes: number; quotaBytes: number; customQuota: boolean; overQuota: boolean }>; defaultQuotaBytes: number };
      const row = body.data.find((r) => r.clubId === club.clubId)!;
      expect(row).toMatchObject({ quotaBytes: 1_000_000, customQuota: true });
      expect(Object.keys(row).sort()).toEqual(["clubId", "customQuota", "name", "overQuota", "percent", "quotaBytes", "slug", "usedBytes"]);
      expect((await call(club.founder, "/admin/club-storage")).status).toBe(401);
    });

    it("changes the quota with an audit entry and resets it with null", async () => {
      const res = await call(admin, `/admin/club-storage/${club.clubId}`, { method: "PATCH", body: { quotaBytes: 123456 } });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { data: { effectiveQuotaBytes: number } }).data.effectiveQuotaBytes).toBe(123456);
      const reset = await call(admin, `/admin/club-storage/${club.clubId}`, { method: "PATCH", body: { quotaBytes: null } });
      expect(((await reset.json()) as { data: { quotaBytes: number | null } }).data.quotaBytes).toBeNull();
      const audits = await db.select().from(auditLog).where(and(eq(auditLog.eventType, "club_storage.quota_update"), eq(auditLog.subjectId, club.clubId)));
      expect(audits).toHaveLength(2);
      expect((await call(admin, `/admin/club-storage/${randomUUID()}`, { method: "PATCH", body: { quotaBytes: 1 } })).status).toBe(404);
      expect((await call(admin, `/admin/club-storage/${club.clubId}`, { method: "PATCH", body: { quotaBytes: -5 } })).status).toBe(422);
      expect((await call(club.founder, `/admin/club-storage/${club.clubId}`, { method: "PATCH", body: { quotaBytes: 5 } })).status).toBe(401);
    });
  });
});
