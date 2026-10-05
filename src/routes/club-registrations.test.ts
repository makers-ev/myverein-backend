import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";

import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { auth } from "../auth/auth.js";
import { member, organization, user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { clubMemberships } from "../db/schema/club-memberships.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { clubRegistrationDocuments, clubRegistrations } from "../db/schema/club-registrations.js";
import { toAppError } from "../lib/errors.js";
import { sendEmail } from "../lib/email.js";
import { nextMemberNumber } from "../lib/member-number.js";
import { UPLOADS_DIR } from "../lib/storage.js";
import { adminClubRegistrationRoutes } from "./admin-club-registrations.js";
import { clubApplicationRoutes } from "./club-applications.js";
import { clubMemberRoutes } from "./club-members.js";
import { clubRegistrationRoutes, MAX_DOCUMENTS_PER_REGISTRATION } from "./club-registrations.js";

// Mail is best effort (B7): every send fails here, and no status transition may notice.
vi.mock("../lib/email.js", () => ({ sendEmail: vi.fn(async () => Promise.reject(new Error("smtp down"))) }));
// Pass-through spy so one test can make the approval fail after the organization was created.
vi.mock("../lib/member-number.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/member-number.js")>();
  return { ...original, nextMemberNumber: vi.fn(original.nextMemberNumber) };
});

/**
 * Integration test against a real Postgres (DATABASE_URL): Wave 6 club
 * registration -- B1 (direct organization/create closed), lifecycle,
 * approval effects, decisions/races, slug collisions, IDOR, admin gating,
 * upload hardening, duplicate guard and mail resilience.
 */

const app = new Hono();
app.route("/club-registrations", clubRegistrationRoutes);
app.route("/admin/club-registrations", adminClubRegistrationRoutes);
app.route("/club-members", clubMemberRoutes);
app.route("/club-applications", clubApplicationRoutes);
app.onError((err, c) => {
  const appError = toAppError(err);
  return c.json(appError.toJSON(), appError.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503);
});

const suffix = Date.now();
const json = { "content-type": "application/json" };
const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(64, 0x20)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);

type Actor = { userId: string; cookie: string };

async function signUp(email: string, name: string, opts: { verified?: boolean; role?: "user" | "admin" } = {}): Promise<Actor> {
  const { user: created } = await auth.api.createUser({ body: { email, password: "test-password-123!", name } });
  await db
    .update(user)
    .set({ emailVerified: opts.verified ?? true, role: opts.role ?? "user" })
    .where(eq(user.id, created.id));
  const signIn = await auth.api.signInEmail({ body: { email, password: "test-password-123!" }, asResponse: true });
  return { userId: created.id, cookie: (signIn.headers.get("set-cookie") ?? "").split(";")[0] };
}

// The in-memory rate limiter keys on x-forwarded-for; give every request its own bucket unless a test pins one.
function req(who: Actor | null, url: string, init: RequestInit & { xff?: string } = {}) {
  const { xff, ...rest } = init;
  const headers: Record<string, string> = { "x-forwarded-for": xff ?? randomUUID(), ...(rest.headers as Record<string, string> | undefined) };
  if (who) headers.cookie = who.cookie;
  return app.request(url, { ...rest, headers });
}

const post = (who: Actor | null, url: string, body?: object, xff?: string) =>
  req(who, url, { method: "POST", headers: json, body: body === undefined ? undefined : JSON.stringify(body), xff });

const validBody = (name: string, extra: object = {}) => ({
  clubName: name,
  legalForm: "nicht_eingetragen",
  street: "Hauptstr. 1",
  postalCode: "63619",
  city: "Bad Orb",
  ...extra,
});

function uploadForm(content: Buffer | Uint8Array, filename: string, type: string, kind: string | null = "satzung") {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(content)], filename, { type }));
  if (kind !== null) form.set("kind", kind);
  return form;
}

const upload = (who: Actor, id: string, form: FormData) => req(who, `/club-registrations/${id}/documents`, { method: "POST", body: form });

type Reg = {
  id: string;
  status: string;
  clubName: string;
  slugSuggestion: string | null;
  clubId: string | null;
  clubSlug: string | null;
  reviewNote: string | null;
  documents: Array<{ id: string; kind: string; filename: string; mimeType: string; sizeBytes: number }>;
};

describe("club registrations (Wave 6)", () => {
  let admin: Actor;
  const userIds: string[] = [];

  async function applicant(label: string, opts: { verified?: boolean } = {}) {
    const a = await signUp(`club-reg-${label}-${suffix}@example.com`, `Applicant ${label}`, opts);
    userIds.push(a.userId);
    return a;
  }

  async function create(who: Actor, name: string, extra: object = {}): Promise<Reg> {
    const res = await post(who, "/club-registrations", validBody(name, extra));
    expect(res.status).toBe(201);
    return ((await res.json()) as { data: { registration: Reg } }).data.registration;
  }

  async function addDoc(who: Actor, id: string, kind = "satzung") {
    const res = await upload(who, id, uploadForm(PDF, "satzung.pdf", "application/pdf", kind));
    expect(res.status).toBe(201);
    return ((await res.json()) as { data: { document: { id: string } } }).data.document.id;
  }

  async function submit(who: Actor, id: string) {
    return post(who, `/club-registrations/${id}/submit`);
  }

  async function submitted(who: Actor, name: string, extra: object = {}): Promise<Reg> {
    const reg = await create(who, name, extra);
    await addDoc(who, reg.id);
    const res = await submit(who, reg.id);
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: { registration: Reg } }).data.registration;
  }

  const decide = (id: string, action: "approve" | "reject" | "request-info", body?: object, who: Actor | null = admin) =>
    post(who, `/admin/club-registrations/${id}/${action}`, body ?? (action === "approve" ? {} : { note: "Bitte nachbessern" }));

  beforeAll(async () => {
    admin = await signUp(`club-reg-admin-${suffix}@example.com`, "Platform Admin", { role: "admin" });
    userIds.push(admin.userId);
  }, 30_000);

  afterAll(async () => {
    const regs = await db.select().from(clubRegistrations).where(inArray(clubRegistrations.userId, userIds));
    const orgIds = regs.map((r) => r.clubId).filter((id): id is string => !!id);
    // Organizations created by a failed/aborted approval are removed by the route; the rest we clean here.
    if (orgIds.length > 0) await db.delete(organization).where(inArray(organization.id, orgIds));
    for (const r of regs) await rm(path.join(UPLOADS_DIR, "registrations", r.id), { recursive: true, force: true });
    for (const id of userIds) await db.delete(user).where(eq(user.id, id));
    await closeDatabase();
  });

  describe("B1: organization creation is closed", () => {
    it("rejects POST /api/auth/organization/create for a normal user and allows server-side creation", async () => {
      const who = await applicant("b1");
      const slug = `squat-${suffix}`;
      const res = await auth.handler(
        new Request("http://localhost:3000/api/auth/organization/create", {
          method: "POST",
          headers: { ...json, cookie: who.cookie, origin: process.env.WEB_ORIGIN!.split(",")[0].trim() },
          body: JSON.stringify({ name: "Squatted", slug }),
        }),
      );
      expect(res.status).toBe(403);
      expect(await db.query.organization.findFirst({ where: eq(organization.slug, slug) })).toBeUndefined();

      // Same call without a session but with a userId (what seed:club and the approval do) still works.
      const created = await auth.api.createOrganization({ body: { name: "Seeded", slug: `seeded-${suffix}`, userId: who.userId } });
      expect(created?.slug).toBe(`seeded-${suffix}`);
      await db.delete(organization).where(eq(organization.id, created!.id));
    });

    it("keeps the slug immutable via organization/update, while other fields stay editable", async () => {
      const owner = await applicant("b1-owner");
      const reg = await submitted(owner, `Immutable Verein ${suffix}`);
      const approved = (await (await decide(reg.id, "approve")).json()) as { data: { club: { id: string; slug: string } } };
      const { id: clubId, slug } = approved.data.club;
      const origin = process.env.WEB_ORIGIN!.split(",")[0].trim();
      const update = (data: object) =>
        auth.handler(
          new Request("http://localhost:3000/api/auth/organization/update", {
            method: "POST",
            headers: { ...json, cookie: owner.cookie, origin },
            body: JSON.stringify({ organizationId: clubId, data }),
          }),
        );

      expect((await update({ slug: `hijacked-${suffix}` })).status).toBe(403);
      expect((await db.query.organization.findFirst({ where: eq(organization.id, clubId) }))?.slug).toBe(slug);
      expect((await update({ slug })).status).toBe(200); // re-sending the current value is a no-op
      expect((await update({ name: `Renamed ${suffix}` })).status).toBe(200);
    });
  });

  describe("applicant API", () => {
    it("requires a session and a verified e-mail", async () => {
      expect((await req(null, "/club-registrations/mine")).status).toBe(401);
      // Sign-in itself requires a verified address, so flip the flag after the session exists.
      const unverified = await applicant("unverified");
      await db.update(user).set({ emailVerified: false }).where(eq(user.id, unverified.userId));
      expect((await post(unverified, "/club-registrations", validBody("Nope"))).status).toBe(403);
    });

    it("creates a draft, validates legal form vs register fields and allows only one open registration", async () => {
      const who = await applicant("create");
      expect((await post(who, "/club-registrations", validBody("Eingetragener Verein", { legalForm: "e_v" }))).status).toBe(422);
      expect((await post(who, "/club-registrations", validBody("X"))).status).toBe(422);
      expect((await post(who, "/club-registrations", validBody("Bad Role", { claimedRole: "kassenwart" }))).status).toBe(422);
      expect((await post(who, "/club-registrations", validBody("Bad Url", { websiteUrl: "javascript:alert(1)" }))).status).toBe(422);

      const res = await post(who, "/club-registrations", validBody("Erster Verein", { legalForm: "e_v", registerCourt: "AG Hanau", registerNumber: "VR 123", websiteUrl: "https://example.org" }));
      expect(res.status).toBe(201);
      const reg = ((await res.json()) as { data: { registration: Reg & Record<string, unknown> } }).data.registration;
      expect(reg).toMatchObject({
        clubName: "Erster Verein",
        legalForm: "e_v",
        registerCourt: "AG Hanau",
        registerNumber: "VR 123",
        street: "Hauptstr. 1",
        postalCode: "63619",
        city: "Bad Orb",
        websiteUrl: "https://example.org",
        claimedRole: "vorsitz",
        status: "draft",
        reviewNote: null,
        slugSuggestion: null,
        clubId: null,
        clubSlug: null,
        submittedAt: null,
        documents: [],
      });
      expect(typeof reg.createdAt).toBe("string");

      expect((await post(who, "/club-registrations", validBody("Zweiter Verein"))).status).toBe(409);
    });

    it("patches partially while draft/needs_info only and re-validates the merged result", async () => {
      const who = await applicant("patch");
      const reg = await create(who, "Patch Verein", { legalForm: "e_v", registerCourt: "AG Hanau", registerNumber: "VR 9" });
      const patch = (body: object) => req(who, `/club-registrations/${reg.id}`, { method: "PATCH", headers: json, body: JSON.stringify(body) });

      const ok = await patch({ city: "Gelnhausen", claimedRole: "schriftfuehrer" });
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as { data: { registration: Reg & { city: string; claimedRole: string; clubName: string } } }).data.registration).toMatchObject({
        city: "Gelnhausen",
        claimedRole: "schriftfuehrer",
        clubName: "Patch Verein",
      });
      expect((await patch({ registerNumber: null })).status).toBe(422); // e_v still needs it
      expect((await patch({ legalForm: "nicht_eingetragen", registerNumber: null })).status).toBe(200);

      await addDoc(who, reg.id);
      expect((await submit(who, reg.id)).status).toBe(200);
      expect((await patch({ city: "Fulda" })).status).toBe(409);
    });

    it("lists own registrations newest first and returns 404 for foreign or malformed ids (IDOR)", async () => {
      const owner = await applicant("idor-owner");
      const other = await applicant("idor-other");
      const first = await create(owner, "Alt Verein");
      const docId = await addDoc(owner, first.id);
      await submit(owner, first.id);
      await decide(first.id, "reject", { note: "Nein" });
      const second = await create(owner, "Neu Verein");

      const mine = (await (await req(owner, "/club-registrations/mine")).json()) as { data: Reg[] };
      expect(mine.data.map((r) => r.id)).toEqual([second.id, first.id]);
      expect(((await (await req(other, "/club-registrations/mine")).json()) as { data: Reg[] }).data).toEqual([]);

      expect((await req(owner, `/club-registrations/${first.id}`)).status).toBe(200);
      expect((await req(other, `/club-registrations/${first.id}`)).status).toBe(404);
      expect((await req(owner, "/club-registrations/not-a-uuid")).status).toBe(404);
      expect((await req(other, `/club-registrations/${second.id}`, { method: "PATCH", headers: json, body: JSON.stringify({ city: "X" }) })).status).toBe(404);
      expect((await submit(other, second.id)).status).toBe(404);
      expect((await upload(other, second.id, uploadForm(PDF, "a.pdf", "application/pdf"))).status).toBe(404);
      expect((await req(other, `/club-registrations/${first.id}/documents/${docId}`)).status).toBe(404);
      expect((await req(other, `/club-registrations/${first.id}/documents/${docId}`, { method: "DELETE" })).status).toBe(404);

      // The applicant and an admin may download, with the stored (allowlisted) content type.
      const own = await req(owner, `/club-registrations/${first.id}/documents/${docId}`);
      expect(own.status).toBe(200);
      expect(own.headers.get("content-type")).toBe("application/pdf");
      expect(Buffer.from(await own.arrayBuffer()).equals(PDF)).toBe(true);
      expect((await req(admin, `/club-registrations/${first.id}/documents/${docId}`)).status).toBe(200);
      expect((await req(null, `/club-registrations/${first.id}/documents/${docId}`)).status).toBe(401);
    });

    it("enforces the creation rate limit (10/hour per client)", async () => {
      const who = await applicant("ratelimit");
      await create(who, "Rate Verein");
      const statuses: number[] = [];
      for (let i = 0; i < 11; i++) statuses.push((await post(who, "/club-registrations", validBody("Rate Verein"), "rate-limit-client")).status);
      expect(statuses.slice(0, 10)).toEqual(Array(10).fill(409)); // already has an open registration
      expect(statuses[10]).toBe(429);
    });
  });

  describe("documents", () => {
    it("validates MIME type, content, size, kind, count and stores under a private traversal-safe path", async () => {
      const who = await applicant("upload");
      const reg = await create(who, "Upload Verein");
      const url = `/club-registrations/${reg.id}/documents`;

      expect((await upload(who, reg.id, uploadForm(PDF, "x.exe", "application/x-msdownload"))).status).toBe(422);
      expect((await upload(who, reg.id, uploadForm(Buffer.from("<html>"), "x.pdf", "application/pdf"))).status).toBe(422); // content != claimed type
      expect((await upload(who, reg.id, uploadForm(PNG, "x.pdf", "application/pdf"))).status).toBe(422);
      expect((await upload(who, reg.id, uploadForm(PDF, "x.pdf", "application/pdf", "bogus"))).status).toBe(422);
      expect((await upload(who, reg.id, uploadForm(PDF, "x.pdf", "application/pdf", null))).status).toBe(422);
      expect((await req(who, url, { method: "POST", headers: json, body: "{}" })).status).toBe(422);
      expect((await upload(who, reg.id, uploadForm(Buffer.alloc(0), "empty.pdf", "application/pdf"))).status).toBe(422);
      const big = Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024)]);
      expect((await upload(who, reg.id, uploadForm(big, "big.pdf", "application/pdf"))).status).toBe(422);

      const res = await upload(who, reg.id, uploadForm(PNG, "../../../etc/pass\\wd.png", "image/png", "sonstiges"));
      expect(res.status).toBe(201);
      const { document } = ((await res.json()) as { data: { document: Record<string, unknown> } }).data;
      expect(Object.keys(document).sort()).toEqual(["filename", "id", "kind", "mimeType", "sizeBytes"]);
      expect(document).toMatchObject({ kind: "sonstiges", mimeType: "image/png", sizeBytes: PNG.length });
      expect(String(document.filename)).not.toMatch(/[/\\]/);

      const row = await db.query.clubRegistrationDocuments.findFirst({ where: eq(clubRegistrationDocuments.id, document.id as string) });
      expect(row?.storageKey.startsWith(`registrations/${reg.id}/`)).toBe(true);
      expect(row?.storageKey.slice(`registrations/${reg.id}/`.length)).not.toMatch(/[/\\]/);

      for (let i = 1; i < MAX_DOCUMENTS_PER_REGISTRATION; i++) await addDoc(who, reg.id);
      expect((await upload(who, reg.id, uploadForm(PDF, "six.pdf", "application/pdf"))).status).toBe(422);
    });

    it("deletes documents (204) while editable and refuses changes once pending", async () => {
      const who = await applicant("docdelete");
      const reg = await create(who, "Delete Doc Verein");
      const docId = await addDoc(who, reg.id);
      expect((await req(who, `/club-registrations/${reg.id}/documents/${docId}`, { method: "DELETE" })).status).toBe(204);
      expect((await req(who, `/club-registrations/${reg.id}/documents/${docId}`)).status).toBe(404);
      expect((await req(who, `/club-registrations/${reg.id}/documents/${docId}`, { method: "DELETE" })).status).toBe(404);

      await addDoc(who, reg.id);
      expect((await submit(who, reg.id)).status).toBe(200);
      expect((await upload(who, reg.id, uploadForm(PDF, "late.pdf", "application/pdf"))).status).toBe(409);
      const remaining = (await (await req(who, `/club-registrations/${reg.id}`)).json()) as { data: { registration: Reg } };
      expect((await req(who, `/club-registrations/${reg.id}/documents/${remaining.data.registration.documents[0].id}`, { method: "DELETE" })).status).toBe(409);
    });
  });

  describe("submit", () => {
    it("requires a qualifying proof for the legal form (E2)", async () => {
      const who = await applicant("submit-proof");
      const reg = await create(who, "Beleg Verein");
      expect((await submit(who, reg.id)).status).toBe(422); // none
      await addDoc(who, reg.id, "sonstiges");
      expect((await submit(who, reg.id)).status).toBe(422); // "sonstiges" alone never counts
      await addDoc(who, reg.id, "freistellungsbescheid");
      expect((await submit(who, reg.id)).status).toBe(422); // not enough for nicht_eingetragen
      await addDoc(who, reg.id, "gruendungsprotokoll");
      const res = await submit(who, reg.id);
      expect(res.status).toBe(200);
      const body = ((await res.json()) as { data: { registration: Reg & { submittedAt: string } } }).data.registration;
      expect(body.status).toBe("pending");
      expect(body.submittedAt).toBeTruthy();
      expect(body.slugSuggestion).toMatch(/^beleg-verein(-\d+)?$/);
      expect((await submit(who, reg.id)).status).toBe(409); // not editable any more
    });

    it("answers 409 for the register data of an already approved club without leaking it", async () => {
      const first = await applicant("dup-first");
      const second = await applicant("dup-second");
      const regData = { legalForm: "e_v", registerCourt: "AG Hanau", registerNumber: `VR ${suffix}` };
      const a = await submitted(first, `Duplikat Verein ${suffix}`, regData);
      expect((await decide(a.id, "approve")).status).toBe(200);

      const b = await create(second, "Anderer Name", { ...regData, registerCourt: "  ag   hanau ", registerNumber: `vr${suffix}` });
      await addDoc(second, b.id, "registerauszug");
      const res = await submit(second, b.id);
      expect(res.status).toBe(409);
      const text = await res.text();
      expect(text).not.toContain(`Duplikat Verein ${suffix}`);
      expect(text).not.toContain(a.clubId ?? "no-club-id");
      expect(text.toLowerCase()).not.toContain("duplikat");
      expect(((await (await req(second, `/club-registrations/${b.id}`)).json()) as { data: { registration: Reg } }).data.registration.status).toBe("draft");
    });

    it("never fails the status change when mail sending fails", async () => {
      vi.mocked(sendEmail).mockClear();
      const who = await applicant("mailfail");
      const reg = await submitted(who, `Mailfehler Verein ${suffix}`);
      await vi.waitFor(() => expect(vi.mocked(sendEmail)).toHaveBeenCalled());
      expect((await decide(reg.id, "approve")).status).toBe(200);
    });
  });

  describe("reviewer API", () => {
    it("is admin-only (non-admins and guests are rejected by adminGuard)", async () => {
      const who = await applicant("nonadmin");
      const reg = await submitted(who, `Gate Verein ${suffix}`);
      // adminGuard answers 401 for authenticated non-admins (existing behaviour shared by every /admin route).
      for (const [method, url] of [
        ["GET", "/admin/club-registrations"],
        ["GET", `/admin/club-registrations/${reg.id}`],
        ["GET", `/admin/club-registrations/${reg.id}/documents/${randomUUID()}`],
        ["POST", `/admin/club-registrations/${reg.id}/approve`],
        ["POST", `/admin/club-registrations/${reg.id}/reject`],
        ["POST", `/admin/club-registrations/${reg.id}/request-info`],
      ] as const) {
        expect((await req(who, url, { method, headers: json, body: method === "POST" ? "{}" : undefined })).status, `${method} ${url}`).toBe(401);
        expect((await req(null, url, { method })).status).toBe(401);
      }
      expect(((await (await req(who, `/club-registrations/${reg.id}`)).json()) as { data: { registration: Reg } }).data.registration.status).toBe("pending");
    });

    it("lists pending registrations oldest first with applicant data, documents and duplicate hints", async () => {
      const a = await applicant("queue-a");
      const b = await applicant("queue-b");
      const existing = await applicant("queue-existing");
      const name = `Queue Verein ${suffix}`;
      const first = await submitted(existing, name); // becomes an existing club with the same name
      expect((await decide(first.id, "approve")).status).toBe(200);
      const regA = await submitted(a, name);
      const regB = await submitted(b, `Queue Zwei ${suffix}`, { postalCode: "10115", city: "Berlin" });
      await create(await applicant("queue-draft"), "Queue Entwurf");

      const res = await req(admin, "/admin/club-registrations?status=pending");
      expect(res.status).toBe(200);
      const { data } = (await res.json()) as {
        data: Array<Reg & { applicant: { id: string; name: string; email: string }; duplicateHints: Array<{ clubId: string; name: string; city: string | null; postalCode: string | null }> }>;
      };
      expect(data.every((r) => r.status === "pending")).toBe(true);
      expect(data.some((r) => r.clubName === "Queue Entwurf")).toBe(false);
      const ids = data.map((r) => r.id);
      expect(ids.indexOf(regA.id)).toBeLessThan(ids.indexOf(regB.id));
      const entryA = data.find((r) => r.id === regA.id)!;
      expect(entryA.applicant).toEqual({ id: a.userId, name: "Applicant queue-a", email: `club-reg-queue-a-${suffix}@example.com` });
      expect(entryA.documents).toHaveLength(1);
      expect(entryA.duplicateHints.map((h) => h.clubId)).toContain(first.clubId ?? (await db.query.clubRegistrations.findFirst({ where: eq(clubRegistrations.id, first.id) }))?.clubId);
      expect(entryA.duplicateHints[0]).toMatchObject({ name, city: "Bad Orb", postalCode: "63619" });
      expect(data.find((r) => r.id === regB.id)!.duplicateHints).toEqual([]);

      const one = (await (await req(admin, `/admin/club-registrations/${regA.id}`)).json()) as { data: { id: string; applicant: object; duplicateHints: unknown[] } };
      expect(one.data.id).toBe(regA.id);
      expect(one.data.duplicateHints.length).toBeGreaterThan(0);

      expect((await req(admin, "/admin/club-registrations?status=draft")).status).toBe(422);
      expect((await req(admin, "/admin/club-registrations?status=bogus")).status).toBe(422);
      expect((await req(admin, "/admin/club-registrations/not-a-uuid")).status).toBe(404);
      expect((await req(admin, `/admin/club-registrations/${randomUUID()}`)).status).toBe(404);
      const draft = (await db.select().from(clubRegistrations).where(eq(clubRegistrations.clubName, "Queue Entwurf")))[0];
      expect((await req(admin, `/admin/club-registrations/${draft.id}`)).status).toBe(404);

      const doc = await req(admin, `/admin/club-registrations/${regA.id}/documents/${entryA.documents[0].id}`);
      expect(doc.status).toBe(200);
      expect(doc.headers.get("content-disposition")).toContain("attachment");
      expect((await req(admin, `/admin/club-registrations/${regB.id}/documents/${entryA.documents[0].id}`)).status).toBe(404);
    });

    it("request-info and reject need a note and only act on pending; request-info allows editing and resubmitting", async () => {
      const who = await applicant("flow");
      const reg = await submitted(who, `Rueckfrage Verein ${suffix}`);

      expect((await decide(reg.id, "request-info", {})).status).toBe(422);
      expect((await decide(reg.id, "reject", { note: "   " })).status).toBe(422);
      expect((await decide(reg.id, "reject", undefined)).status).toBe(200); // default body of the helper has a note

      // A fresh registration for the request-info path (the first one is rejected now).
      const again = await submitted(who, `Rueckfrage Verein ${suffix}`);
      const info = await decide(again.id, "request-info", { note: "Bitte aktuellen Registerauszug hochladen" });
      expect(info.status).toBe(200);
      const infoReg = ((await info.json()) as { data: { registration: Reg } }).data.registration;
      expect(infoReg.status).toBe("needs_info");
      expect(infoReg.reviewNote).toBe("Bitte aktuellen Registerauszug hochladen");

      // Applicant sees the note, may edit + upload again and resubmit.
      expect(((await (await req(who, `/club-registrations/${again.id}`)).json()) as { data: { registration: Reg } }).data.registration.reviewNote).toBe("Bitte aktuellen Registerauszug hochladen");
      expect((await req(who, `/club-registrations/${again.id}`, { method: "PATCH", headers: json, body: JSON.stringify({ street: "Neue Str. 2" }) })).status).toBe(200);
      await addDoc(who, again.id, "registerauszug");
      const resubmit = await submit(who, again.id);
      expect(resubmit.status).toBe(200);
      const resub = ((await resubmit.json()) as { data: { registration: Reg } }).data.registration;
      expect(resub.status).toBe("pending");
      expect(resub.reviewNote).toBeNull();
      expect(resub.documents).toHaveLength(2);

      expect((await decide(again.id, "approve")).status).toBe(200);
    });

    it("lets a rejected applicant file a new registration", async () => {
      const who = await applicant("reject");
      const reg = await submitted(who, `Abgelehnt Verein ${suffix}`);
      const res = await decide(reg.id, "reject", { note: "Nachweis nicht plausibel" });
      expect(res.status).toBe(200);
      const body = ((await res.json()) as { data: { registration: Reg } }).data.registration;
      expect(body).toMatchObject({ status: "rejected", reviewNote: "Nachweis nicht plausibel", clubId: null, clubSlug: null });
      expect(await db.query.organization.findFirst({ where: eq(organization.name, `Abgelehnt Verein ${suffix}`) })).toBeUndefined();

      const next = await create(who, `Abgelehnt Verein ${suffix}`);
      expect(next.id).not.toBe(reg.id);
    });
  });

  describe("approval", () => {
    it("creates club, owner, claimed role, member number and slug and lets the founder manage the club immediately", async () => {
      const founder = await applicant("approve");
      const reg = await submitted(founder, `Turnverein Bärenstraße ${suffix} e.V.`, { claimedRole: "stellv_vorsitz" });
      expect(reg.slugSuggestion).toBe(`turnverein-baerenstrasse-${suffix}`);

      const res = await decide(reg.id, "approve");
      expect(res.status).toBe(200);
      const { data } = (await res.json()) as { data: { registration: Reg; club: { id: string; name: string; slug: string } } };
      expect(data.club).toEqual({ id: expect.any(String), name: `Turnverein Bärenstraße ${suffix} e.V.`, slug: `turnverein-baerenstrasse-${suffix}` });
      expect(data.registration).toMatchObject({ status: "approved", clubId: data.club.id, clubSlug: data.club.slug });

      const owner = await db.query.member.findFirst({ where: (m, { and, eq }) => and(eq(m.organizationId, data.club.id), eq(m.userId, founder.userId)) });
      expect(owner?.role).toBe("owner");
      const roles = await db.select().from(clubRoles).where(eq(clubRoles.memberId, owner!.id));
      expect(roles.map((r) => r.roleType)).toEqual(["stellv_vorsitz"]);
      const membership = await db.query.clubMemberships.findFirst({ where: eq(clubMemberships.memberId, owner!.id) });
      expect(membership?.memberNumber).toBe("TURN-0001");
      expect(membership?.joinedAt).toBe(new Date().toISOString().slice(0, 10));

      const row = await db.query.clubRegistrations.findFirst({ where: eq(clubRegistrations.id, reg.id) });
      expect(row?.reviewedBy).toBe(admin.userId);
      expect(row?.reviewedAt).toBeTruthy();
      const audits = await db.select().from(auditLog).where(eq(auditLog.subjectId, reg.id));
      expect(audits.map((a) => a.eventType)).toEqual(expect.arrayContaining(["club_registration.create", "club_registration.submit", "club_registration.approve"]));

      // The new founder can use the club right away: /me, the application queue and member administration.
      const me = await req(founder, `/club-members/me?clubId=${data.club.id}`);
      expect(me.status).toBe(200);
      const meBody = (await me.json()) as { data: { memberNumber: string; permissions: string[] } };
      expect(meBody.data.memberNumber).toBe("TURN-0001");
      expect(meBody.data.permissions).toEqual(expect.arrayContaining(["members:write", "roles:write"]));
      expect((await req(founder, `/club-applications?clubId=${data.club.id}`)).status).toBe(200);
      const list = await req(founder, `/club-members?clubId=${data.club.id}`);
      expect(list.status).toBe(200);

      // GET shows the approved registration with club slug.
      const mine = (await (await req(founder, `/club-registrations/${reg.id}`)).json()) as { data: { registration: Reg } };
      expect(mine.data.registration.clubSlug).toBe(data.club.slug);
    });

    it("uses an admin-supplied slug override, validated and unique", async () => {
      const a = await applicant("slug-a");
      const b = await applicant("slug-b");
      const c = await applicant("slug-c");
      const d = await applicant("slug-d");
      const regA = await submitted(a, `Override A ${suffix}`);
      const regB = await submitted(b, `Override B ${suffix}`);
      const regC = await submitted(c, `Override C ${suffix}`);
      const regD = await submitted(d, `Override D ${suffix}`);

      expect((await decide(regA.id, "approve", { slug: "admin" })).status).toBe(422); // reserved
      expect((await decide(regA.id, "approve", { slug: "Not Valid" })).status).toBe(422);
      expect((await decide(regA.id, "approve", { slug: "ab" })).status).toBe(422);

      const custom = `override-${suffix}`;
      const ok = await decide(regA.id, "approve", { slug: custom });
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as { data: { club: { slug: string } } }).data.club.slug).toBe(custom);

      // Slug now taken: an explicit duplicate is a 409 and leaves the registration pending, no orphan club.
      const conflict = await decide(regB.id, "approve", { slug: custom });
      expect(conflict.status).toBe(409);
      expect(((await (await req(b, `/club-registrations/${regB.id}`)).json()) as { data: { registration: Reg } }).data.registration.status).toBe("pending");
      expect(await db.query.organization.findMany({ where: eq(organization.name, regB.clubName) })).toHaveLength(0);

      // Suggestion gone stale (taken in the meantime) -> automatic -2 suffix instead of an error.
      await db.update(clubRegistrations).set({ slugSuggestion: custom }).where(eq(clubRegistrations.id, regC.id));
      const auto = await decide(regC.id, "approve");
      expect(auto.status).toBe(200);
      expect(((await auto.json()) as { data: { club: { slug: string } } }).data.club.slug).toBe(`${custom}-2`);

      expect((await decide(regD.id, "approve")).status).toBe(200);
    });

    it("resolves a slug collision between two same-named registrations approved in parallel", async () => {
      const a = await applicant("collide-a");
      const b = await applicant("collide-b");
      const name = `Kollision Verein ${suffix}`;
      const regA = await submitted(a, name);
      const regB = await submitted(b, name);
      expect(regA.slugSuggestion).toBe(regB.slugSuggestion); // not reserved by an open registration

      const results = await Promise.all([decide(regA.id, "approve"), decide(regB.id, "approve")]);
      expect(results.map((r) => r.status)).toEqual([200, 200]);
      const slugs = (await Promise.all(results.map(async (r) => ((await r.json()) as { data: { club: { slug: string } } }).data.club.slug))).sort();
      expect(slugs).toEqual([`kollision-verein-${suffix}`, `kollision-verein-${suffix}-2`]);
    });

    it("returns 409 for a second decision and lets exactly one of two parallel approvals win", async () => {
      const who = await applicant("double");
      const reg = await submitted(who, `Doppelt Verein ${suffix}`);
      const results = await Promise.all([decide(reg.id, "approve"), decide(reg.id, "approve")]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(await db.query.organization.findMany({ where: eq(organization.name, reg.clubName) })).toHaveLength(1);
      const members = await db.query.member.findMany({ where: eq(member.userId, who.userId) });
      expect(members).toHaveLength(1);

      expect((await decide(reg.id, "approve")).status).toBe(409);
      expect((await decide(reg.id, "reject")).status).toBe(409);
      expect((await decide(reg.id, "request-info")).status).toBe(409);

      const other = await applicant("double-reject");
      const rejected = await submitted(other, `Doppelt Zwei ${suffix}`);
      expect((await decide(rejected.id, "reject")).status).toBe(200);
      expect((await decide(rejected.id, "reject")).status).toBe(409);
      expect((await decide(rejected.id, "approve")).status).toBe(409);
      expect((await decide(rejected.id, "request-info")).status).toBe(409);

      const draft = await create(await applicant("double-draft"), "Nur Entwurf");
      expect((await decide(draft.id, "approve")).status).toBe(409);
    });

    it("removes the created organization again when the approval fails afterwards, and can be retried", async () => {
      const who = await applicant("compensate");
      const reg = await submitted(who, `Kompensation Verein ${suffix}`);
      vi.mocked(nextMemberNumber).mockRejectedValueOnce(new Error("boom"));

      expect((await decide(reg.id, "approve")).status).toBe(500);
      expect(await db.query.organization.findFirst({ where: eq(organization.slug, reg.slugSuggestion!) })).toBeUndefined();
      expect(await db.query.member.findFirst({ where: eq(member.userId, who.userId) })).toBeUndefined();
      const row = await db.query.clubRegistrations.findFirst({ where: eq(clubRegistrations.id, reg.id) });
      expect(row).toMatchObject({ status: "pending", clubId: null });

      const retry = await decide(reg.id, "approve");
      expect(retry.status).toBe(200);
      expect(((await retry.json()) as { data: { club: { slug: string } } }).data.club.slug).toBe(reg.slugSuggestion);
    });

    it("refuses a claimed role that could not administer the club", async () => {
      const who = await applicant("badrole");
      const reg = await submitted(who, `Rolle Verein ${suffix}`);
      await db.update(clubRegistrations).set({ claimedRole: "kassenwart" }).where(eq(clubRegistrations.id, reg.id));
      expect((await decide(reg.id, "approve")).status).toBe(422);
      expect(await db.query.organization.findFirst({ where: eq(organization.name, reg.clubName) })).toBeUndefined();
    });
  });
});
