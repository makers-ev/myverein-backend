import { createHash } from "node:crypto";

import { and, asc, eq, inArray, isNull, max, sql } from "drizzle-orm";

import { member, user } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { meetingAgendaItems, meetingInvitationDeliveries, meetingInvitations, type MeetingAgendaItemRow, type MeetingInvitationRow } from "../db/schema/assembly.js";
import { clubMembers } from "../db/schema/club-members.js";
import { messageDeliveries } from "../db/schema/communication.js";
import { locations } from "../db/schema/locations.js";
import { meetingInvitees, meetings, type MeetingRow } from "../db/schema/meetings.js";
import { writeAudit } from "./audit.js";
import { isEligible, loadEligibility } from "./assembly-attendance.js";
import { loadAssemblyRules, missingAssemblyRules, type AssemblyRules } from "./assembly-rules.js";
import { normalizeEmail } from "./audience.js";
import { loadClubSettings } from "./club-settings.js";
import { ConflictError, ValidationError } from "./errors.js";
import { formatWhen } from "./event-notify.js";
import { checkInvitationPeriod, type PeriodCheck } from "./invitation-period.js";
import { logger } from "./logger.js";
import { effectiveStatus, isLeftStatus, todayBerlin } from "./member-lifecycle.js";
import { notify } from "./notify/dispatcher.js";
import { tr, type MailLanguage } from "./notify/i18n.js";
import { APP_NAME, SITE_URL } from "./emailTemplate.js";

/**
 * Formal invitation to a general assembly (Wave 11 B3): recipients (also members without an account), content snapshot with
 * hash, period check, delivery proof per member and channel. Delivery of the messages itself is the Wave 9 dispatcher
 * (mandatory class: an invitation ignores notification preferences); this module keeps the proof in
 * `meeting_invitation_deliveries` and derives its status from `message_deliveries` when it is read.
 */

export const INVITATION_EVENT_KEY = "meeting.invitation";

export interface InvitationRecipient {
  clubMemberId: string;
  accountMemberId: string | null;
  userId: string | null;
  displayName: string;
  firstName: string | null;
  /** Normalised address: the account e-mail, else the contact e-mail of the member; null = none. */
  email: string | null;
}

/** Everyone who is a member on `today` (not left, not just an interested person), with account and address if there is one. */
export async function loadInvitationRecipients(clubId: string, today: string = todayBerlin()): Promise<InvitationRecipient[]> {
  const rows = await db
    .select({
      clubMemberId: clubMembers.id,
      accountMemberId: clubMembers.memberId,
      userId: member.userId,
      displayName: clubMembers.displayName,
      firstName: clubMembers.firstName,
      status: clubMembers.status,
      leftAt: clubMembers.leftAt,
      accountEmail: user.email,
      contactEmail: clubMembers.contactEmail,
    })
    .from(clubMembers)
    .leftJoin(member, eq(member.id, clubMembers.memberId))
    .leftJoin(user, eq(user.id, member.userId))
    .where(eq(clubMembers.clubId, clubId))
    .orderBy(asc(clubMembers.displayName), asc(clubMembers.id));
  return rows
    .filter((r) => r.status !== "interessent" && !isLeftStatus(effectiveStatus({ status: r.status, leftAt: r.leftAt }, today)))
    .map((r) => ({
      clubMemberId: r.clubMemberId,
      accountMemberId: r.accountMemberId,
      userId: r.userId ?? null,
      displayName: r.displayName,
      firstName: r.firstName,
      email: normalizeEmail(r.accountEmail) ?? normalizeEmail(r.contactEmail),
    }));
}

export interface PlannedDelivery {
  clubMemberId: string;
  channel: "email" | "inapp" | "post";
  /** For a shared address: the member whose mail covers this one. */
  coveredBy?: string;
  errorCode?: string;
}

/**
 * Which channels reach whom. Accounts get in-app (+ push); everybody with an address gets the mail (a shared address is mailed
 * once, the other holders are covered by it); members with neither account nor address get the post list; with the statute form
 * `schriftlich` everybody is on the post list.
 */
export function planDeliveries(recipients: readonly InvitationRecipient[], form: "textform" | "schriftlich"): PlannedDelivery[] {
  const owners = new Map<string, string>();
  const out: PlannedDelivery[] = [];
  for (const r of recipients) {
    if (r.userId) out.push({ clubMemberId: r.clubMemberId, channel: "inapp" });
    if (r.email) {
      const owner = owners.get(r.email);
      if (owner === undefined) {
        owners.set(r.email, r.clubMemberId);
        out.push({ clubMemberId: r.clubMemberId, channel: "email" });
      } else {
        out.push({ clubMemberId: r.clubMemberId, channel: "email", coveredBy: owner, errorCode: `shared_address:${owner}` });
      }
    }
    if ((!r.email && !r.userId) || form === "schriftlich") out.push({ clubMemberId: r.clubMemberId, channel: "post", ...(r.email || r.userId ? {} : { errorCode: "no_address" }) });
  }
  return out;
}

export interface InvitationContent extends Record<string, unknown> {
  kind: "einladung" | "nachtrag";
  title: string;
  scheduledAt: string | null;
  place: string | null;
  participationMode: string;
  agenda: Array<{ position: number; title: string; description: string | null; voteKind: string; topic: string }>;
  /** Legacy free-text agenda of the meeting. */
  agendaText: string | null;
  message: string | null;
}

/** JSON with sorted object keys, so the same content always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export const hashContent = (value: unknown): string => createHash("sha256").update(canonicalJson(value)).digest("hex");

/** Plain-text title and body of the message that goes to the members. */
export function composeInvitationMessage(content: InvitationContent, lang: MailLanguage, timezone: string): { title: string; body: string } {
  const when = formatWhen(content.scheduledAt ? new Date(content.scheduledAt) : null, timezone, null, lang);
  const heading = content.kind === "nachtrag" ? tr(lang, "Nachtrag zur Einladung", "Addendum to the invitation") : tr(lang, "Einladung", "Invitation");
  const lines = [
    content.kind === "nachtrag"
      ? tr(lang, `Zur Einladung „${content.title}“ gibt es einen Nachtrag zur Tagesordnung.`, `There is an addendum to the agenda of the invitation “${content.title}”.`)
      : tr(lang, `Du bist zu „${content.title}“ eingeladen.`, `You are invited to “${content.title}”.`),
    `${tr(lang, "Wann", "When")}: ${when}`,
    ...(content.place ? [`${tr(lang, "Ort", "Location")}: ${content.place}`] : []),
  ];
  if (content.message) lines.push("", content.message);
  if (content.agenda.length > 0) {
    lines.push("", `${tr(lang, "Tagesordnung", "Agenda")}:`);
    for (const item of content.agenda) lines.push(`${item.position}. ${item.title}${item.description ? ` – ${item.description}` : ""}`);
  } else if (content.agendaText?.trim()) {
    lines.push("", `${tr(lang, "Tagesordnung", "Agenda")}:`, content.agendaText.trim());
  }
  return { title: `${heading}: ${content.title}`, body: lines.join("\n") };
}

export type InvitationAudience = "all_members" | "voting_members";

/** `voting_members` keeps only the members with a voting right on the meeting day (frozen roll, else live derivation). */
async function audienceOf(clubId: string, meeting: MeetingRow, audience: InvitationAudience): Promise<InvitationRecipient[]> {
  const recipients = await loadInvitationRecipients(clubId);
  if (audience === "all_members") return recipients;
  const eligibility = await loadEligibility(db, clubId, meeting);
  return recipients.filter((r) => isEligible(eligibility, r.clubMemberId));
}

export interface InvitationPreview {
  kind: "einladung" | "nachtrag";
  period: PeriodCheck;
  missingRules: string[];
  agendaCount: number;
  newAgendaCount: number;
  agendaRequiredButEmpty: boolean;
  recipients: { total: number; email: number; inapp: number; post: number; sharedAddress: number };
}

async function loadAgenda(meetingId: string): Promise<MeetingAgendaItemRow[]> {
  return db.select().from(meetingAgendaItems).where(eq(meetingAgendaItems.meetingId, meetingId)).orderBy(asc(meetingAgendaItems.position), asc(meetingAgendaItems.createdAt));
}

function summarize(planned: PlannedDelivery[], total: number) {
  return {
    total,
    email: planned.filter((p) => p.channel === "email" && !p.coveredBy).length,
    inapp: planned.filter((p) => p.channel === "inapp").length,
    post: planned.filter((p) => p.channel === "post").length,
    sharedAddress: planned.filter((p) => p.coveredBy).length,
  };
}

/** What sending now would do (period, rules, recipients); changes nothing. */
export async function previewInvitation(clubId: string, meeting: MeetingRow, now: Date = new Date(), audience: InvitationAudience = "all_members"): Promise<InvitationPreview> {
  const [rules, settings, agenda, [prior]] = await Promise.all([
    loadAssemblyRules(db, clubId),
    loadClubSettings(db, clubId),
    loadAgenda(meeting.id),
    db.select({ n: max(meetingInvitations.version) }).from(meetingInvitations).where(eq(meetingInvitations.meetingId, meeting.id)),
  ]);
  const recipients = await audienceOf(clubId, meeting, audience);
  const planned = planDeliveries(recipients, rules.invitationForm ?? "textform");
  return {
    kind: prior?.n ? "nachtrag" : "einladung",
    period: checkInvitationPeriod(meeting, rules, now, settings.timezone),
    missingRules: missingAssemblyRules(rules),
    agendaCount: agenda.length,
    newAgendaCount: agenda.filter((a) => a.announcedInInvitationId === null).length,
    agendaRequiredButEmpty: rules.agendaRequiredInInvitation === true && agenda.length === 0 && !meeting.agenda?.trim(),
    recipients: summarize(planned, recipients.length),
  };
}

export interface SendInvitationInput {
  clubId: string;
  meeting: MeetingRow;
  actorUserId: string;
  message?: string | null | undefined;
  /** Reason for sending although the period is violated; recorded with the invitation and shown in the minutes. */
  exceptionReason?: string | undefined;
  /** Default `all_members`: the statute usually invites everybody, `voting_members` only those who may vote. */
  audience?: InvitationAudience | undefined;
  now?: Date;
}

/** Sends the invitation (or the Nachtrag). Throws `ValidationError` with a `details.code` for every refusal. */
export async function sendInvitation(input: SendInvitationInput): Promise<{ invitation: MeetingInvitationRow; summary: ReturnType<typeof summarize> }> {
  const { clubId, meeting } = input;
  const now = input.now ?? new Date();
  const rules = await loadAssemblyRules(db, clubId);
  const settings = await loadClubSettings(db, clubId);

  if (meeting.type !== "mitgliederversammlung") throw new ValidationError("Only a general assembly is invited to formally", { details: { code: "invitation_not_supported" } });
  if (meeting.status !== "geplant") throw new ValidationError("Only a planned meeting can be invited to", { details: { code: "meeting_not_planned" } });
  const missing = missingAssemblyRules(rules);
  if (missing.length > 0) throw new ValidationError("The statute parameters are incomplete", { details: { code: "assembly_rules_incomplete", missing } });

  const period = checkInvitationPeriod(meeting, rules, now, settings.timezone);
  if (period.reason === "no_date") throw new ValidationError("The meeting has no date yet", { details: { code: "meeting_without_date" } });
  const exceptionReason = input.exceptionReason?.trim() || undefined;
  if (!period.ok && !exceptionReason) {
    throw new ValidationError("The invitation period is not met", { details: { code: "invitation_period_violated", ...period } });
  }

  const recipients = await audienceOf(clubId, meeting, input.audience ?? "all_members");
  const planned = planDeliveries(recipients, rules.invitationForm ?? "textform");
  const placeRow = meeting.locationId ? (await db.select({ name: locations.name }).from(locations).where(and(eq(locations.id, meeting.locationId), eq(locations.clubId, clubId))))[0] : undefined;

  const created = await db.transaction(async (tx) => {
    // Serialise invitations of one meeting: the version number and the "announced" marker must not interleave.
    const [locked] = await tx.select({ id: meetings.id, rulesSnapshot: meetings.rulesSnapshot }).from(meetings).where(and(eq(meetings.id, meeting.id), eq(meetings.clubId, clubId))).for("update");
    if (!locked) throw new ConflictError("Meeting no longer exists");
    const [prior] = await tx.select({ n: max(meetingInvitations.version) }).from(meetingInvitations).where(eq(meetingInvitations.meetingId, meeting.id));
    const version = (prior?.n ?? 0) + 1;
    const kind = version === 1 ? ("einladung" as const) : ("nachtrag" as const);
    const agenda = await tx.select().from(meetingAgendaItems).where(eq(meetingAgendaItems.meetingId, meeting.id)).orderBy(asc(meetingAgendaItems.position), asc(meetingAgendaItems.createdAt));
    const fresh = agenda.filter((a) => a.announcedInInvitationId === null);
    if (kind === "einladung" && rules.agendaRequiredInInvitation === true && agenda.length === 0 && !meeting.agenda?.trim()) {
      throw new ValidationError("The statute requires the agenda in the invitation", { details: { code: "agenda_required" } });
    }
    if (kind === "nachtrag" && fresh.length === 0) throw new ValidationError("There is no new agenda item to announce", { details: { code: "nothing_to_add" } });

    const content: InvitationContent = {
      kind,
      title: meeting.title,
      scheduledAt: meeting.scheduledAt?.toISOString() ?? null,
      place: placeRow?.name ?? null,
      participationMode: meeting.participationMode,
      agenda: agenda.map((a, i) => ({ position: i + 1, title: a.title, description: a.description, voteKind: a.voteKind, topic: a.topic })),
      agendaText: meeting.agenda?.trim() || null,
      message: input.message?.trim() || null,
    };
    const [invitation] = await tx
      .insert(meetingInvitations)
      .values({
        meetingId: meeting.id,
        version,
        kind,
        sentBy: input.actorUserId,
        sentAt: now,
        content,
        contentHash: hashContent(content),
        rulesSnapshot: rules,
        periodCheck: { ...period },
        exceptionReason: exceptionReason ?? null,
        recipientCount: recipients.length,
      })
      .returning();
    for (let i = 0; i < planned.length; i += 500) {
      await tx.insert(meetingInvitationDeliveries).values(
        planned.slice(i, i + 500).map((p) => ({
          invitationId: invitation!.id,
          clubMemberId: p.clubMemberId,
          channel: p.channel,
          status: "queued",
          errorCode: p.errorCode ?? null,
        })),
      );
    }
    if (fresh.length > 0) {
      await tx
        .update(meetingAgendaItems)
        .set({ announcedInInvitationId: invitation!.id })
        .where(and(eq(meetingAgendaItems.meetingId, meeting.id), isNull(meetingAgendaItems.announcedInInvitationId)));
    }
    // The meeting is judged by the rules of its first invitation.
    if (locked.rulesSnapshot === null) await tx.update(meetings).set({ rulesSnapshot: rules, updatedAt: now }).where(eq(meetings.id, meeting.id));
    // Everybody invited can answer (RSVP) and is reminded by the Wave 9 reminder sweep until they do.
    for (let i = 0; i < recipients.length; i += 500) {
      await tx
        .insert(meetingInvitees)
        .values(recipients.slice(i, i + 500).map((r) => ({ meetingId: meeting.id, clubMemberId: r.clubMemberId, response: "ausstehend" })))
        .onConflictDoNothing();
    }
    await writeAudit(tx, {
      eventType: "meeting_invitation.send",
      subjectId: meeting.id,
      payload: { clubId, meetingId: meeting.id, version, kind, recipients: recipients.length, periodException: exceptionReason !== undefined },
    });
    return { invitation: invitation!, content };
  });

  // After commit: hand the messages to the dispatcher. A failure here is recorded on the proof rows, the invitation stays.
  const message = composeInvitationMessage(created.content, settings.mailLanguage, settings.timezone);
  const addressable = recipients.filter((r) => r.userId || r.email);
  try {
    await notify({
      clubId,
      class: "mandatory",
      eventKey: INVITATION_EVENT_KEY,
      refId: created.invitation.id,
      recipients: addressable.map((r) => ({ clubMemberId: r.clubMemberId, userId: r.userId, name: r.firstName?.trim() || r.displayName, email: r.email })),
      content: {
        title: message.title,
        body: message.body,
        template: "announcement",
        ctaLabel: tr(settings.mailLanguage, `${APP_NAME} öffnen`, `Open ${APP_NAME}`),
        ctaUrl: SITE_URL,
        lang: settings.mailLanguage,
      },
      channels: ["in_app", "email", "push"],
      limit: Math.max(addressable.length, 1),
    });
  } catch (err) {
    const e = err as { name?: string; code?: unknown } | undefined;
    logger.error({ meetingId: meeting.id, invitationId: created.invitation.id, errName: e?.name, errCode: e?.code }, "[assembly] could not hand the invitation to the dispatcher");
    await db
      .update(meetingInvitationDeliveries)
      .set({ status: "failed", errorCode: "dispatch_failed", statusAt: new Date() })
      .where(and(eq(meetingInvitationDeliveries.invitationId, created.invitation.id), inArray(meetingInvitationDeliveries.channel, ["email", "inapp"])));
  }
  await syncInvitationDeliveries(created.invitation.id);
  return { invitation: created.invitation, summary: summarize(planned, recipients.length) };
}

const MAIL_STATUS: Record<string, "queued" | "sent" | "failed" | "bounced"> = { queued: "queued", sending: "queued", sent: "sent", failed: "failed", bounced: "bounced" };

/**
 * Brings the proof rows up to date with what the dispatcher did (e-mail queued -> sent / failed / bounced, in-app delivered).
 * Called whenever the proof is read, so it never depends on a scheduler. A mail that failed or bounced puts the member on the
 * post list. Rows that were set by hand (`manual_posted`) are never touched.
 */
export async function syncInvitationDeliveries(invitationId: string): Promise<void> {
  const rows = await db.select().from(meetingInvitationDeliveries).where(eq(meetingInvitationDeliveries.invitationId, invitationId));
  const open = rows.filter((r) => r.channel !== "post" && (r.status === "queued" || r.errorCode?.startsWith("shared_address:")));
  if (open.length === 0) return;
  const sent = await db
    .select({ clubMemberId: messageDeliveries.clubMemberId, channel: messageDeliveries.channel, status: messageDeliveries.status, errorCode: messageDeliveries.errorCode })
    .from(messageDeliveries)
    .where(and(eq(messageDeliveries.eventKey, INVITATION_EVENT_KEY), eq(messageDeliveries.refId, invitationId), inArray(messageDeliveries.channel, ["email", "in_app"])));
  const byKey = new Map(sent.map((d) => [`${d.clubMemberId}:${d.channel === "in_app" ? "inapp" : d.channel}`, d]));
  const statusOf = (clubMemberId: string, channel: string): { status: "queued" | "sent" | "failed" | "bounced"; errorCode: string | null } | null => {
    const d = byKey.get(`${clubMemberId}:${channel}`);
    if (!d) return null;
    if (d.status === "skipped_no_address") return { status: "failed", errorCode: "no_address" };
    return { status: MAIL_STATUS[d.status] ?? "failed", errorCode: d.errorCode };
  };
  const now = new Date();
  const needsPost: string[] = [];
  for (const row of open) {
    if (row.clubMemberId === null) continue;
    const owner = row.errorCode?.startsWith("shared_address:") ? row.errorCode.slice("shared_address:".length) : null;
    const found = statusOf(owner ?? row.clubMemberId, row.channel);
    if (!found) continue;
    const shared = owner ? `shared_address:${owner}` : null;
    const errorCode = found.status === "failed" || found.status === "bounced" ? (found.errorCode ?? "delivery_failed") : shared;
    if (found.status === row.status && errorCode === row.errorCode) continue;
    await db.update(meetingInvitationDeliveries).set({ status: found.status, errorCode, statusAt: now }).where(eq(meetingInvitationDeliveries.id, row.id));
    if (row.channel === "email" && (found.status === "failed" || found.status === "bounced")) needsPost.push(row.clubMemberId);
  }
  // The post list is the fallback for every member the mail did not reach.
  const hasPost = new Set(rows.filter((r) => r.channel === "post").map((r) => r.clubMemberId));
  const fallback = needsPost.filter((id) => !hasPost.has(id));
  if (fallback.length > 0) {
    await db
      .insert(meetingInvitationDeliveries)
      .values(fallback.map((clubMemberId) => ({ invitationId, clubMemberId, channel: "post", status: "queued", errorCode: "email_failed" })))
      .onConflictDoNothing();
  }
}

/** Counts of the proof per channel and status. */
export async function deliverySummary(invitationId: string): Promise<Array<{ channel: string; status: string; count: number }>> {
  return db
    .select({ channel: meetingInvitationDeliveries.channel, status: meetingInvitationDeliveries.status, count: sql<number>`count(*)::int` })
    .from(meetingInvitationDeliveries)
    .where(eq(meetingInvitationDeliveries.invitationId, invitationId))
    .groupBy(meetingInvitationDeliveries.channel, meetingInvitationDeliveries.status)
    .orderBy(asc(meetingInvitationDeliveries.channel), asc(meetingInvitationDeliveries.status));
}

export type { AssemblyRules };
