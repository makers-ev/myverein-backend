import { and, eq, inArray } from "drizzle-orm";

import { db } from "../../db/client.js";
import { clubAnnouncements, messageDeliveries, notificationPreferences, type AnnouncementAudience, type CommunicationChannel } from "../../db/schema/communication.js";
import { writeAudit } from "../../lib/audit.js";
import { schedulePublish, sendAnnouncement } from "../../lib/announcements.js";
import { accountOf, clubMemberOf, type DemoCtx } from "./context.js";

/** Opt-outs of single people (set BEFORE the announcements go out, so the delivery list shows skipped_optout). */
export async function seedNotificationPreferences(ctx: DemoCtx): Promise<void> {
  const user = (key: string) => accountOf(ctx, key).userId;
  await db.insert(notificationPreferences).values([
    // global defaults of an account
    { userId: user("mitglied"), clubId: null, category: "announcements", channel: "email", enabled: false },
    { userId: user("eltern"), clubId: null, category: "announcements", channel: "push", enabled: false },
    { userId: user("stellv"), clubId: null, category: "reminders", channel: "push", enabled: false },
    // override for this club only (wins over the global setting)
    { userId: user("mitglied"), clubId: ctx.clubId, category: "events", channel: "email", enabled: true },
    { userId: user("trainer"), clubId: ctx.clubId, category: "events", channel: "email", enabled: false },
    // a member without an account (the board keeps the preference for them)
    { clubMemberId: clubMemberOf(ctx, "noah"), clubId: null, category: "announcements", channel: "email", enabled: false },
  ]);
  ctx.log("Benachrichtigungseinstellungen: global, pro Verein und für Mitglieder ohne Konto");
}

interface AnnouncementSpec {
  author: string;
  title: string;
  body: string;
  audience: AnnouncementAudience;
  channels: CommunicationChannel[];
  urgent?: boolean;
  pinned?: boolean;
  /** Seed state: sent now (default), a draft, scheduled in `inDays` days, cancelled. */
  state?: "sent" | "draft" | "scheduled" | "cancelled";
  inDays?: number;
  /** Sent this many days ago (the deliveries are dated back). */
  sentDaysAgo?: number;
  expiresInDays?: number;
}

const ANNOUNCEMENTS: AnnouncementSpec[] = [
  { author: "vorsitz", title: "Willkommen im digitalen Vereinsleben", body: "Ab sofort finden Sie Termine, Sitzungen, Abstimmungen und Mitteilungen in einer App. Bei Fragen melden Sie sich beim Vorstand.", audience: { all: true }, channels: ["in_app"], pinned: true, sentDaysAgo: 30 },
  { author: "vorsitz", title: "Sportplatz gesperrt: Training fällt aus", body: "Nach dem Sturmschaden bleibt der Platz bis zur Reparatur gesperrt. Das Dienstagstraining entfällt, wir informieren über Ersatzmöglichkeiten.", audience: { all: true }, channels: ["in_app", "push"], urgent: true, sentDaysAgo: 1 },
  { author: "trainer", title: "Fußball: Treffpunkt zum Auswärtsspiel", body: "Wir treffen uns am Samstag um 12:30 Uhr am Vereinsheim. Fahrgemeinschaften bitte in der App melden.", audience: { departmentIds: ["fussball"] }, channels: ["in_app"], sentDaysAgo: 3 },
  { author: "schrift", title: "Einladung zum Sommerfest", body: "Wir feiern gemeinsam mit Familie und Freunden. Bitte melden Sie sich im Terminkalender an, damit wir planen können.", audience: { all: true, includeGuardians: true }, channels: ["in_app", "email"], sentDaysAgo: 6 },
  { author: "beisitz", title: "Elterninfo Kinderturnen", body: "Das Schnuppertraining für neue Kinder findet bald statt. Eltern melden ihre Kinder über die App an, die Plätze sind begrenzt.", audience: { categoryKeys: ["kind"], includeGuardians: true }, channels: ["in_app"], sentDaysAgo: 8 },
  { author: "vorsitz", title: "Erinnerung: Anmeldung zum Sommerfest bis Freitag", body: "Bitte denken Sie an die Anmeldung zum Sommerfest.", audience: { all: true }, channels: ["in_app"], state: "scheduled", inDays: 2 },
  { author: "schrift", title: "Entwurf: Jahresrückblick für die Vereinszeitung", body: "Stichworte: Kunstrasen, Jugendarbeit, Wahlen, neue Abteilungsleitung.", audience: { all: true }, channels: ["in_app", "email"], state: "draft" },
  { author: "vorsitz", title: "Hallenbad vorübergehend geschlossen", body: "Das Schwimmtraining ist bis Monatsende verlegt.", audience: { departmentIds: ["schwimmen"] }, channels: ["in_app"], sentDaysAgo: 40, expiresInDays: -10 },
  { author: "stellv", title: "Mitgliederbefragung abgesagt", body: "Die geplante Befragung findet erst im nächsten Jahr statt.", audience: { all: true }, channels: ["in_app"], state: "cancelled" },
];

/** Club bulletin: pinned, urgent, department, category-and-guardian, scheduled, draft, expired and cancelled announcements with real delivery rows. */
export async function seedAnnouncements(ctx: DemoCtx): Promise<void> {
  const readers = ["vorsitz", "schrift", "trainer", "mitglied"];
  for (const a of ANNOUNCEMENTS) {
    const author = accountOf(ctx, a.author);
    const audience: AnnouncementAudience = { ...a.audience, ...(a.audience.departmentIds ? { departmentIds: a.audience.departmentIds.map((k) => ctx.dept[k]!) } : {}) };
    const state = a.state ?? "sent";
    const publishAt = state === "scheduled" ? new Date(ctx.now.getTime() + (a.inDays ?? 1) * 86_400_000) : null;
    const [row] = await db
      .insert(clubAnnouncements)
      .values({
        clubId: ctx.clubId,
        authorMemberId: author.clubMemberId,
        title: a.title,
        body: a.body,
        audience,
        channels: a.channels,
        urgent: a.urgent ?? false,
        pinned: a.pinned ?? false,
        publishAt,
        expiresAt: a.expiresInDays === undefined ? null : new Date(ctx.now.getTime() + a.expiresInDays * 86_400_000),
        status: state === "cancelled" ? "cancelled" : state === "scheduled" ? "scheduled" : "draft",
      })
      .returning();
    if (state === "scheduled") {
      await schedulePublish(row!);
      await writeAudit(db, { eventType: "club_announcement.schedule", subjectId: row!.id, actorUserId: author.userId, payload: { actor: author.userId, clubId: ctx.clubId, publishAt: publishAt!.toISOString() } });
    }
    if (state !== "sent") continue;
    const sent = await sendAnnouncement(ctx.clubId, row!.id, { actorUserId: author.userId });
    if (!sent.sent) throw new Error(`Announcement "${a.title}" could not be sent: ${sent.reason}`);
    const when = new Date(ctx.now.getTime() - (a.sentDaysAgo ?? 0) * 86_400_000);
    if (a.sentDaysAgo) {
      await db.update(clubAnnouncements).set({ createdAt: when, updatedAt: when, sentAt: when }).where(eq(clubAnnouncements.id, row!.id));
      await db.update(messageDeliveries).set({ createdAt: when, sentAt: when }).where(eq(messageDeliveries.announcementId, row!.id));
    }
    // A few recipients have read it already.
    await db
      .update(messageDeliveries)
      .set({ readAt: when })
      .where(and(eq(messageDeliveries.announcementId, row!.id), eq(messageDeliveries.channel, "in_app"), inArray(messageDeliveries.userId, readers.map((k) => accountOf(ctx, k).userId))));
  }
  ctx.log(`${ANNOUNCEMENTS.length} Mitteilungen (gesendet, dringend, Abteilung, Kinder+Eltern, geplant, Entwurf, abgelaufen, abgebrochen)`);
}
