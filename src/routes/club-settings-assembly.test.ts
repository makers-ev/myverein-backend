import { randomUUID } from "node:crypto";

import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { organization, user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { toAppError } from "../lib/errors.js";
import { clubSettingsRoutes } from "./club-settings.js";

/** Wave 11 B1: statute parameters of the general assembly (`/club-settings/assembly`). */

const app = new Hono();
app.route("/club-settings", clubSettingsRoutes);
app.onError((err, c) => {
  const appError = toAppError(err);
  return c.json(appError.toJSON(), appError.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503);
});

const suffix = Date.now();
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Who = { userId: string; cookie: string };
const userIds: string[] = [];
let club: string;
let clerk: Who;
let treasurer: Who;
let plain: Who;

async function signUp(label: string): Promise<Who> {
  const email = `w11a-${label}-${suffix}@example.com`;
  const { user: created } = await auth.api.createUser({ body: { email, password: "test-password-123!", name: `W11 ${label}` } });
  userIds.push(created.id);
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, created.id));
  const signIn = await auth.api.signInEmail({ body: { email, password: "test-password-123!" }, asResponse: true });
  return { userId: created.id, cookie: (signIn.headers.get("set-cookie") ?? "").split(";")[0]! };
}
const call = (who: Who, url: string, init: { method?: string; body?: object } = {}) =>
  app.request(`${url}?clubId=${club}`, {
    method: init.method ?? "GET",
    headers: { cookie: who.cookie, "x-forwarded-for": randomUUID(), "content-type": "application/json" },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
const json = async (res: Response) => (await res.json()) as Json;
const patch = (who: Who, body: object) => call(who, "/club-settings/assembly", { method: "PATCH", body });

beforeAll(async () => {
  clerk = await signUp("clerk");
  treasurer = await signUp("treasurer");
  plain = await signUp("plain");
  club = (await auth.api.createOrganization({ body: { name: `TV Versammlung ${suffix}`, slug: `w11a-${suffix}`, userId: clerk.userId } }))!.id;
  const clerkMember = await db.query.member.findFirst({ where: (m, { and: a, eq: e }) => a(e(m.organizationId, club), e(m.userId, clerk.userId)) });
  await db.insert(clubRoles).values({ memberId: clerkMember!.id, roleType: "schriftfuehrer" });
  for (const [who, roleType] of [[treasurer, "kassenwart"], [plain, null]] as const) {
    const account = (await auth.api.addMember({ body: { userId: who.userId, organizationId: club, role: "member" } }))!;
    if (roleType) await db.insert(clubRoles).values({ memberId: account.id, roleType });
  }
}, 60_000);

afterAll(async () => {
  await db.delete(organization).where(eq(organization.id, club));
  await db.delete(user).where(inArray(user.id, userIds));
  await closeDatabase();
});

describe("assembly rules", () => {
  it("starts without any legal default and lists what is missing", async () => {
    const res = await json(await call(plain, "/club-settings/assembly"));
    expect(res.data.complete).toBe(false);
    expect(res.data.rules).toMatchObject({ invitationMinDays: null, quorumMode: null, abstainCountsAs: null, proxyAllowed: null, onlineAllowed: "none", circularAllowed: false, secretBallotDigitalAllowed: false, termExpiryEffect: "none" });
    expect(res.data.rules.majorityByTopic.allgemein).toBeNull();
    expect(res.data.missing).toEqual(expect.arrayContaining(["invitationMinDays", "quorumMode", "majorityByTopic.allgemein", "votingStatuses"]));
  });

  it("lets assembly:manage state the rules, merges partial patches and audits field names only", async () => {
    const first = await patch(clerk, { invitationMinDays: 14, invitationDeliveryBufferDays: 3, majorityByTopic: { allgemein: "einfach" } });
    expect(first.status).toBe(200);
    const second = await json(await patch(clerk, { majorityByTopic: { satzungsaenderung: "drei_viertel" }, satzungReference: " § 8 Abs. 2 " }));
    expect(second.data.rules).toMatchObject({ invitationMinDays: 14, invitationDeliveryBufferDays: 3, satzungReference: "§ 8 Abs. 2" });
    expect(second.data.rules.majorityByTopic).toMatchObject({ allgemein: "einfach", satzungsaenderung: "drei_viertel", wahl: null });
    const complete = await json(await patch(clerk, { invitationForm: "textform", agendaRequiredInInvitation: true, quorumMode: "none", abstainCountsAs: "not_counted", proxyAllowed: false, votingStatuses: ["aktiv"], votingMinAge: 16 }));
    expect(complete.data.missing).toEqual([]);
    expect(complete.data.complete).toBe(true);
    expect((await json(await call(plain, "/club-settings/assembly"))).data.rules.invitationMinDays).toBe(14);
    const audits = await db.select().from(auditLog).where(eq(auditLog.eventType, "club_settings.assembly_update"));
    const mine = audits.filter((a) => (a.payload as Json).clubId === club);
    expect(mine.length).toBe(3);
    expect(JSON.stringify(mine.map((a) => a.payload))).not.toContain("drei_viertel");
  });

  it("clears a stated value again with null and validates cross-field rules", async () => {
    expect((await json(await patch(clerk, { invitationMinDays: null }))).data.missing).toContain("invitationMinDays");
    expect((await patch(clerk, { quorumMode: "fraction", quorumValue: 1.5 })).status).toBe(422);
    expect((await patch(clerk, { quorumMode: "absolute", quorumValue: 2.5 })).status).toBe(422);
    expect((await patch(clerk, { proxyAllowed: false, maxProxiesPerPerson: 2 })).status).toBe(422);
    expect((await patch(clerk, { votingStatuses: ["aktiv", "aktiv"] })).status).toBe(422);
    expect((await patch(clerk, { unknownKey: 1 })).status).toBe(422);
    const fraction = await json(await patch(clerk, { quorumMode: "fraction", quorumValue: 0.1 }));
    expect(fraction.data.rules).toMatchObject({ quorumMode: "fraction", quorumValue: 0.1 });
    // A failed patch leaves everything untouched.
    expect((await json(await call(plain, "/club-settings/assembly"))).data.rules.quorumValue).toBe(0.1);
  });

  it("requires the conditional parameters of an enabled feature", async () => {
    const res = await json(await patch(clerk, { circularAllowed: true, proxyAllowed: true }));
    expect(res.data.missing).toEqual(expect.arrayContaining(["circularUnanimity", "maxProxiesPerPerson"]));
  });

  it("denies the change to everybody without assembly:manage", async () => {
    expect((await patch(treasurer, { invitationMinDays: 1 })).status).toBe(403);
    expect((await patch(plain, {})).status).toBe(403);
  });

  it("exposes assembly:manage in the permissions of the schriftfuehrer", async () => {
    const { clubPermissionsFor } = await import("../lib/club-permissions.js");
    expect(clubPermissionsFor(["mitglied", "schriftfuehrer"])).toContain("assembly:manage");
  });
});
