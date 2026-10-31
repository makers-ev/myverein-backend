import { and, eq } from "drizzle-orm";

import { documents } from "../db/schema/documents.js";
import type { DbExecutor } from "./club-members.js";
import { DOCUMENT_RETENTION_CLASSES, addYears } from "./retention/document-classes.js";

/**
 * Kept apart from the sweep (`document-retention.ts`) on purpose: the lifecycle (`transitionMember`) imports this, and it must
 * not drag the whole notification and retention graph (and with it the auth configuration) into every module that imports the lifecycle.
 */
/** Sets `retention_until` for the exit-based documents of a person once the exit is booked, clears it when the person returns. */
export async function syncExitRetention(tx: DbExecutor, clubMemberId: string, leftAt: string | null): Promise<void> {
  const exitClasses = DOCUMENT_RETENTION_CLASSES.filter((c) => c.startsOn === "exit");
  for (const cls of exitClasses) {
    await tx
      .update(documents)
      .set({ retentionUntil: leftAt ? addYears(leftAt, cls.years) : null })
      .where(and(eq(documents.ownerClubMemberId, clubMemberId), eq(documents.scope, "person"), eq(documents.docType, cls.docType)));
  }
}

