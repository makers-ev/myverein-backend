import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { z } from "zod";

import { member } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { clubMembers } from "../db/schema/club-members.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { clubAnnouncements, COMMUNICATION_CHANNELS, type AnnouncementAudience, type ClubAnnouncementRow } from "../db/schema/communication.js";
import { departments } from "../db/schema/departments.js";
import { assertWithinSendLimits } from "./announcement-limits.js";
import { AudienceLimitError } from "./audience.js";
import { CLUB_ROLE_TYPES, hasClubPermission } from "./club-permissions.js";
import { ForbiddenError, TooManyRequestsError, ValidationError } from "./errors.js";
import { enqueue } from "./jobs/queue.js";
import type { JobContext } from "./jobs/registry.js";
import { logger } from "./logger.js";
import { notify } from "./notify/dispatcher.js";
import { cleanText } from "./text-policy.js";
import { writeAudit } from "./audit.js";

/**
 * Announcement domain logic (Wave 9 B7, ADR-006): who may address whom, the single send path (immediate and scheduled)
 * and the `announcement.publish` job. The routes (`src/routes/club-announcements.ts`) only authorize and shape.
 */

export const PUBLISH_JOB_TYPE = "announcement.publish";
/** A `sending` announcement older than this is treated as crashed mid-send and may be sent again (the send is idempotent). */
const SENDING_STALE_MS = 5 * 60_000;

// --- Audience scope -------------------------------------------------------------------------------

export const audienceSchema = z
  .object({
    all: z.boolean().optional(),
    departmentIds: z.array(z.string().uuid()).max(100).optional(),
    roleTypes: z.array(z.enum(CLUB_ROLE_TYPES)).max(20).optional(),
    categoryKeys: z.array(z.string().min(1).max(60)).max(50).optional(),
    memberIds: z.array(z.string().uuid()).max(500).optional(),
    includeGuardians: z.boolean().optional(),
  })
  .strict()
  .refine((a) => a.all === true || (a.departmentIds?.length ?? 0) + (a.roleTypes?.length ?? 0) + (a.categoryKeys?.length ?? 0) + (a.memberIds?.length ?? 0) > 0, {
    message: "The audience must be the whole club or name at least one department, role, category or member",
  });

export const titleSchema = cleanText(z.string().trim().min(1).max(200));
export const bodySchema = cleanText(z.string().trim().min(1).max(10_000), true);
export const channelsSchema = z
  .array(z.enum(COMMUNICATION_CHANNELS))
  .max(3)
  .transform((channels) => [...new Set(["in_app" as const, ...channels])]);

/** What the caller may do, derived from role types and (for the department variant) `club_roles.department_id`. */
export interface AuthorScope {
  /** `announcements:write`: club-wide, urgent, any audience. */
  write: boolean;
  /** `announcements:write_department`: only the departments in `departmentIds`. */
  writeDepartment: boolean;
  departmentIds: string[];
}

export async function loadAuthorScope(clubId: string, accountMemberId: string, roleTypes: readonly string[]): Promise<AuthorScope> {
  const write = hasClubPermission(roleTypes, "announcements:write");
  const writeDepartment = hasClubPermission(roleTypes, "announcements:write_department");
  let departmentIds: string[] = [];
  if (writeDepartment) {
    const rows = await db
      .select({ id: clubRoles.departmentId })
      .from(clubRoles)
      .innerJoin(departments, and(eq(departments.id, clubRoles.departmentId), eq(departments.clubId, clubId)))
      .where(and(eq(clubRoles.memberId, accountMemberId), inArray(clubRoles.roleType, ["abteilungsleitung", "trainer"]), isNotNull(clubRoles.departmentId)));
    departmentIds = [...new Set(rows.map((r) => r.id!))];
  }
  return { write, writeDepartment, departmentIds };
}

export const canAuthor = (scope: AuthorScope): boolean => scope.write || scope.writeDepartment;

/** Throws 403 if `scope` may not send this audience / urgency. `announcements:write` may everything. */
export function assertMayAddress(scope: AuthorScope, audience: AnnouncementAudience, urgent: boolean): void {
  if (scope.write) return;
  if (!scope.writeDepartment) throw new ForbiddenError("Missing announcements:write permission");
  if (urgent) throw new ForbiddenError("The urgent flag needs the announcements:write permission");
  const wide = audience.all === true || (audience.roleTypes?.length ?? 0) > 0 || (audience.categoryKeys?.length ?? 0) > 0 || (audience.memberIds?.length ?? 0) > 0;
  const requested = audience.departmentIds ?? [];
  if (wide || requested.length === 0) throw new ForbiddenError("You may only address your own departments");
  if (requested.some((id) => !scope.departmentIds.includes(id))) throw new ForbiddenError("You may only address your own departments");
}

export function assertPublishAt(value: Date | null | undefined): void {
  if (value && value.getTime() < Date.now() - 60_000) throw new ValidationError("publishAt must not be in the past");
}

// --- Sending --------------------------------------------------------------------------------------

export interface SendOutcome {
  recipients: number;
  inApp: number;
  queuedEmail: number;
  queuedPush: number;
  skippedOptout: number;
  skippedNoAddress: number;
  alreadyDelivered: number;
}

/** Marks a scheduled announcement and enqueues the publish job (idempotent per announcement + time). */
export async function schedulePublish(row: Pick<ClubAnnouncementRow, "id" | "publishAt">): Promise<void> {
  const runAt = row.publishAt!;
  await enqueue({ type: PUBLISH_JOB_TYPE, payload: { announcementId: row.id, publishAt: runAt.toISOString() }, runAt, dedupeKey: `${PUBLISH_JOB_TYPE}:${row.id}:${runAt.getTime()}` });
}

export type SendResult = { sent: true; outcome: SendOutcome; row: ClubAnnouncementRow } | { sent: false; reason: "not_sendable" | "audience_too_large" | "forbidden" };

/**
 * The one send path. Claims the announcement (draft/scheduled -> sending, `FOR UPDATE`), fans out through `notify`
 * (one delivery per recipient and channel, idempotent) and marks it sent. A failure puts it back to its previous status.
 * `actor` is the user who triggered the send (NULL for the scheduler); `author` re-checks the author's scope for a job run.
 */
export async function sendAnnouncement(clubId: string, id: string, options: { actorUserId: string | null; authorScope?: AuthorScope | null; expectedPublishAt?: string | null; confirmRecipients?: number | null }): Promise<SendResult> {
  const claimed = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(clubAnnouncements).where(and(eq(clubAnnouncements.id, id), eq(clubAnnouncements.clubId, clubId))).for("update");
    if (!row) return null;
    const stale = row.status === "sending" && Date.now() - row.updatedAt.getTime() > SENDING_STALE_MS;
    if (row.status !== "draft" && row.status !== "scheduled" && !stale) return null;
    if (options.expectedPublishAt !== undefined && (row.status !== "scheduled" || row.publishAt?.toISOString() !== options.expectedPublishAt)) return null;
    if (options.authorScope) {
      try {
        assertMayAddress(options.authorScope, row.audience, row.urgent);
      } catch {
        await tx.update(clubAnnouncements).set({ status: "cancelled", updatedAt: new Date() }).where(eq(clubAnnouncements.id, id));
        await writeAudit(tx, { eventType: "club_announcement.send_denied", subjectId: id, payload: { clubId, reason: "author_scope_lost" } });
        return "forbidden" as const;
      }
    }
    const [updated] = await tx.update(clubAnnouncements).set({ status: "sending", updatedAt: new Date() }).where(eq(clubAnnouncements.id, id)).returning();
    return { row: updated!, previous: row.status === "scheduled" ? "scheduled" : "draft" };
  });
  if (claimed === null) return { sent: false, reason: "not_sendable" };
  if (claimed === "forbidden") return { sent: false, reason: "forbidden" };

  const { row, previous } = claimed;
  try {
    // Anti-spam limits (B14). A violation puts the announcement back to its previous status (see the catch below).
    await assertWithinSendLimits(row, { actorUserId: options.actorUserId, confirmRecipients: options.confirmRecipients ?? null, mode: options.actorUserId === null ? "publish" : "send" });
    const outcome = await notify({
      clubId,
      class: "optional",
      eventKey: "announcement",
      refId: row.id,
      announcementId: row.id,
      audience: row.audience,
      content: { title: row.title, body: row.body, urgent: row.urgent, category: "announcements" },
      channels: row.channels,
    });
    const sentAt = new Date();
    const sent = await db.transaction(async (tx) => {
      const [done] = await tx.update(clubAnnouncements).set({ status: "sent", sentAt, updatedAt: sentAt }).where(eq(clubAnnouncements.id, row.id)).returning();
      // Ids and counts only: neither the text nor any address belongs into the audit trail.
      await writeAudit(tx, { eventType: "club_announcement.send", subjectId: row.id, payload: { clubId, actor: options.actorUserId, scheduled: options.actorUserId === null, urgent: row.urgent, channels: row.channels, ...outcome } });
      return done!;
    });
    return { sent: true, outcome, row: sent };
  } catch (err) {
    await db.update(clubAnnouncements).set({ status: previous, updatedAt: new Date() }).where(and(eq(clubAnnouncements.id, row.id), eq(clubAnnouncements.status, "sending")));
    if (err instanceof AudienceLimitError) return { sent: false, reason: "audience_too_large" };
    throw err;
  }
}

/** Resolves the scope of an announcement's author for a scheduled run (their roles may have changed since scheduling). */
async function authorScopeOf(clubId: string, authorMemberId: string | null): Promise<AuthorScope | null> {
  if (!authorMemberId) return null;
  const [author] = await db.select({ accountId: clubMembers.memberId }).from(clubMembers).where(and(eq(clubMembers.id, authorMemberId), eq(clubMembers.clubId, clubId)));
  if (!author?.accountId) return null;
  const [account] = await db.select({ id: member.id }).from(member).where(and(eq(member.id, author.accountId), eq(member.organizationId, clubId)));
  if (!account) return null;
  const roles = await db.select({ roleType: clubRoles.roleType }).from(clubRoles).where(eq(clubRoles.memberId, account.id));
  return loadAuthorScope(clubId, account.id, roles.map((r) => r.roleType));
}

/** Job `announcement.publish`: sends a scheduled announcement at its time. Stale (rescheduled/cancelled/edited) jobs are no-ops. */
export async function handlePublishAnnouncement(job: JobContext): Promise<void> {
  const id = typeof job.payload.announcementId === "string" ? job.payload.announcementId : null;
  const publishAt = typeof job.payload.publishAt === "string" ? job.payload.publishAt : null;
  if (!id || !publishAt) return;
  const [row] = await db.select().from(clubAnnouncements).where(eq(clubAnnouncements.id, id));
  if (!row || row.status !== "scheduled" || row.publishAt?.toISOString() !== publishAt) return;
  const scope = (await authorScopeOf(row.clubId, row.authorMemberId)) ?? { write: false, writeDepartment: false, departmentIds: [] };
  let result: SendResult;
  try {
    result = await sendAnnouncement(row.clubId, id, { actorUserId: null, authorScope: scope, expectedPublishAt: publishAt });
  } catch (err) {
    // Anti-spam limit hit at the scheduled time: retrying would not help, the author finds it as a draft again (audit entry written).
    if (err instanceof TooManyRequestsError) {
      await db.update(clubAnnouncements).set({ status: "draft", updatedAt: new Date() }).where(and(eq(clubAnnouncements.id, id), eq(clubAnnouncements.status, "scheduled")));
      logger.warn({ announcementId: id }, "[announcements] scheduled send refused: rate limit");
      return;
    }
    throw err;
  }
  if (!result.sent && result.reason === "audience_too_large") {
    await db.update(clubAnnouncements).set({ status: "draft", updatedAt: new Date() }).where(and(eq(clubAnnouncements.id, id), eq(clubAnnouncements.status, "scheduled")));
    logger.warn({ announcementId: id }, "[announcements] scheduled send refused: audience too large");
  }
}
