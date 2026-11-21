import { and, eq, inArray, or, sql } from "drizzle-orm";

import { member as accountMember, user } from "../auth/auth-schema.js";

import { db } from "../db/client.js";
import { clubLeads, type ClubLeadRow, type LeadStatus } from "../db/schema/club-leads.js";
import { clubMemberDepartments, clubMembers, clubMemberStatusHistory } from "../db/schema/club-members.js";
import { departments } from "../db/schema/departments.js";
import { writeAudit } from "./audit.js";
import { roleTypesWithPermission } from "./club-permissions.js";
import { clubMailLanguage, loadClubSettings } from "./club-settings.js";
import { DEFAULT_CATEGORY_KEY, ensureDefaultCategories, findCategoryByKey } from "./club-members.js";
import { SITE_URL } from "./emailTemplate.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { logger } from "./logger.js";
import { todayBerlin } from "./member-lifecycle.js";
import { notifySafely } from "./notify/dispatcher.js";
import { tr } from "./notify/i18n.js";

/**
 * Interested people and trial training (Wave 15 B4). Status flow (`mitglied` only through the conversion):
 *   neu -> kontaktiert | probetraining | abgelehnt;  kontaktiert -> probetraining | abgelehnt | neu;
 *   probetraining -> kontaktiert | abgelehnt;  abgelehnt -> neu (reopen);  mitglied -> (final).
 */
export const LEAD_TRANSITIONS: Record<LeadStatus, readonly LeadStatus[]> = {
  neu: ["kontaktiert", "probetraining", "abgelehnt"],
  kontaktiert: ["probetraining", "abgelehnt", "neu"],
  probetraining: ["kontaktiert", "abgelehnt"],
  abgelehnt: ["neu"],
  mitglied: [],
};

export const OPEN_LEAD_STATUSES: readonly LeadStatus[] = ["neu", "kontaktiert", "probetraining"];
export const MAX_LEAD_MESSAGE = 4000;

export function assertTransition(from: LeadStatus, to: LeadStatus): void {
  if (from === to) return;
  if (to === "mitglied") throw new ValidationError("Use the conversion to make a lead a member", { details: { code: "use_convert" } });
  if (!LEAD_TRANSITIONS[from].includes(to)) throw new ConflictError(`A lead cannot go from ${from} to ${to}`, { details: { code: "invalid_status_transition", from, to } });
}

export async function shapeLeads(rows: ClubLeadRow[]) {
  const ids = [...new Set(rows.map((r) => r.departmentId).filter((v): v is string => !!v))];
  const names = new Map((ids.length ? await db.select({ id: departments.id, name: departments.name }).from(departments).where(inArray(departments.id, ids)) : []).map((d) => [d.id, d.name]));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    phone: r.phone,
    department: r.departmentId && names.has(r.departmentId) ? { id: r.departmentId, name: names.get(r.departmentId)! } : null,
    message: r.message,
    source: r.source,
    status: r.status,
    trialRequested: r.trialRequested,
    trialOn: r.trialOn,
    waitlisted: r.waitlistedAt !== null,
    waitlistedAt: r.waitlistedAt,
    notes: r.notes,
    requestCount: r.requestCount,
    lastRequestAt: r.lastRequestAt,
    convertedClubMemberId: r.convertedClubMemberId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

export interface PublicLeadInput {
  clubId: string;
  name: string;
  email: string;
  phone: string | null;
  departmentId: string | null;
  message: string | null;
  trialRequested: boolean;
}

/**
 * Stores an enquiry from the public page. An OPEN lead with the same address in the club is merged (request count + 1, message
 * appended, capped) instead of duplicated; only a new lead notifies the board. Returns whether a new lead was created.
 */
export async function recordPublicLead(input: PublicLeadInput): Promise<{ leadId: string; created: boolean }> {
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`club-lead:${input.clubId}:${input.email}`}, 0))`);
    const [open] = await tx
      .select()
      .from(clubLeads)
      .where(and(eq(clubLeads.clubId, input.clubId), eq(clubLeads.email, input.email), inArray(clubLeads.status, [...OPEN_LEAD_STATUSES])))
      .limit(1);
    const now = new Date();
    if (open) {
      const message = [open.message, input.message].filter((m): m is string => !!m).join("\n\n---\n\n").slice(0, MAX_LEAD_MESSAGE) || null;
      await tx
        .update(clubLeads)
        .set({ requestCount: open.requestCount + 1, lastRequestAt: now, message, trialRequested: open.trialRequested || input.trialRequested, departmentId: open.departmentId ?? input.departmentId, phone: open.phone ?? input.phone, updatedAt: now })
        .where(eq(clubLeads.id, open.id));
      await writeAudit(tx, { eventType: "club_lead.request", subjectId: open.id, clubId: input.clubId, actorUserId: null, payload: { clubId: input.clubId, leadId: open.id, merged: true } });
      return { leadId: open.id, created: false };
    }
    const [row] = await tx
      .insert(clubLeads)
      .values({ clubId: input.clubId, name: input.name, email: input.email, phone: input.phone, departmentId: input.departmentId, message: input.message, source: "oeffentliche_seite", trialRequested: input.trialRequested, privacyAcceptedAt: now, lastRequestAt: now })
      .returning();
    await writeAudit(tx, { eventType: "club_lead.request", subjectId: row!.id, clubId: input.clubId, actorUserId: null, payload: { clubId: input.clubId, leadId: row!.id, merged: false } });
    return { leadId: row!.id, created: true };
  });
  if (result.created) await notifyLeadToBoard(input.clubId, result.leadId, input.name, input.trialRequested);
  return result;
}

/** Board notice about a new enquiry (Wave 9 dispatcher): everybody with `leads:write`, optional, switch `notify_board_requests`. */
export async function notifyLeadToBoard(clubId: string, leadId: string, name: string, trial: boolean): Promise<void> {
  try {
    if (!(await loadClubSettings(db, clubId)).notifyBoardRequests) return;
    const lang = await clubMailLanguage(db, clubId);
    await notifySafely({
      clubId,
      class: "optional",
      eventKey: "lead.new",
      refId: leadId,
      audience: { roleTypes: roleTypesWithPermission("leads:write"), includeGuardians: false },
      content: {
        title: tr(lang, trial ? `Neue Anfrage zum Probetraining: ${name}` : `Neue Anfrage: ${name}`, trial ? `New trial training request: ${name}` : `New enquiry: ${name}`),
        body: tr(lang, `${name} hat über die öffentliche Vereinsseite angefragt. Bitte melde dich unter Verein, Interessenten.`, `${name} sent an enquiry through the public club page. Please follow up under Club, Interested people.`),
        category: "reminders",
        ctaLabel: tr(lang, "Zum Verein", "Go to the club"),
        ctaUrl: SITE_URL,
        lang,
      },
      channels: ["in_app", "email"],
    });
  } catch (err) {
    logger.error({ clubId, leadId, errName: (err as Error)?.name }, "[club-leads] board notice failed");
  }
}

/**
 * Turns a lead into a member record without account (status `interessent`, no member number, default category, department
 * assigned) and closes the lead as `mitglied`. The account invitation / admission then runs through the existing member routes.
 */
export async function convertLead(clubId: string, leadId: string, actorMemberId: string, options: { confirmDuplicate?: boolean } = {}): Promise<{ lead: ClubLeadRow; clubMemberId: string }> {
  await ensureDefaultCategories(clubId);
  return db.transaction(async (tx) => {
    const [lead] = await tx.select().from(clubLeads).where(and(eq(clubLeads.id, leadId), eq(clubLeads.clubId, clubId))).for("update");
    if (!lead) throw new NotFoundError("Lead not found");
    if (lead.convertedClubMemberId || lead.status === "mitglied") throw new ConflictError("The lead was already converted", { details: { code: "lead_already_converted" } });
    // Duplicate guard: a member record of the club with the same e-mail (contact or account address) is probably this person.
    if (lead.email && !options.confirmDuplicate) {
      const [dup] = await tx
        .select({ id: clubMembers.id })
        .from(clubMembers)
        .leftJoin(accountMember, eq(accountMember.id, clubMembers.memberId))
        .leftJoin(user, eq(user.id, accountMember.userId))
        .where(and(eq(clubMembers.clubId, clubId), or(sql`lower(${clubMembers.contactEmail}) = ${lead.email}`, sql`lower(${user.email}) = ${lead.email}`)))
        .limit(1);
      if (dup) throw new ConflictError("A member record with this e-mail address exists already; confirm to create another one", { details: { code: "possible_duplicate", clubMemberId: dup.id } });
    }
    const category = await findCategoryByKey(tx, clubId, DEFAULT_CATEGORY_KEY);
    const [member] = await tx
      .insert(clubMembers)
      .values({ clubId, displayName: lead.name, contactEmail: lead.email, phone: lead.phone, memberNumber: null, categoryId: category?.id ?? null, status: "interessent", joinedAt: todayBerlin() })
      .returning();
    await tx.insert(clubMemberStatusHistory).values({ clubMemberId: member!.id, fromStatus: null, toStatus: "interessent", toCategoryId: category?.id ?? null, effectiveOn: todayBerlin(), reason: "Aus Interessenten-Anfrage übernommen", changedBy: actorMemberId });
    if (lead.departmentId) await tx.insert(clubMemberDepartments).values({ clubMemberId: member!.id, departmentId: lead.departmentId }).onConflictDoNothing();
    const [updated] = await tx.update(clubLeads).set({ status: "mitglied", convertedClubMemberId: member!.id, waitlistedAt: null, updatedAt: new Date() }).where(eq(clubLeads.id, lead.id)).returning();
    await writeAudit(tx, { eventType: "club_member.create", subjectId: member!.id, payload: { clubId, categoryId: category?.id ?? undefined, status: "interessent", createdBy: actorMemberId } });
    await writeAudit(tx, { eventType: "club_lead.convert", subjectId: lead.id, payload: { clubId, leadId: lead.id, clubMemberId: member!.id } });
    return { lead: updated!, clubMemberId: member!.id };
  });
}
