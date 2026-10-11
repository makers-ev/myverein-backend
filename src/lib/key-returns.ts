import { eq } from "drizzle-orm";

import { member, user } from "../auth/auth-schema.js";
import { locationKeyHistory, locationKeyHolders } from "../db/schema/locations.js";
import type { DbExecutor } from "./club-members.js";

/**
 * Writes a `returned` history entry (note "Konto entfernt") for every key the account still holds. Must run BEFORE the
 * account's `member` row is deleted: the holder rows disappear through ON DELETE CASCADE and would otherwise leave an
 * `issued` entry without a matching return. The holder rows themselves are left to the cascade.
 */
export async function recordKeyReturnsForRemovedAccount(executor: DbExecutor, accountMemberId: string, recordedBy: string | null): Promise<number> {
  const holders = await executor.select().from(locationKeyHolders).where(eq(locationKeyHolders.memberId, accountMemberId));
  if (holders.length === 0) return 0;
  const [account] = await executor.select({ name: user.name }).from(member).innerJoin(user, eq(user.id, member.userId)).where(eq(member.id, accountMemberId));
  await executor.insert(locationKeyHistory).values(
    holders.map((h) => ({
      locationId: h.locationId,
      action: "returned",
      memberId: accountMemberId,
      memberName: account?.name ?? "",
      keyLabel: h.keyLabel,
      note: "Konto entfernt",
      recordedBy,
      recordedByName: null,
    })),
  );
  return holders.length;
}
