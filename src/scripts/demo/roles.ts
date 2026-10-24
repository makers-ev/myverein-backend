import { db } from "../../db/client.js";
import { clubRoleTerms } from "../../db/schema/assembly.js";
import { writeAudit } from "../../lib/audit.js";
import { accountOf, shiftDays, yearsAgo, type DemoCtx } from "./context.js";
import { giveRole } from "./accounts.js";

interface RoleSpec {
  who: string;
  roleType: string;
  dept?: string;
  /** Days from today to the end of the term (negative = already expired); null = no end. */
  termDays: number | null;
  /** Years since the term started. */
  sinceYears: number;
}

/**
 * Club roles with terms: some far away, two running out soon (Kassenwart in 3 weeks, Abteilungsleitung Tennis in 6 weeks),
 * one already expired (Trainerin Tennis; the statute switches that role's rights off).
 */
const ROLES: RoleSpec[] = [
  { who: "vorsitz", roleType: "vorsitz", termDays: 520, sinceYears: 2 },
  { who: "stellv", roleType: "stellv_vorsitz", termDays: 520, sinceYears: 2 },
  { who: "kasse", roleType: "kassenwart", termDays: 21, sinceYears: 3 },
  { who: "schrift", roleType: "schriftfuehrer", termDays: 520, sinceYears: 2 },
  { who: "beisitz", roleType: "beisitzer", termDays: 120, sinceYears: 2 },
  { who: "beisitz", roleType: "abteilungsleitung", dept: "turnen", termDays: 200, sinceYears: 1 },
  { who: "trainer", roleType: "trainer", dept: "fussball", termDays: null, sinceYears: 4 },
  { who: "trainer2", roleType: "trainer", dept: "tennis", termDays: -12, sinceYears: 2 },
  { who: "abtleit", roleType: "abteilungsleitung", dept: "fussball", termDays: 300, sinceYears: 3 },
  { who: "abtleit2", roleType: "abteilungsleitung", dept: "tennis", termDays: 45, sinceYears: 2 },
];

export async function seedRoles(ctx: DemoCtx): Promise<void> {
  const actor = accountOf(ctx, "vorsitz");
  for (const r of ROLES) {
    const person = accountOf(ctx, r.who);
    const departmentId = r.dept ? ctx.dept[r.dept]! : null;
    await giveRole(person.memberId, r.roleType, departmentId, r.termDays === null ? null : shiftDays(ctx.today, r.termDays));
    await db.insert(clubRoleTerms).values({
      clubId: ctx.clubId,
      clubMemberId: person.clubMemberId,
      roleType: r.roleType,
      departmentId,
      startsOn: yearsAgo(ctx.today, r.sinceYears),
    });
    await writeAudit(db, { eventType: "club_role.assign", subjectId: person.memberId, actorUserId: actor.userId, payload: { clubId: ctx.clubId, clubMemberId: person.clubMemberId, departmentId, roleType: r.roleType } });
  }
  ctx.log(`${ROLES.length} Vereinsrollen mit Amtszeiten`);
}
