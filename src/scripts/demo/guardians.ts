import { db } from "../../db/client.js";
import { clubRoles } from "../../db/schema/club-roles.js";
import { guardianLinks } from "../../db/schema/guardian-links.js";
import { writeAudit } from "../../lib/audit.js";
import { accountOf, clubMemberOf, shiftDays, type DemoCtx } from "./context.js";

interface LinkSpec {
  guardian: string;
  ward: string;
  relationship: string;
  hasCustody?: boolean;
  canConsent?: boolean;
  canReportAbsence?: boolean;
  /** Days from today; negative = in the past. */
  validFromDays?: number;
  validUntilDays?: number | null;
  confirmed?: boolean;
}

/**
 * Guardian links in every state the clients have to handle: valid and confirmed, a second guardian without custody (cannot consent),
 * not yet confirmed by the board (grants nothing) and expired (the ward turned 18). Minors Leon, Hannah, Sophie and Jonas have
 * deliberately NO guardian: the board sees them in the "minor without guardian" list.
 */
export async function seedGuardians(ctx: DemoCtx): Promise<void> {
  const board = accountOf(ctx, "vorsitz");
  const links: LinkSpec[] = [
    { guardian: "eltern", ward: "noah", relationship: "Mutter", validFromDays: -1100 },
    { guardian: "eltern", ward: "mia", relationship: "Mutter", validFromDays: -700 },
    { guardian: "eltern", ward: "lina", relationship: "Mutter", validFromDays: -20, confirmed: false },
    { guardian: "eltern", ward: "tim", relationship: "Mutter", validFromDays: -3200, validUntilDays: -25 },
    { guardian: "mitglied", ward: "finn", relationship: "Vater", validFromDays: -600 },
    { guardian: "mitglied", ward: "noah", relationship: "Onkel", hasCustody: false, canConsent: false, canReportAbsence: true, validFromDays: -300 },
  ];
  for (const l of links) {
    const guardian = accountOf(ctx, l.guardian);
    const ward = clubMemberOf(ctx, l.ward);
    const confirmed = l.confirmed !== false;
    await db.insert(guardianLinks).values({
      guardianMemberId: guardian.memberId,
      wardClubMemberId: ward,
      relationship: l.relationship,
      hasCustody: l.hasCustody ?? true,
      canConsent: l.canConsent ?? true,
      canReportAbsence: l.canReportAbsence ?? true,
      validFrom: shiftDays(ctx.today, l.validFromDays ?? 0),
      validUntil: l.validUntilDays === undefined || l.validUntilDays === null ? null : shiftDays(ctx.today, l.validUntilDays),
      confirmedAt: confirmed ? new Date(ctx.now.getTime() - 30 * 86_400_000) : null,
      confirmedBy: confirmed ? board.memberId : null,
    });
    await writeAudit(db, { eventType: "guardian_link.create", subjectId: ward, actorUserId: board.userId, payload: { clubId: ctx.clubId, guardianMemberId: guardian.memberId, decidedBy: board.memberId, via: "board" } });
  }
  // The external guardian account carries the club role that identifies it (never an implicit "mitglied").
  await db.insert(clubRoles).values({ memberId: accountOf(ctx, "eltern").memberId, roleType: "erziehungsberechtigt" }).onConflictDoNothing();
  ctx.log(`${links.length} Erziehungsberechtigten-Verknüpfungen (gültig, ohne Sorgerecht, unbestätigt, abgelaufen)`);
}
