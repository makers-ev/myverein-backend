import { and, eq } from "drizzle-orm";

import { member, organization, user } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { clubMembers } from "../db/schema/club-members.js";
import { guardianLinks } from "../db/schema/guardian-links.js";
import { roleTypesWithPermission } from "./club-permissions.js";
import { clubMailLanguage, loadClubSettings } from "./club-settings.js";
import { SITE_URL } from "./emailTemplate.js";
import { logger } from "./logger.js";
import { notifySafely } from "./notify/dispatcher.js";
import { formatIsoDay, tr, type MailLanguage } from "./notify/i18n.js";
import type { NotifyRecipient } from "./notify/types.js";

/**
 * Decision notifications of the admission and exit workflows (Wave 9 B11): class `mandatory` (cannot be switched off),
 * in-app copy for people with an account plus e-mail. Always best effort (`notifySafely`) and called AFTER the decision was
 * committed; a failing dispatch never changes the HTTP result. Left members are addressed explicitly (the audience resolver
 * deliberately skips them), so the recipient is resolved here.
 *
 * Decisions (approved, rejected, exit accepted/rejected/exclusion) also go out as push (G4): mandatory + push always carries the
 * in-app copy and the mail too, the payload is the generic inbox deep link without ids of the person's request.
 *
 * Intake notices (G1): a new admission application or exit request tells the people who review them (`members:write`, class
 * `optional`, category `reminders`, in-app + mail, switch `club_settings.notify_board_requests`); the applicant gets a
 * mandatory receipt on application intake (the exit receipt is `exit.received`).
 */

async function clubNameOf(clubId: string, lang: MailLanguage = "de"): Promise<string> {
  const [club] = await db.select({ name: organization.name }).from(organization).where(eq(organization.id, clubId));
  return club?.name ?? tr(lang, "deinem Verein", "your club");
}

/**
 * The people a decision about a club member reaches: the member themselves (account e-mail and in-app copy, or the contact
 * e-mail of an account-less member) AND the guardians of the member (children), also when the child has an own address.
 * Everybody is listed once: by account, by club member and by e-mail address (a family address gets one mail, the dispatcher
 * covers the second person with the first one's mail).
 */
export async function recipientsForClubMember(clubMemberId: string): Promise<NotifyRecipient[]> {
  const [row] = await db
    .select({ id: clubMembers.id, clubId: clubMembers.clubId, displayName: clubMembers.displayName, firstName: clubMembers.firstName, contactEmail: clubMembers.contactEmail, accountMemberId: clubMembers.memberId, userId: member.userId, userEmail: user.email })
    .from(clubMembers)
    .leftJoin(member, eq(member.id, clubMembers.memberId))
    .leftJoin(user, eq(user.id, member.userId))
    .where(eq(clubMembers.id, clubMemberId));
  if (!row) return [];
  const name = row.firstName?.trim() || row.displayName;
  const own = row.userEmail ?? row.contactEmail;
  const out: NotifyRecipient[] = own || row.userId ? [{ clubMemberId: row.id, userId: row.userId, name, email: own }] : [];
  const guardians = await db
    .select({ clubMemberId: clubMembers.id, userId: member.userId, name: user.name, email: user.email })
    .from(guardianLinks)
    .innerJoin(member, eq(member.id, guardianLinks.guardianMemberId))
    .innerJoin(user, eq(user.id, member.userId))
    .leftJoin(clubMembers, and(eq(clubMembers.memberId, member.id), eq(clubMembers.clubId, row.clubId)))
    .where(eq(guardianLinks.wardClubMemberId, clubMemberId));
  const seenUsers = new Set(out.map((r) => r.userId).filter((v): v is string => !!v));
  for (const g of guardians) {
    if (seenUsers.has(g.userId)) continue;
    seenUsers.add(g.userId);
    out.push({ clubMemberId: g.clubMemberId, userId: g.userId, name: g.name, email: g.email });
  }
  return out;
}

async function recipientForUser(userId: string, fallbackClubMemberId: string | null): Promise<NotifyRecipient[]> {
  const [u] = await db.select({ name: user.name, email: user.email }).from(user).where(eq(user.id, userId));
  if (u?.email) return [{ userId, name: u.name, email: u.email }];
  // No usable account address: the contact e-mail of the member record created from the application.
  return fallbackClubMemberId ? recipientsForClubMember(fallbackClubMemberId) : [];
}

// --- Admission -------------------------------------------------------------------------------------

export interface ApplicationDecision {
  clubId: string;
  applicationId: string;
  /** The applicant's account (the parent for a child application). */
  userId: string;
  /** The member record created or reopened by an approval. */
  clubMemberId?: string | null;
  memberNumber?: number | string | null;
  /** Child applications: the child's name. */
  childName?: string | null;
  /** The text the board addressed to the applicant on rejection (never the internal note). */
  applicantMessage?: string | null;
}

export async function notifyApplicationApproved(d: ApplicationDecision): Promise<void> {
  const lang = await clubMailLanguage(db, d.clubId);
  const clubName = await clubNameOf(d.clubId, lang);
  const number = d.memberNumber !== null && d.memberNumber !== undefined && `${d.memberNumber}` !== "" ? `\n${tr(lang, "Mitgliedsnummer", "Member number")}: ${d.memberNumber}` : "";
  const subject = d.childName ? tr(lang, `der Aufnahmeantrag für ${d.childName}`, `the membership application for ${d.childName}`) : tr(lang, "dein Aufnahmeantrag", "your membership application");
  await notifySafely({
    clubId: d.clubId,
    class: "mandatory",
    eventKey: "application.approved",
    refId: d.applicationId,
    recipients: await recipientForUser(d.userId, d.clubMemberId ?? null),
    content: {
      title: d.childName
        ? tr(lang, `Aufnahme von ${d.childName} bei ${clubName} angenommen`, `Admission of ${d.childName} to ${clubName} approved`)
        : tr(lang, `Dein Aufnahmeantrag bei ${clubName} wurde angenommen`, `Your membership application to ${clubName} was approved`),
      body: tr(lang, `Gute Nachrichten: ${subject} bei ${clubName} wurde angenommen. Willkommen im Verein!${number}`, `Good news: ${subject} to ${clubName} was approved. Welcome to the club!${number}`),
      ctaLabel: tr(lang, "Zum Verein", "Go to the club"),
      ctaUrl: SITE_URL,
      lang,
    },
    channels: ["in_app", "email", "push"],
  });
}

export async function notifyApplicationRejected(d: ApplicationDecision): Promise<void> {
  const lang = await clubMailLanguage(db, d.clubId);
  const clubName = await clubNameOf(d.clubId, lang);
  const message = d.applicantMessage?.trim() ? `\n\n${tr(lang, "Nachricht des Vorstands", "Message from the board")}:\n${d.applicantMessage.trim()}` : "";
  await notifySafely({
    clubId: d.clubId,
    class: "mandatory",
    eventKey: "application.rejected",
    refId: d.applicationId,
    recipients: await recipientForUser(d.userId, d.clubMemberId ?? null),
    content: {
      title: d.childName
        ? tr(lang, `Aufnahme von ${d.childName} bei ${clubName} abgelehnt`, `Admission of ${d.childName} to ${clubName} declined`)
        : tr(lang, `Dein Aufnahmeantrag bei ${clubName} wurde abgelehnt`, `Your membership application to ${clubName} was declined`),
      body: tr(
        lang,
        `${d.childName ? `Der Aufnahmeantrag für ${d.childName}` : "Dein Aufnahmeantrag"} bei ${clubName} wurde leider abgelehnt.${message}`,
        `${d.childName ? `The membership application for ${d.childName}` : "Your membership application"} to ${clubName} was unfortunately declined.${message}`,
      ),
      lang,
    },
    channels: ["in_app", "email", "push"],
  });
}

// --- Exit ------------------------------------------------------------------------------------------

export type ExitMessageKind = "received" | "accepted" | "rejected" | "exclusion";

export interface ExitDecision {
  clubId: string;
  requestId: string;
  clubMemberId: string;
  kind: ExitMessageKind;
  /** Day the exit takes effect (accepted / exclusion). A day that is not in the future reads as "wirksam seit". */
  effectiveOn?: string | null;
  /** Board note (rejection reason, or the stated reason of an exclusion). */
  note?: string | null;
  /** Earliest possible day (receipt confirmation). */
  earliestOn?: string | null;
  /** ISO day "today" (Europe/Berlin) to phrase past/future correctly. */
  today: string;
}

export async function notifyExitDecision(d: ExitDecision): Promise<void> {
  const lang = await clubMailLanguage(db, d.clubId);
  const clubName = await clubNameOf(d.clubId, lang);
  const note = d.note?.trim() ? `\n\n${tr(lang, "Begründung/Hinweis des Vorstands", "Reason/note from the board")}:\n${d.note.trim()}` : "";
  const day = d.effectiveOn ? formatIsoDay(d.effectiveOn, lang) : "";
  const when = d.effectiveOn
    ? d.effectiveOn > d.today
      ? tr(lang, `Der Austritt wird zum ${day} wirksam.`, `The exit takes effect on ${day}.`)
      : tr(lang, `Der Austritt ist seit dem ${day} wirksam.`, `The exit has been in effect since ${day}.`)
    : "";
  let title: string;
  let body: string;
  switch (d.kind) {
    case "received": {
      const earliest = d.earliestOn ? `\n${tr(lang, "Frühestmöglicher Austritt nach Kündigungsfrist", "Earliest possible exit after the notice period")}: ${formatIsoDay(d.earliestOn, lang)}.` : "";
      title = tr(lang, `Deine Austrittsanfrage bei ${clubName} ist eingegangen`, `Your request to leave ${clubName} has been received`);
      body = tr(lang, `Wir haben deine Austrittsanfrage erhalten. Der Vorstand prüft sie und meldet sich bei dir.${earliest}`, `We received your request to leave. The board will review it and get back to you.${earliest}`);
      break;
    }
    case "accepted":
      title = tr(lang, `Dein Austritt bei ${clubName} wurde angenommen`, `Your exit from ${clubName} was approved`);
      body = `${tr(lang, "Deine Austrittsanfrage wurde angenommen.", "Your request to leave was approved.")} ${when}${note}`.trim();
      break;
    case "rejected":
      title = tr(lang, `Deine Austrittsanfrage bei ${clubName} wurde abgelehnt`, `Your request to leave ${clubName} was declined`);
      body = tr(lang, `Deine Austrittsanfrage wurde leider abgelehnt. Du bleibst Mitglied.${note}`, `Your request to leave was unfortunately declined. You remain a member.${note}`);
      break;
    case "exclusion":
      title = tr(lang, `Ausschluss aus ${clubName}`, `Exclusion from ${clubName}`);
      body = `${tr(lang, `Du wurdest aus ${clubName} ausgeschlossen.`, `You have been excluded from ${clubName}.`)} ${when}${note}`.trim();
      break;
  }
  await notifySafely({
    clubId: d.clubId,
    class: "mandatory",
    eventKey: `exit.${d.kind}`,
    refId: d.requestId,
    recipients: await recipientsForClubMember(d.clubMemberId),
    content: { title, body, lang },
    channels: d.kind === "received" ? ["in_app", "email"] : ["in_app", "email", "push"],
  });
}

// --- Intake: board notice + applicant receipt -----------------------------------------------------------

/** Never throws: the request itself is already committed. Logs ids and the error class only. */
async function safely(what: string, ids: Record<string, string>, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const e = err as { name?: string; code?: unknown } | undefined;
    logger.error({ ...ids, errName: e?.name, errCode: e?.code }, `[decision-notify] ${what} failed`);
  }
}

/** The reviewers of requests: everybody with a role that holds `members:write`, no guardians. Optional, so each can opt out of mail. */
const reviewers = () => ({ roleTypes: roleTypesWithPermission("members:write"), includeGuardians: false });

export interface ApplicationReceived {
  clubId: string;
  applicationId: string;
  /** The applicant's account (the parent for a child application). */
  userId: string;
  onBehalfOf?: "self" | "guardian" | null;
}

/** Application intake: the applicant gets a receipt (mandatory, event `application.received`), the board a notice (`application.new`, optional). */
export async function notifyApplicationReceived(d: ApplicationReceived): Promise<void> {
  await safely("application intake", { clubId: d.clubId, applicationId: d.applicationId }, async () => {
    const lang = await clubMailLanguage(db, d.clubId);
    const clubName = await clubNameOf(d.clubId, lang);
    const forChild = d.onBehalfOf === "guardian";
    const [applicant] = await db.select({ name: user.name }).from(user).where(eq(user.id, d.userId));
    await notifySafely({
      clubId: d.clubId,
      class: "mandatory",
      eventKey: "application.received",
      refId: d.applicationId,
      recipients: await recipientForUser(d.userId, null),
      content: {
        title: tr(lang, `Dein Aufnahmeantrag bei ${clubName} ist eingegangen`, `Your membership application to ${clubName} has been received`),
        body: tr(
          lang,
          `Wir haben ${forChild ? "den Aufnahmeantrag für dein Kind" : "deinen Aufnahmeantrag"} erhalten. Der Vorstand prüft ihn und meldet sich bei dir, sobald entschieden ist.`,
          `We received ${forChild ? "the membership application for your child" : "your membership application"}. The board will review it and get back to you as soon as a decision has been made.`,
        ),
        lang,
      },
      channels: ["in_app", "email"],
    });
    if (!(await loadClubSettings(db, d.clubId)).notifyBoardRequests) return;
    await notifySafely({
      clubId: d.clubId,
      class: "optional",
      eventKey: "application.new",
      refId: d.applicationId,
      audience: reviewers(),
      content: {
        title: tr(lang, `Neuer Aufnahmeantrag: ${applicant?.name ?? "Antrag"}`, `New membership application: ${applicant?.name ?? "application"}`),
        body: tr(
          lang,
          `${applicant?.name ?? "Jemand"} hat einen Aufnahmeantrag${forChild ? " für ein Kind" : ""} gestellt. Bitte prüfe ihn unter Verein, Mitglieder, Anträge.`,
          `${applicant?.name ?? "Someone"} submitted a membership application${forChild ? " for a child" : ""}. Please review it under Club, Members, Applications.`,
        ),
        category: "reminders",
        ctaLabel: tr(lang, "Zum Verein", "Go to the club"),
        ctaUrl: SITE_URL,
        lang,
      },
      channels: ["in_app", "email"],
    });
  });
}

export interface ExitRequestReceived {
  clubId: string;
  requestId: string;
  clubMemberId: string;
  desiredEffectiveOn?: string | null;
}

/** A member filed an exit request: the board is told (`exit.new`, optional); the member's own receipt is `exit.received`. */
export async function notifyExitRequestToBoard(d: ExitRequestReceived): Promise<void> {
  await safely("exit request notice", { clubId: d.clubId, requestId: d.requestId }, async () => {
    if (!(await loadClubSettings(db, d.clubId)).notifyBoardRequests) return;
    const [row] = await db.select({ name: clubMembers.displayName }).from(clubMembers).where(eq(clubMembers.id, d.clubMemberId));
    const lang = await clubMailLanguage(db, d.clubId);
    const wish = d.desiredEffectiveOn ? `\n${tr(lang, "Gewünschter Austritt zum", "Requested exit date")}: ${formatIsoDay(d.desiredEffectiveOn, lang)}.` : "";
    await notifySafely({
      clubId: d.clubId,
      class: "optional",
      eventKey: "exit.new",
      refId: d.requestId,
      audience: reviewers(),
      content: {
        title: tr(lang, `Neue Austrittsanfrage: ${row?.name ?? "Mitglied"}`, `New request to leave: ${row?.name ?? "member"}`),
        body: tr(
          lang,
          `${row?.name ?? "Ein Mitglied"} hat eine Austrittsanfrage gestellt.${wish}\nBitte prüfe sie unter Verein, Austritte.`,
          `${row?.name ?? "A member"} filed a request to leave.${wish}\nPlease review it under Club, Exits.`,
        ),
        category: "reminders",
        ctaLabel: tr(lang, "Zum Verein", "Go to the club"),
        ctaUrl: SITE_URL,
        lang,
      },
      channels: ["in_app", "email"],
    });
  });
}
