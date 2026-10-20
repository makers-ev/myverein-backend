import { randomUUID } from "node:crypto";

import { and, eq, like, sql } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { organization, user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { calendars } from "../db/schema/calendars.js";
import { clubMemberInvites } from "../db/schema/club-member-invites.js";
import { clubMembers, memberCategories } from "../db/schema/club-members.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { clubSettings } from "../db/schema/club-settings.js";
import { messageDeliveries } from "../db/schema/communication.js";
import { eventAttendees } from "../db/schema/event-attendees.js";
import { events } from "../db/schema/events.js";
import { inventoryItems, inventoryLoans } from "../db/schema/inventory.js";
import { jobs } from "../db/schema/jobs.js";
import { meetingInvitees, meetings } from "../db/schema/meetings.js";
import { clubSettingsRoutes } from "../routes/club-settings.js";
import { toAppError } from "./errors.js";
import { notifyApplicationApproved, notifyApplicationRejected, notifyExitDecision } from "./decision-notify.js";
import { handleAgeTransitionMemberNotify, runAgeTransitionSweep } from "./age-transition.js";
import { buildMemberInviteEmail } from "./emailTemplate.js";
import { EXIT_EFFECTIVE_NOTIFY_JOB_TYPE, handleExitEffectiveNotify, runExitEffectiveSweep } from "./exit-effective.js";
import { composeEventMessage, formatWhen, notifyWaitlistPromoted } from "./event-notify.js";
import { notifyHandover } from "./handover-notify.js";
import { handleEmailDelivery, notify, renderNotifyEmail, setMailSender } from "./notify/index.js";
import { genericPushText } from "./notify/push.js";
import { handleReminder, REMINDER_JOB_TYPE, runReminderSweep, type ReminderPayload } from "./reminders.js";

/** G12: system texts in the club's mail language (de default, en); author-written text stays as written. */

const suffix = Date.now();
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const userIds: string[] = [];
let en: string; // English club
let de: string; // German club (default)
let calendarEn: string;
let ownerEn: string;
const accountOf: Record<string, string> = {};
const clubMemberOf: Record<string, string> = {};
let boardCookie: string;

const settingsApp = new Hono();
settingsApp.route("/club-settings", clubSettingsRoutes);
settingsApp.onError((err, c) => c.json(toAppError(err).toJSON(), toAppError(err).status as 400 | 401 | 403 | 404 | 422 | 500));

async function mkUser(label: string) {
  const email = `lang-${label}-${suffix}@example.test`;
  const { user: created } = await auth.api.createUser({ body: { email, password: "test-password-123!", name: label } });
  userIds.push(created.id);
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, created.id));
  return { id: created.id, email };
}
const deliveries = (clubId: string, eventKey: string) => db.select().from(messageDeliveries).where(and(eq(messageDeliveries.clubId, clubId), eq(messageDeliveries.eventKey, eventKey)));
const inApp = async (clubId: string, eventKey: string) => (await deliveries(clubId, eventKey)).filter((d) => d.channel === "in_app").map((d) => d.content as { title: string; body: string; lang?: string });
const reminderJob = async (clubId: string, kind: string) => (await db.select().from(jobs).where(and(eq(jobs.type, REMINDER_JOB_TYPE), sql`${jobs.payload}->>'clubId' = ${clubId}`))).filter((j) => j.payload.kind === kind);

beforeAll(async () => {
  process.env.MAIL_SEND_RATE = "0";
  const owner = await mkUser("owner");
  ownerEn = owner.id;
  const board = await mkUser("board");
  const member = await mkUser("member");
  en = (await auth.api.createOrganization({ body: { name: `Lang EN ${suffix}`, slug: `lang-en-${suffix}`, userId: owner.id } }))!.id;
  de = (await auth.api.createOrganization({ body: { name: `Lang DE ${suffix}`, slug: `lang-de-${suffix}`, userId: owner.id } }))!.id;
  await db.insert(clubSettings).values({ clubId: en, mailLanguage: "en" }).onConflictDoUpdate({ target: clubSettings.clubId, set: { mailLanguage: "en" } });
  for (const club of [en, de]) {
    await auth.api.addMember({ body: { userId: member.id, organizationId: club, role: "member" } });
  }
  await auth.api.addMember({ body: { userId: board.id, organizationId: en, role: "member" } });
  const accounts = await db.query.member.findMany({ where: (m, { inArray, eq: same }) => inArray(m.organizationId, [en, de]) && same(m.userId, member.id) });
  void accounts;
  for (const [key, club] of [["memberEn", en], ["memberDe", de]] as const) {
    const acc = (await db.query.member.findFirst({ where: (m, { and: both, eq: same }) => both(same(m.organizationId, club), same(m.userId, member.id)) }))!;
    accountOf[key] = acc.id;
    clubMemberOf[key] = (await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, acc.id) }))!.id;
  }
  const boardAcc = (await db.query.member.findFirst({ where: (m, { and: both, eq: same }) => both(same(m.organizationId, en), same(m.userId, board.id)) }))!;
  await db.insert(clubRoles).values({ memberId: boardAcc.id, roleType: "vorsitz" });
  const signIn = await auth.api.signInEmail({ body: { email: board.email, password: "test-password-123!" }, asResponse: true });
  boardCookie = (signIn.headers.get("set-cookie") ?? "").split(";")[0]!;
  const [cal] = await db.insert(calendars).values({ clubId: en, name: "Kalender", createdBy: owner.id }).returning();
  calendarEn = cal!.id;
  setMailSender(async () => undefined);
}, 90_000);

afterAll(async () => {
  setMailSender(null);
  await db.delete(jobs).where(sql`${jobs.payload}->>'clubId' IN (${en}, ${de})`);
  await db.delete(organization).where(eq(organization.id, en));
  await db.delete(organization).where(eq(organization.id, de));
  for (const id of userIds) await db.delete(user).where(eq(user.id, id));
  await closeDatabase();
});

describe("settings", () => {
  it("defaults to German, accepts de/en for members:write and refuses other languages", async () => {
    const call = (body: object) => settingsApp.request(`/club-settings?clubId=${en}`, { method: "PATCH", headers: { cookie: boardCookie, "content-type": "application/json", "x-forwarded-for": randomUUID() }, body: JSON.stringify(body) });
    const got = await settingsApp.request(`/club-settings?clubId=${en}`, { headers: { cookie: boardCookie, "x-forwarded-for": randomUUID() } });
    expect(((await got.json()) as Json).data.mailLanguage).toBe("en");
    expect((await call({ mailLanguage: "fr" })).status).toBe(422);
    expect((await call({ mailLanguage: "de" })).status).toBe(200);
    expect((await call({ mailLanguage: "en" })).status).toBe(200);
    expect(((await (await settingsApp.request(`/club-settings?clubId=${de}`, { headers: { cookie: boardCookie, "x-forwarded-for": randomUUID() } })).json()) as Json).error).toBeDefined(); // not a member of the other club
  });

  it("previews the mail chrome in the club language", async () => {
    const res = await settingsApp.request(`/club-settings/mail-preview?clubId=${en}`, { method: "POST", headers: { cookie: boardCookie, "content-type": "application/json", "x-forwarded-for": randomUUID() }, body: JSON.stringify({ template: "announcement" }) });
    const data = ((await res.json()) as Json).data;
    expect(data.html).toContain("New message from");
    expect(data.html).toContain("Hello Max,");
    const asGerman = await settingsApp.request(`/club-settings/mail-preview?clubId=${en}`, { method: "POST", headers: { cookie: boardCookie, "content-type": "application/json", "x-forwarded-for": randomUUID() }, body: JSON.stringify({ template: "announcement", mailLanguage: "de" }) });
    expect(((await asGerman.json()) as Json).data.html).toContain("Neue Mitteilung von");
  });
});

describe("texts", () => {
  it("event messages: both languages, same facts", () => {
    const at = new Date("2026-10-19T08:00:00Z");
    const base = { noun: "Termin" as const, title: "Training", timezone: "Europe/Berlin", before: { startsAt: at, endsAt: null, place: "Halle" }, after: { startsAt: new Date("2026-10-20T08:00:00Z"), endsAt: null, place: "Platz" }, cancelled: false };
    const de1 = composeEventMessage(base);
    const en1 = composeEventMessage({ ...base, lang: "en" });
    expect(de1.title).toBe("Terminänderung: Training");
    expect(de1.body).toContain("Bisher: Mo., 19.10.2026, 10:00 Uhr");
    expect(en1.title).toBe("Event changed: Training");
    expect(en1.body).toContain("Previously: Mon, 19/10/2026, 10:00");
    expect(en1.body).toContain("Previous location: Halle");
    expect(en1.body).not.toMatch(/Uhr|Bisher/);
    const cancelled = composeEventMessage({ ...base, cancelled: true, reason: "Regen", lang: "en" });
    expect(cancelled.title).toBe("Cancelled: Training");
    expect(cancelled.body).toContain("It was scheduled for:");
    expect(cancelled.body).toContain("Reason: Regen"); // the reason is the author's text, only the label is system text
    expect(composeEventMessage({ ...base, noun: "Treffen", cancelled: true, before: { ...base.before, startsAt: null }, lang: "en" }).body).toContain("The scheduling poll has ended.");
    expect(formatWhen(null, "Europe/Berlin", null, "en")).toBe("no date yet");
    expect(formatWhen(at, "Europe/Berlin", new Date("2026-10-19T09:30:00Z"), "en")).toBe("Mon, 19/10/2026, 10:00 to 11:30");
  });

  it("decisions follow the club language, the author's note stays as written", async () => {
    const applicationId = randomUUID();
    await notifyApplicationApproved({ clubId: en, applicationId, userId: ownerEn, memberNumber: 7 });
    await notifyApplicationRejected({ clubId: de, applicationId, userId: ownerEn, applicantMessage: "Bitte später erneut bewerben" });
    await notifyApplicationRejected({ clubId: en, applicationId: randomUUID(), userId: ownerEn, applicantMessage: "Bitte später erneut bewerben" });
    const approved = (await inApp(en, "application.approved"))[0]!;
    expect(approved).toMatchObject({ lang: "en", title: `Your membership application to Lang EN ${suffix} was approved` });
    expect(approved.body).toContain("Member number: 7");
    const rejectedDe = (await inApp(de, "application.rejected"))[0]!;
    expect(rejectedDe).toMatchObject({ lang: "de", title: `Dein Aufnahmeantrag bei Lang DE ${suffix} wurde abgelehnt` });
    const rejectedEn = (await inApp(en, "application.rejected"))[0]!;
    expect(rejectedEn.body).toContain("Message from the board:\nBitte später erneut bewerben");

    const requestId = randomUUID();
    await notifyExitDecision({ clubId: en, requestId, clubMemberId: clubMemberOf.memberEn!, kind: "accepted", effectiveOn: "2026-12-31", today: "2026-10-20" });
    const exit = (await inApp(en, "exit.accepted"))[0]!;
    expect(exit.title).toBe(`Your exit from Lang EN ${suffix} was approved`);
    expect(exit.body).toContain("The exit takes effect on 31/12/2026.");
  });

  it("the mail around any text uses the club language: intro, button, greeting, urgent label; the author's words stay", async () => {
    const sent: Array<{ subject: string; html: string }> = [];
    setMailSender(async (mail) => void sent.push({ subject: mail.subject, html: mail.html }));
    await notify({
      clubId: en,
      class: "optional",
      eventKey: `lang-ann-${suffix}`,
      recipients: [{ clubMemberId: clubMemberOf.memberEn!, userId: null, name: "Anna", email: `lang-anna-${suffix}@example.test` }],
      content: { title: "Sommerfest am Samstag", body: "Wir freuen uns auf euch.", urgent: true },
      channels: ["email"],
    });
    const [row] = await deliveries(en, `lang-ann-${suffix}`);
    await handleEmailDelivery({ id: randomUUID(), type: "notify.email", payload: { deliveryId: row!.id }, attempt: 1, maxAttempts: 3 });
    expect(sent[0]!.subject).toBe("[Urgent] Sommerfest am Samstag");
    expect(sent[0]!.html).toContain("Important message from");
    expect(sent[0]!.html).toContain("Hello Anna,");
    expect(sent[0]!.html).toContain("Wir freuen uns auf euch.");
    expect(sent[0]!.html).toContain("View message");

    // German club: unchanged German chrome
    await notify({ clubId: de, class: "optional", eventKey: `lang-ann-de-${suffix}`, recipients: [{ clubMemberId: clubMemberOf.memberDe!, name: "Anna", email: `lang-anna-${suffix}@example.test` }], content: { title: "Sommerfest", body: "Text" }, channels: ["email"] });
    const [rowDe] = await deliveries(de, `lang-ann-de-${suffix}`);
    await handleEmailDelivery({ id: randomUUID(), type: "notify.email", payload: { deliveryId: rowDe!.id }, attempt: 1, maxAttempts: 3 });
    expect(sent[1]!.html).toContain("Neue Mitteilung von");
    expect(sent[1]!.html).toContain("Hallo Anna,");
    expect(renderNotifyEmail({ template: "reminder", title: "x", body: "y", recipientName: null, clubName: "Club", ctaLabel: null, ctaUrl: null, signature: null, unsubscribeUrl: "https://example.org/u", lang: "en" }).html).toContain("Unsubscribe from these notifications");
  });

  it("push lines follow the language of the message", () => {
    expect(genericPushText("event.cancelled", "announcement", "en")).toBe("Event cancelled");
    expect(genericPushText("event.cancelled", "announcement")).toBe("Termin abgesagt");
    expect(genericPushText(null, "decision", "en")).toBe("News about your request");
  });

  it("handover and waitlist notices", async () => {
    await notifyHandover({ clubId: en, kind: "key.issued", refId: randomUUID(), accountMemberId: accountOf.memberEn!, actorAccountMemberId: "someone-else", subject: "Hall", keyLabel: "No. 3" });
    const key = (await inApp(en, "key.issued"))[0]!;
    expect(key).toMatchObject({ lang: "en", title: "Key handed out: Hall" });
    expect(key.body).toContain("A key (No. 3) for “Hall” was handed to");
    const event = { id: randomUUID(), title: "Turnier", startsAt: new Date(Date.now() + 86_400_000), endsAt: null, locationId: null, cancelledAt: null };
    await notifyWaitlistPromoted({ clubId: en, event, accountMemberId: accountOf.memberEn!, respondedAt: new Date() });
    expect((await inApp(en, "event.promoted"))[0]!.title).toBe("You moved up: Turnier");
  });
});

describe("reminders", () => {
  let eventId: string;
  const run = (now: string, clubId = en) => runReminderSweep(new Date(now), { clubId });
  const deliver = (job: { id: string; payload: unknown }) => handleReminder({ id: job.id, type: REMINDER_JOB_TYPE, payload: job.payload as Record<string, unknown>, attempt: 1, maxAttempts: 3 });

  it("event, loan and RSVP reminders are written in the club language", async () => {
    const [ev] = await db.insert(events).values({ calendarId: calendarEn, title: "Training", startsAt: new Date("2026-10-19T08:00:00Z"), createdBy: ownerEn }).returning();
    eventId = ev!.id;
    await db.insert(eventAttendees).values({ eventId, memberId: accountOf.memberEn!, status: "angemeldet" });
    const [item] = await db.insert(inventoryItems).values({ clubId: en, name: "Pavillon", condition: "gut" }).returning();
    await db.insert(inventoryLoans).values({ itemId: item!.id, memberId: accountOf.memberEn!, dueAt: new Date("2026-10-19T10:00:00Z") });
    const [meeting] = await db.insert(meetings).values({ clubId: en, title: "Vorstandssitzung", type: "sonstige", status: "geplant", scheduledAt: new Date("2026-10-21T17:00:00Z"), createdBy: ownerEn }).returning();
    await db.insert(meetingInvitees).values({ meetingId: meeting!.id, memberId: accountOf.memberEn!, response: "ausstehend" });
    await run("2026-10-18T08:15:00Z");

    const event = (await reminderJob(en, "event"))[0]!.payload as ReminderPayload;
    expect(event.title).toBe("Reminder: Training");
    expect(event.body).toBe("There is a confirmed registration for “Training”.\nWhen: Mon, 19/10/2026, 10:00");
    const loan = (await reminderJob(en, "loan_due"))[0]!.payload as ReminderPayload;
    expect(loan.title).toBe("Return due: Pavillon");
    expect(loan.body).toBe("“Pavillon” is due back on 19/10/2026.");
    const rsvp = (await reminderJob(en, "rsvp"))[0]!.payload as ReminderPayload;
    expect(rsvp.title).toBe("Please respond: Vorstandssitzung");
    expect(rsvp.body).toContain("Please accept or decline.");

    await deliver((await reminderJob(en, "event"))[0]!);
    const delivered = (await deliveries(en, "reminder.event")).filter((d) => d.channel === "email")[0]!;
    expect((delivered.content as { lang: string }).lang).toBe("en");
  });

  it("a German club keeps the German reminder wording", async () => {
    const [cal] = await db.insert(calendars).values({ clubId: de, name: "Kalender", createdBy: ownerEn }).returning();
    const [ev] = await db.insert(events).values({ calendarId: cal!.id, title: "Training", startsAt: new Date("2026-10-19T08:00:00Z"), createdBy: ownerEn }).returning();
    await db.insert(eventAttendees).values({ eventId: ev!.id, memberId: accountOf.memberDe!, status: "angemeldet" });
    await run("2026-10-18T08:15:00Z", de);
    const payload = (await reminderJob(de, "event"))[0]!.payload as ReminderPayload;
    expect(payload.title).toBe("Erinnerung: Training");
    expect(payload.body).toBe("Für „Training“ liegt eine Zusage vor.\nWann: Mo., 19.10.2026, 10:00 Uhr");
    expect(await db.select().from(messageDeliveries).where(like(messageDeliveries.refId, `${randomUUID()}%`))).toHaveLength(0);
  });
});

describe("remaining system texts in English", () => {
  it("maintenance digest and invitation reminders", async () => {
    const [item] = await db.insert(inventoryItems).values({ clubId: en, name: "Zelt", condition: "gut", maintenanceIntervalDays: 30, lastMaintenanceAt: new Date("2026-08-01T00:00:00Z") }).returning();
    void item;
    const [invited] = await db.insert(clubMembers).values({ clubId: en, displayName: "Ida Eingeladen", joinedAt: "2020-01-01" }).returning();
    await db.insert(clubMemberInvites).values({ clubMemberId: invited!.id, email: "ida@example.test", tokenHash: `lang-${randomUUID()}`, expiresAt: new Date("2026-10-20T12:00:00Z") });
    await runReminderSweep(new Date("2026-10-18T08:15:00Z"), { clubId: en });
    const maintenance = (await reminderJob(en, "maintenance"))[0]!.payload as ReminderPayload;
    expect(maintenance.title).toBe("Maintenance due: 1 item");
    expect(maintenance.body).toMatch(/^These items need maintenance:\n• Zelt: (due on|overdue since) \d\d\/\d\d\/2026$/);
    const expiring = (await reminderJob(en, "invite_expiring"))[0]!.payload as ReminderPayload;
    expect(expiring.title).toBe("Invitation expiring: Ida Eingeladen");
    expect(expiring.body).toContain("expires on 20/10/2026");
    expect(expiring.body).toContain("Under Club, Members, Account");
  });

  it("age-transition summary and the notice to the moved member", async () => {
    const cats = await db.select().from(memberCategories).where(eq(memberCategories.clubId, en));
    const youth = cats.find((c) => c.key === "jugend")!;
    await db.update(memberCategories).set({ maxAge: 17, autoTransitionToKey: "aktiv" }).where(eq(memberCategories.id, youth.id));
    await db.update(clubSettings).set({ ageTransitionAuto: true }).where(eq(clubSettings.clubId, en));
    const [kid] = await db.insert(clubMembers).values({ clubId: en, displayName: "Jule Jung", birthDate: "2005-05-05", joinedAt: "2020-01-01", categoryId: youth.id, contactEmail: "jule@example.test" }).returning();
    expect((await runAgeTransitionSweep(new Date("2026-10-18T10:00:00Z"), { clubId: en })).moved).toBe(1);
    const summary = (await reminderJob(en, "age_transition"))[0]!.payload as ReminderPayload;
    expect(summary.title).toBe("Age transition: 1 member moved");
    expect(summary.body).toContain("• 1 member: Jugend → Aktiv");
    expect(summary.body).toContain("(author: system)");
    const [noticeJob] = await db.select().from(jobs).where(and(eq(jobs.type, "age_transition_member_notify"), sql`${jobs.payload}->>'clubMemberId' = ${kid!.id}`));
    await handleAgeTransitionMemberNotify({ id: noticeJob!.id, type: noticeJob!.type, payload: noticeJob!.payload, attempt: 1, maxAttempts: 3 });
    const mail = (await deliveries(en, "member.category_changed")).find((d) => d.channel === "email")!;
    expect(mail.content).toMatchObject({ lang: "en", title: "New membership category: Aktiv" });
    expect((mail.content as { body: string }).body).toContain("Reason: the age limit of the previous category has been reached.");
  });

  it("exit effective digest", async () => {
    const [leaver] = await db.insert(clubMembers).values({ clubId: en, displayName: "Leo Leaver", joinedAt: "2020-01-01", leftAt: "2026-10-18" }).returning();
    await runExitEffectiveSweep(new Date("2026-10-18T10:00:00Z"), { clubId: en });
    const [job] = await db.select().from(jobs).where(and(eq(jobs.type, EXIT_EFFECTIVE_NOTIFY_JOB_TYPE), sql`${jobs.payload}->>'clubMemberId' = ${leaver!.id}`));
    await handleExitEffectiveNotify({ id: job!.id, type: job!.type, payload: job!.payload, attempt: 1, maxAttempts: 3 });
    const row = (await inApp(en, "member.exit_effective"))[0]!;
    expect(row).toMatchObject({ lang: "en", title: "Exit effective: Leo Leaver" });
    expect(row.body).toBe("The membership of Leo Leaver ended on 18/10/2026.\nThere are no open loans or keys.");
  });

  it("the invitation mail and the security notices have English variants", () => {
    const de1 = buildMemberInviteEmail({ name: "Ida", clubName: "TV", url: "https://example.org/e?token=x", expiresOn: "01.11.2026" });
    const en1 = buildMemberInviteEmail({ name: "Ida", clubName: "TV", url: "https://example.org/e?token=x", expiresOn: "01/11/2026", lang: "en" });
    expect(de1).toContain("lädt dich ein");
    expect(en1).toContain("invites you to create or link your member account");
    expect(en1).toContain("Accept invitation");
    expect(en1).toContain('<html lang="en">');
    expect(en1).not.toContain("lädt dich ein");
  });
});
