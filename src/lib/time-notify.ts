import { db } from "../db/client.js";
import type { TimeEntryRow } from "../db/schema/event-extras.js";
import { clubMailLanguage } from "./club-settings.js";
import { clubTimezone, formatWhen } from "./event-notify.js";
import { notifySafely } from "./notify/dispatcher.js";
import { tr } from "./notify/i18n.js";
import type { NotifyResult } from "./notify/types.js";

/**
 * Notifications about the person's own time entry (Wave 16), through the Wave 9 dispatcher (in-app inbox + push; push text is generic).
 * `long_running` (T5) is an optional reminder in the `reminders` category (switchable in the notification settings); `auto_closed` (T4)
 * and `closed_by_other` (T3) change the person's own record and are mandatory (mail fallback). Idempotent through `refId` = `<entry>#<kind>`.
 * Push data: `{ type: "time_entry", timeEntryId }` (see `pushDataFor`).
 */
export type TimeNotice = "long_running" | "auto_closed" | "closed_by_other";

export async function notifyTimeEntry(kind: TimeNotice, entry: Pick<TimeEntryRow, "id" | "clubId" | "clubMemberId" | "startedAt" | "endedAt">): Promise<NotifyResult | null> {
  const lang = await clubMailLanguage(db, entry.clubId);
  const tz = await clubTimezone(entry.clubId);
  const since = formatWhen(entry.startedAt, tz, null, lang);
  const ended = entry.endedAt ? formatWhen(entry.endedAt, tz, null, lang) : "";
  const content =
    kind === "long_running"
      ? {
          title: tr(lang, "Du bist seit 10 Stunden eingestempelt", "You have been clocked in for 10 hours"),
          body: tr(lang, `Hast du vergessen auszustempeln? Dein Eintrag läuft seit ${since}. Beende ihn oder trage das richtige Ende nach.`, `Did you forget to clock out? Your entry has been running since ${since}. Stop it or enter the real end time.`),
          category: "reminders" as const,
          template: "reminder" as const,
        }
      : kind === "auto_closed"
        ? {
            title: tr(lang, "Dein Zeiteintrag wurde automatisch beendet", "Your time entry was ended automatically"),
            body: tr(lang, `Dein Eintrag ab ${since} lief zu lange und wurde automatisch beendet. Das Ende wurde auf ${ended} gesetzt (16 Stunden nach dem Start). Bitte prüfe die Zeit und korrigiere sie, bevor er bestätigt wird.`, `Your entry from ${since} ran too long and was ended automatically at ${ended} (16 hours after the start). Please check the time and correct it before it is confirmed.`),
            template: "notice" as const,
          }
        : {
            title: tr(lang, "Dein Zeiteintrag wurde beendet", "Your time entry was ended"),
            body: tr(lang, `Dein Eintrag ab ${since} lief zu lange und wurde von der Vereinsleitung beendet${ended ? ` (Ende: ${ended})` : ""}. Bitte prüfe die Zeit in der Zeiterfassung.`, `Your entry from ${since} ran too long and was ended by the club management${ended ? ` (end: ${ended})` : ""}. Please check the time in time tracking.`),
            template: "notice" as const,
          };
  return notifySafely({
    clubId: entry.clubId,
    class: kind === "long_running" ? "optional" : "mandatory",
    eventKey: `time.${kind}`,
    refId: `${entry.id}#${kind}`,
    audience: { memberIds: [entry.clubMemberId] },
    content: { ...content, lang },
    channels: ["in_app", "push"],
  });
}
