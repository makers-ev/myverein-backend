import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { auth } from "../auth/auth.js";
import { closeDatabase, db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { clubMembers } from "../db/schema/club-members.js";
import { addDays } from "../lib/credentials.js";
import { logger } from "../lib/logger.js";
import { todayBerlin } from "../lib/member-lifecycle.js";
import { clubMemberRoutes } from "./club-members.js";
import { createClub, dropClubs, installErrorHandler, requester, signUpAndVerify, type Account } from "./forms-test-support.js";
import { memberFieldRoutes } from "./member-fields.js";

/**
 * GET /club-members/credentials (board overview with expiry status) and the computed `expiry` of the per-member view:
 * status semantics at the day boundaries, scoping by role (plain member / trainer / schriftfuehrer / kassenwart /
 * vorsitz / guest / foreign club), member read scoping (former members, interessenten), sensitive reads audited with ids
 * only, filters, paging and validation.
 */

const app = new Hono();
app.route("/club-members", clubMemberRoutes);
app.route("/member-fields", memberFieldRoutes);
installErrorHandler(app);
const call = requester(app);
const suffix = Date.now();

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed response helper
const body = async (res: Response) => (await res.json()) as any;

describe("credential overview", () => {
  const today = todayBerlin();
  let club: Awaited<ReturnType<typeof createClub>>;
  let other: Awaited<ReturnType<typeof createClub>>;
  let guest: Account;
  const rows: Record<string, string> = {};
  const logged: unknown[][] = [];
  const cid = () => club.clubId;
  const board = () => club.founder;
  const m = (name: string) => club.members[name]!;
  const names = ["expired", "today", "soon", "later", "forever", "none", "gone", "lead"] as const;

  const overview = async (who: Account, query = "", clubId = cid()) => call(who, `/club-members/credentials${query ? `?${query}` : ""}`, { clubId });
  const listed = async (who: Account, query: string) => {
    const res = await overview(who, query);
    expect(res.status, query).toBe(200);
    const json = await body(res);
    return { items: json.data as Array<{ displayName: string; fieldKey: string; value: unknown; expiry: { status: string; daysLeft: number | null; validUntil: string | null } }>, json };
  };
  const whoIs = (items: Array<{ displayName: string }>) => items.map((i) => i.displayName.replace(/ pco$/, "")).filter((n) => (names as readonly string[]).includes(n));
  const put = (memberId: string, values: Record<string, unknown>) => call(board(), `/club-members/${memberId}/custom-fields`, { method: "PUT", clubId: cid(), body: { values } });

  beforeAll(async () => {
    club = await createClub("pco", suffix, { sf: "schriftfuehrer", trainer: "trainer", kassen: "kassenwart", expired: null, today: null, soon: null, later: null, forever: null, none: null, gone: null, lead: null });
    other = await createClub("pcoo", suffix);
    guest = await signUpAndVerify(`pco-guest-${suffix}@example.com`, "Guest pco");
    await auth.api.addMember({ body: { userId: guest.userId, organizationId: cid(), role: "guest" } });
    club.userIds.push(guest.userId);
    for (const level of ["info", "warn", "error", "debug"] as const) {
      vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => {
        logged.push(args);
      }) as never);
    }
    for (const n of names) {
      const account = await db.query.member.findFirst({ where: (mm, { and: both, eq: same }) => both(same(mm.organizationId, cid()), same(mm.userId, m(n).userId)) });
      rows[n] = (await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, account!.id) }))!.id;
    }
    for (const key of ["mod_q_erste_hilfe", "mod_ks_praevention", "mod_q_juleica"]) {
      expect((await call(board(), `/member-fields/catalog/${key}/activate`, { method: "POST", clubId: cid() })).status).toBe(201);
    }
    expect((await call(board(), "/member-fields", { method: "POST", clubId: cid(), body: { key: "open_cred", label: "Offen", type: "credential", visibleTo: "mitglied" } })).status).toBe(201);
    const dates: Record<string, string | undefined> = { expired: addDays(today, -1), today, soon: addDays(today, 10), later: addDays(today, 200), forever: undefined };
    for (const [n, validUntil] of Object.entries(dates)) {
      expect((await put(rows[n]!, { mod_q_erste_hilfe: { valid: true, ...(validUntil ? { validUntil } : {}) } })).status).toBe(200);
    }
    // gone: left the club, lead: a prospect; both hold the credential.
    await put(rows.gone!, { mod_q_erste_hilfe: { valid: true, validUntil: addDays(today, 5) } });
    await put(rows.lead!, { mod_q_erste_hilfe: { valid: true, validUntil: addDays(today, 6) }, open_cred: { valid: true } });
    await put(rows.soon!, { open_cred: { valid: true, validUntil: addDays(today, 20) }, mod_ks_praevention: { valid: true, validUntil: addDays(today, 30) } });
    await put(rows.later!, { mod_ks_praevention: { valid: true, validUntil: addDays(today, -400) } });
    await db.update(clubMembers).set({ status: "ausgetreten", leftAt: "2020-01-01" }).where(eq(clubMembers.id, rows.gone!));
    await db.update(clubMembers).set({ status: "interessent" }).where(eq(clubMembers.id, rows.lead!));
  }, 180_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await dropClubs([club.clubId, other.clubId], [...club.userIds, ...other.userIds]);
    await closeDatabase();
  });

  it("computes the status per credential with Berlin day boundaries (valid through validUntil)", async () => {
    const { items, json } = await listed(board(), "fieldKey=mod_q_erste_hilfe");
    const of = (n: string) => items.find((i) => i.displayName.startsWith(`${n} `))!;
    expect(of("expired").expiry).toEqual({ status: "expired", daysLeft: -1, validUntil: addDays(today, -1) });
    expect(of("today").expiry).toEqual({ status: "expiring", daysLeft: 0, validUntil: today });
    expect(of("soon").expiry).toEqual({ status: "expiring", daysLeft: 10, validUntil: addDays(today, 10) });
    expect(of("later").expiry).toEqual({ status: "valid", daysLeft: 200, validUntil: addDays(today, 200) });
    expect(of("forever").expiry).toEqual({ status: "valid", daysLeft: null, validUntil: null });
    expect(of("none").expiry).toEqual({ status: "missing", daysLeft: null, validUntil: null });
    expect(of("none").value).toBeNull();
    expect(json).toMatchObject({ today, withinDays: 90, page: 1, pageSize: 50 });
    expect(json.fields).toEqual([expect.objectContaining({ key: "mod_q_erste_hilfe", sensitive: false })]);
    // Most urgent first: expired, then by date; no expiry and missing last.
    expect(whoIs(items).slice(0, 4)).toEqual(["expired", "today", "soon", "later"]);
  });

  it("filters by status, withinDays and pages", async () => {
    expect(whoIs((await listed(board(), "fieldKey=mod_q_erste_hilfe&status=expired")).items)).toEqual(["expired"]);
    expect(whoIs((await listed(board(), "fieldKey=mod_q_erste_hilfe&status=expiring")).items)).toEqual(["today", "soon"]);
    expect(whoIs((await listed(board(), "fieldKey=mod_q_erste_hilfe&status=valid")).items).sort()).toEqual(["forever", "later"]);
    expect(whoIs((await listed(board(), "fieldKey=mod_q_erste_hilfe&status=missing")).items)).toEqual(["none"]);
    // The window: 9 days excludes "soon" (10), 10 includes it, 365 pulls "later" in.
    expect(whoIs((await listed(board(), "fieldKey=mod_q_erste_hilfe&status=expiring&withinDays=9")).items)).toEqual(["today"]);
    expect(whoIs((await listed(board(), "fieldKey=mod_q_erste_hilfe&status=expiring&withinDays=10")).items)).toEqual(["today", "soon"]);
    expect(whoIs((await listed(board(), "fieldKey=mod_q_erste_hilfe&status=expiring&withinDays=365")).items)).toEqual(["today", "soon", "later"]);
    expect(whoIs((await listed(board(), "fieldKey=mod_q_erste_hilfe&status=valid&withinDays=365")).items)).toEqual(["forever"]);

    const all = await listed(board(), "fieldKey=mod_q_erste_hilfe&pageSize=2");
    expect(all.items).toHaveLength(2);
    expect(all.json.total).toBeGreaterThanOrEqual(6);
    const second = await listed(board(), "fieldKey=mod_q_erste_hilfe&pageSize=2&page=2");
    expect(second.items.map((i) => i.displayName)).not.toEqual(all.items.map((i) => i.displayName));
    expect((await listed(board(), "fieldKey=mod_q_erste_hilfe&pageSize=2&page=500")).items).toEqual([]);
  });

  it("without fieldKey lists the held credentials of every field the caller may see", async () => {
    const { items } = await listed(board(), "");
    const pairs = items.map((i) => `${i.fieldKey}:${i.displayName.split(" ")[0]}`);
    expect(pairs).toContain("mod_q_erste_hilfe:soon");
    expect(pairs).toContain("mod_ks_praevention:soon");
    expect(pairs).toContain("mod_ks_praevention:later");
    expect(pairs).toContain("open_cred:soon");
    expect(pairs).not.toContain("mod_q_erste_hilfe:none");
    expect(items.every((i) => i.expiry.status !== "missing")).toBe(true);
    expect(items.find((i) => i.fieldKey === "mod_ks_praevention" && i.displayName.startsWith("later"))!.expiry.status).toBe("expired");
    expect(await body(await overview(board(), "status=missing"))).toMatchObject({ error: { details: { code: "field_key_required" } } });
  });

  it("scopes fields by role: plain member, trainer, schriftfuehrer, kassenwart, vorsitz, guest", async () => {
    const keys = async (who: Account) => [...new Set((await listed(who, "")).items.map((i) => i.fieldKey))].sort();
    // Plain member: never, although open_cred is visible to members on a profile.
    for (const q of ["", "fieldKey=open_cred", "fieldKey=mod_q_erste_hilfe", "fieldKey=mod_ks_praevention", "status=expired"]) expect((await overview(m("none"), q)).status, q).toBe(403);
    // Trainer (Funktionstraeger): licences yes, Kinderschutz no.
    expect(await keys(m("trainer"))).toEqual(["mod_q_erste_hilfe", "open_cred"]);
    expect((await overview(m("trainer"), "fieldKey=mod_ks_praevention")).status).toBe(404);
    // Schriftfuehrer (members:write only): the same, not the sensitive Kinderschutz module.
    expect(await keys(m("sf"))).toEqual(["mod_q_erste_hilfe", "open_cred"]);
    expect((await overview(m("sf"), "fieldKey=mod_ks_praevention")).status).toBe(404);
    // Kassenwart and Vorsitz hold members:read_sensitive.
    expect(await keys(m("kassen"))).toEqual(["mod_ks_praevention", "mod_q_erste_hilfe", "open_cred"]);
    expect(await keys(board())).toEqual(["mod_ks_praevention", "mod_q_erste_hilfe", "open_cred"]);
    // Unknown / archived / non-credential-like keys: the same 404 as an invisible one.
    expect((await overview(board(), "fieldKey=mod_nothing")).status).toBe(404);
    expect((await overview(board(), "fieldKey=Bad%20Key")).status).toBe(422);
    // External guests: no profile fields at all.
    expect((await overview(guest, "")).status).toBe(403);
    expect((await overview(guest, "fieldKey=mod_q_erste_hilfe")).status).toBe(403);
  });

  it("only lists members the caller may read, and never reaches into another club", async () => {
    const board_ = whoIs((await listed(board(), "fieldKey=mod_q_erste_hilfe")).items);
    expect(board_).not.toContain("gone");
    expect(board_).not.toContain("lead");
    // Trainer: club-wide scope (every probe/aktiv/ruhend member, not only his own department), no prospects.
    const trainer = await listed(m("trainer"), "fieldKey=open_cred");
    expect(whoIs(trainer.items)).not.toContain("lead");
    expect(trainer.items.some((i) => i.displayName.startsWith("soon "))).toBe(true);
    // The board may widen it, everybody else cannot (the parameter is ignored for them).
    const wide = whoIs((await listed(board(), "fieldKey=mod_q_erste_hilfe&includeFormer=true")).items);
    expect(wide).toContain("gone");
    expect(wide).toContain("lead");
    expect(whoIs((await listed(m("trainer"), "fieldKey=mod_q_erste_hilfe&includeFormer=true")).items)).not.toContain("gone");
    expect(whoIs((await listed(m("trainer"), "fieldKey=open_cred&includeFormer=true")).items)).not.toContain("lead");

    // Foreign club: the foreign board cannot see this club's field, and its own overview holds none of these members.
    expect((await overview(other.founder, "fieldKey=mod_q_erste_hilfe", cid())).status).toBe(404); // not a member here (clubGuard)
    expect((await overview(other.founder, "fieldKey=mod_q_erste_hilfe", other.clubId)).status).toBe(404);
    const own = await body(await overview(other.founder, "", other.clubId));
    expect(own).toMatchObject({ data: [], total: 0, fields: [] });
  });

  it("audits reads of sensitive credentials with ids only", async () => {
    const before = await db.select().from(auditLog).where(eq(auditLog.eventType, "member_field.sensitive_read"));
    await listed(m("kassen"), "fieldKey=mod_ks_praevention");
    const after = (await db.select().from(auditLog).where(eq(auditLog.eventType, "member_field.sensitive_read"))).filter((e) => !before.some((b) => b.id === e.id));
    expect(after).toHaveLength(1);
    const payload = after[0]!.payload as { via: string; clubId: string; fieldIds: string[]; clubMemberIds: string[]; readBy: string };
    expect(payload).toMatchObject({ via: "credentials_overview", clubId: cid() });
    expect(payload.clubMemberIds).toEqual(expect.arrayContaining([rows.soon!, rows.later!]));
    expect(JSON.stringify(after[0]!.payload)).not.toContain("validUntil");
    // Non-sensitive overviews leave no entry; neither does a read without a single value (status=missing of a sensitive field).
    // Scoped to this test club: other test files write audit rows concurrently into the shared DB.
    const count = async () => (await db.select().from(auditLog).where(eq(auditLog.eventType, "member_field.sensitive_read"))).filter((e) => (e.payload as { clubId?: string } | null)?.clubId === cid()).length;
    const n = await count();
    await listed(board(), "fieldKey=mod_q_erste_hilfe");
    expect(await count()).toBe(n);
    // A sensitive field is audited whenever the query ran, also for status=missing and an empty page (total / missing list
    // disclose who holds it): field ids only.
    await listed(board(), "fieldKey=mod_ks_praevention&status=missing");
    expect(await count()).toBe(n + 1);
    await listed(board(), "fieldKey=mod_ks_praevention&page=900");
    expect(await count()).toBe(n + 2);
    const last = (await db.select().from(auditLog).where(eq(auditLog.eventType, "member_field.sensitive_read"))).filter((e) => !before.some((b) => b.id === e.id) && e.id !== after[0]!.id).at(-1)!;
    expect(last.payload).toMatchObject({ via: "credentials_overview", clubMemberIds: [] });
    expect((last.payload as { fieldIds: string[] }).fieldIds).toHaveLength(1);
    expect(JSON.stringify(logged)).not.toContain("validUntil");
  });

  it("validates the query", async () => {
    for (const q of ["page=1001", "status=bogus", "withinDays=0", "withinDays=731", "withinDays=x", "pageSize=101", "pageSize=0", "page=0", "includeFormer=maybe"]) {
      expect((await overview(board(), q)).status, q).toBe(422);
    }
  });

  it("shows the computed expiry in the member's custom field view", async () => {
    const view = async (who: Account, memberId: string) => ((await body(await call(who, `/club-members/${memberId}/custom-fields`, { clubId: cid() }))).data.fields as Array<{ key: string; expiry: unknown; value: unknown }>);
    const soon = await view(board(), rows.soon!);
    expect(soon.find((f) => f.key === "mod_q_erste_hilfe")!.expiry).toEqual({ status: "expiring", daysLeft: 10, validUntil: addDays(today, 10) });
    expect(soon.find((f) => f.key === "mod_q_juleica")!.expiry).toEqual({ status: "missing", daysLeft: null, validUntil: null });
    expect((await view(board(), rows.expired!)).find((f) => f.key === "mod_q_erste_hilfe")!.expiry).toMatchObject({ status: "expired", daysLeft: -1 });
    expect((await view(board(), rows.forever!)).find((f) => f.key === "mod_q_erste_hilfe")!.expiry).toMatchObject({ status: "valid", daysLeft: null });
    // The Funktionstraeger view carries it as well; fields the caller cannot read are not in the view at all.
    const trainer = await view(m("trainer"), rows.today!);
    expect(trainer.find((f) => f.key === "mod_q_erste_hilfe")!.expiry).toMatchObject({ status: "expiring", daysLeft: 0 });
    expect(trainer.find((f) => f.key === "mod_ks_praevention")).toBeUndefined();
    // The person sees the status of its own sensitive credential.
    const own = await view(m("soon"), rows.soon!);
    expect(own.find((f) => f.key === "mod_ks_praevention")!.expiry).toMatchObject({ status: "expiring", daysLeft: 30 });
  });

  it("shows who recorded a value (enteredBy) without exposing ids", async () => {
    // "soon" entered open_cred through the board (PUT), then the person itself maintains its own entry.
    const view = async (who: Account, memberId: string) => ((await body(await call(who, `/club-members/${memberId}/custom-fields`, { clubId: cid() }))).data.fields as Array<{ key: string; enteredBy: unknown }>);
    expect((await view(board(), rows.soon!)).find((f) => f.key === "mod_ks_praevention")!.enteredBy).toBe("board");
    expect((await view(board(), rows.soon!)).find((f) => f.key === "mod_q_juleica")!.enteredBy).toBeNull();
    expect((await call(m("soon"), "/club-members/me/custom-fields", { method: "PATCH", clubId: cid(), body: { values: { mod_q_juleica: { valid: true, validUntil: addDays(today, 400) } } } })).status).toBe(200);
    expect((await view(board(), rows.soon!)).find((f) => f.key === "mod_q_juleica")!.enteredBy).toBe("self");
    const items = (await listed(board(), "")).items as Array<{ displayName: string; fieldKey: string; enteredBy: unknown }>;
    expect(items.find((i) => i.displayName.startsWith("soon ") && i.fieldKey === "mod_q_juleica")!.enteredBy).toBe("self");
    expect(items.find((i) => i.displayName.startsWith("soon ") && i.fieldKey === "mod_ks_praevention")!.enteredBy).toBe("board");
    expect(JSON.stringify(items)).not.toContain(m("soon").userId);
  });

  it("rate-limits the overview per user", async () => {
    let limited = 0;
    for (let i = 0; i < 65; i++) if ((await overview(m("expired"), "")).status === 429) limited++;
    expect(limited).toBeGreaterThan(0);
  });
});
