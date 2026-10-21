import { db } from "../db/client.js";
import { consentPurposes, SYSTEM_CONSENT_PURPOSES } from "../db/schema/privacy.js";
import type { DbExecutor } from "./club-members.js";

/**
 * Idempotently gives a club its five system consent purposes (Wave 10 B1). They start inactive: a purpose only becomes
 * usable once the board has published a text for it. Existing clubs get them from migration 0043; new clubs from here.
 */
export async function ensureConsentPurposes(clubId: string, executor: DbExecutor = db): Promise<void> {
  await executor
    .insert(consentPurposes)
    .values(SYSTEM_CONSENT_PURPOSES.map((p) => ({ clubId, system: true, ...p })))
    .onConflictDoNothing({ target: [consentPurposes.clubId, consentPurposes.key] });
}
