import { and, eq } from "drizzle-orm";

import { member } from "../../auth/auth-schema.js";
import { db } from "../../db/client.js";
import { clubMembers, type ClubMemberRow } from "../../db/schema/club-members.js";
import { isUuid, type DbExecutor } from "../club-members.js";
import { NotFoundError } from "../errors.js";
import type { PrivacySubject } from "./registry.js";

/** The subject of an export / erasure inside ONE club; a foreign or unknown id is "not found". */
export async function loadSubject(clubId: string, clubMemberId: string, executor: DbExecutor = db): Promise<{ subject: PrivacySubject; row: ClubMemberRow }> {
  if (!isUuid(clubMemberId)) throw new NotFoundError("Member not found");
  const [row] = await executor.select().from(clubMembers).where(and(eq(clubMembers.id, clubMemberId), eq(clubMembers.clubId, clubId)));
  if (!row) throw new NotFoundError("Member not found");
  const [account] = row.memberId ? await executor.select({ userId: member.userId }).from(member).where(eq(member.id, row.memberId)) : [];
  return { row, subject: { clubId, clubMemberId: row.id, accountMemberId: row.memberId, userId: account?.userId ?? null } };
}
