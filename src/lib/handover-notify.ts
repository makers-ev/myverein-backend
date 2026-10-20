import { eq } from "drizzle-orm";

import { db } from "../db/client.js";
import { clubMembers } from "../db/schema/club-members.js";
import { clubTimezone, clubMemberIdsOf, formatWhen } from "./event-notify.js";
import { loadClubSettings } from "./club-settings.js";
import { logger } from "./logger.js";
import { notifySafely } from "./notify/dispatcher.js";

/**
 * Handover notifications (G7): handing out, returning or extending a loan, and handing out or taking back a key, tell the
 * borrower / key holder. Class `optional`, category `reminders`, in-app + mail, event keys `loan.issued|returned|extended`
 * and `key.issued|returned`; the guardians of a child holder are told too (so the texts are neutral, naming the person).
 * Switch `club_settings.notify_handover`. The leadership digests (`reminder.maintenance`, `member.exit_effective`) and the
 * due / overdue reminders are unchanged. Called AFTER the business transaction committed; never throws.
 *
 * Self-service: loans are borrowed by the caller themself, so the borrowing confirmation is the written proof (always sent);
 * a return or an extension, and every key action, is NOT sent when the actor is the affected person (they just did it).
 */

export type HandoverKind = "loan.issued" | "loan.returned" | "loan.extended" | "key.issued" | "key.returned";

export interface HandoverInput {
  clubId: string;
  kind: HandoverKind;
  /** Delivery `ref_id`: loan id (issued, returned), `<loanId>#<new due ms>` (extended), key history entry id (key.*). */
  refId: string;
  /** `member.id` of the borrower / key holder. */
  accountMemberId: string;
  /** `member.id` of the person who did it. */
  actorAccountMemberId: string;
  /** Item name (loans) or location name (keys). */
  subject: string;
  /** Key label (keys) or nothing. */
  keyLabel?: string | null;
  /** Loans: the due date after the action / before it (extension). */
  dueAt?: Date | null;
  previousDueAt?: Date | null;
}

const SELF_PROOF: ReadonlySet<HandoverKind> = new Set(["loan.issued"]);

export async function notifyHandover(input: HandoverInput): Promise<void> {
  try {
    if (input.accountMemberId === input.actorAccountMemberId && !SELF_PROOF.has(input.kind)) return;
    if (!(await loadClubSettings(db, input.clubId)).notifyHandover) return;
    const [clubMemberId] = await clubMemberIdsOf(input.clubId, [input.accountMemberId]);
    if (!clubMemberId) return;
    const [person] = await db.select({ name: clubMembers.displayName }).from(clubMembers).where(eq(clubMembers.id, clubMemberId));
    const name = person?.name ?? "Mitglied";
    const timezone = await clubTimezone(input.clubId);
    const day = (date: Date) => formatWhen(date, timezone).split(", ").slice(0, 2).join(", ");
    const label = input.keyLabel ? ` (${input.keyLabel})` : "";
    let title: string;
    let body: string;
    switch (input.kind) {
      case "loan.issued":
        title = `Ausleihe: ${input.subject}`;
        body = `„${input.subject}“ wurde an ${name} ausgeliehen.\n${input.dueAt ? `Rückgabe bis: ${day(input.dueAt)}.` : "Ein Rückgabedatum wurde nicht festgelegt."}`;
        break;
      case "loan.returned":
        title = `Rückgabe bestätigt: ${input.subject}`;
        body = `„${input.subject}“ wurde von ${name} zurückgegeben. Danke!`;
        break;
      case "loan.extended":
        title = `Rückgabe verlängert: ${input.subject}`;
        body = `Die Rückgabe von „${input.subject}“ (${name}) wurde ${input.dueAt ? `auf den ${day(input.dueAt)}` : "neu"} verlängert.${input.previousDueAt ? `\nBisher: ${day(input.previousDueAt)}.` : ""}`;
        break;
      case "key.issued":
        title = `Schlüsselausgabe: ${input.subject}`;
        body = `Ein Schlüssel${label} für „${input.subject}“ wurde an ${name} übergeben.\nBitte gib ihn zurück, sobald du ihn nicht mehr brauchst.`;
        break;
      case "key.returned":
        title = `Schlüsselrückgabe: ${input.subject}`;
        body = `Der Schlüssel${label} für „${input.subject}“ wurde von ${name} zurückgegeben. Danke!`;
        break;
    }
    await notifySafely({
      clubId: input.clubId,
      class: "optional",
      eventKey: input.kind,
      refId: input.refId,
      audience: { memberIds: [clubMemberId], includeGuardians: true },
      content: { title, body, category: "reminders", template: "announcement" },
      channels: ["in_app", "email"],
    });
  } catch (err) {
    const e = err as { name?: string; code?: unknown } | undefined;
    logger.error({ kind: input.kind, refId: input.refId, errName: e?.name, errCode: e?.code }, "[handover-notify] could not announce handover");
  }
}
