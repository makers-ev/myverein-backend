import { eq } from "drizzle-orm";

import { member, organization, user } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { clubMembers } from "../db/schema/club-members.js";
import { guardianLinks } from "../db/schema/guardian-links.js";
import { SITE_URL } from "./emailTemplate.js";
import { notifySafely } from "./notify/dispatcher.js";
import type { NotifyRecipient } from "./notify/types.js";

/**
 * Decision notifications of the admission and exit workflows (Wave 9 B11): class `mandatory` (cannot be switched off),
 * in-app copy for people with an account plus e-mail. Always best effort (`notifySafely`) and called AFTER the decision was
 * committed; a failing dispatch never changes the HTTP result. Left members are addressed explicitly (the audience resolver
 * deliberately skips them), so the recipient is resolved here.
 */

const formatDate = (iso: string): string => {
  const [y, m, d] = iso.split("-");
  return y && m && d ? `${d}.${m}.${y}` : iso;
};

async function clubNameOf(clubId: string): Promise<string> {
  const [club] = await db.select({ name: organization.name }).from(organization).where(eq(organization.id, clubId));
  return club?.name ?? "deinem Verein";
}

/**
 * The person affected by a decision: their account (e-mail of the account, in-app) or, without an account, the contact
 * e-mail of the member record; a member without any own address falls back to the guardians (children).
 */
export async function recipientsForClubMember(clubMemberId: string): Promise<NotifyRecipient[]> {
  const [row] = await db
    .select({ id: clubMembers.id, displayName: clubMembers.displayName, firstName: clubMembers.firstName, contactEmail: clubMembers.contactEmail, accountMemberId: clubMembers.memberId, userId: member.userId, userEmail: user.email })
    .from(clubMembers)
    .leftJoin(member, eq(member.id, clubMembers.memberId))
    .leftJoin(user, eq(user.id, member.userId))
    .where(eq(clubMembers.id, clubMemberId));
  if (!row) return [];
  const name = row.firstName?.trim() || row.displayName;
  const own = row.userEmail ?? row.contactEmail;
  if (own || row.userId) return [{ clubMemberId: row.id, userId: row.userId, name, email: own }];
  const guardians = await db
    .select({ clubMemberId: clubMembers.id, userId: member.userId, name: user.name, email: user.email })
    .from(guardianLinks)
    .innerJoin(member, eq(member.id, guardianLinks.guardianMemberId))
    .innerJoin(user, eq(user.id, member.userId))
    .leftJoin(clubMembers, eq(clubMembers.memberId, member.id))
    .where(eq(guardianLinks.wardClubMemberId, clubMemberId));
  return guardians.map((g) => ({ clubMemberId: g.clubMemberId, userId: g.userId, name: g.name, email: g.email }));
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
  const clubName = await clubNameOf(d.clubId);
  const number = d.memberNumber !== null && d.memberNumber !== undefined && `${d.memberNumber}` !== "" ? `\nMitgliedsnummer: ${d.memberNumber}` : "";
  const subject = d.childName ? `der Aufnahmeantrag für ${d.childName}` : "dein Aufnahmeantrag";
  await notifySafely({
    clubId: d.clubId,
    class: "mandatory",
    eventKey: "application.approved",
    refId: d.applicationId,
    recipients: await recipientForUser(d.userId, d.clubMemberId ?? null),
    content: {
      title: d.childName ? `Aufnahme von ${d.childName} bei ${clubName} angenommen` : `Dein Aufnahmeantrag bei ${clubName} wurde angenommen`,
      body: `Gute Nachrichten: ${subject} bei ${clubName} wurde angenommen. Willkommen im Verein!${number}`,
      ctaLabel: "Zum Verein",
      ctaUrl: SITE_URL,
    },
    channels: ["in_app", "email"],
  });
}

export async function notifyApplicationRejected(d: ApplicationDecision): Promise<void> {
  const clubName = await clubNameOf(d.clubId);
  const message = d.applicantMessage?.trim() ? `\n\nNachricht des Vorstands:\n${d.applicantMessage.trim()}` : "";
  await notifySafely({
    clubId: d.clubId,
    class: "mandatory",
    eventKey: "application.rejected",
    refId: d.applicationId,
    recipients: await recipientForUser(d.userId, d.clubMemberId ?? null),
    content: {
      title: d.childName ? `Aufnahme von ${d.childName} bei ${clubName} abgelehnt` : `Dein Aufnahmeantrag bei ${clubName} wurde abgelehnt`,
      body: `${d.childName ? `Der Aufnahmeantrag für ${d.childName}` : "Dein Aufnahmeantrag"} bei ${clubName} wurde leider abgelehnt.${message}`,
    },
    channels: ["in_app", "email"],
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
  const clubName = await clubNameOf(d.clubId);
  const note = d.note?.trim() ? `\n\nBegründung/Hinweis des Vorstands:\n${d.note.trim()}` : "";
  const when = d.effectiveOn ? (d.effectiveOn > d.today ? `Der Austritt wird zum ${formatDate(d.effectiveOn)} wirksam.` : `Der Austritt ist seit dem ${formatDate(d.effectiveOn)} wirksam.`) : "";
  let title: string;
  let body: string;
  switch (d.kind) {
    case "received":
      title = `Deine Austrittsanfrage bei ${clubName} ist eingegangen`;
      body = `Wir haben deine Austrittsanfrage erhalten. Der Vorstand prüft sie und meldet sich bei dir.${d.earliestOn ? `\nFrühestmöglicher Austritt nach Kündigungsfrist: ${formatDate(d.earliestOn)}.` : ""}`;
      break;
    case "accepted":
      title = `Dein Austritt bei ${clubName} wurde angenommen`;
      body = `Deine Austrittsanfrage wurde angenommen. ${when}${note}`.trim();
      break;
    case "rejected":
      title = `Deine Austrittsanfrage bei ${clubName} wurde abgelehnt`;
      body = `Deine Austrittsanfrage wurde leider abgelehnt. Du bleibst Mitglied.${note}`;
      break;
    case "exclusion":
      title = `Ausschluss aus ${clubName}`;
      body = `Du wurdest aus ${clubName} ausgeschlossen. ${when}${note}`.trim();
      break;
  }
  await notifySafely({
    clubId: d.clubId,
    class: "mandatory",
    eventKey: `exit.${d.kind}`,
    refId: d.requestId,
    recipients: await recipientsForClubMember(d.clubMemberId),
    content: { title, body },
    channels: ["in_app", "email"],
  });
}
