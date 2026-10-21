import type { DbExecutor } from "../club-members.js";

/**
 * Privacy contributor registry (Wave 10 B7/B8). Every table with a personal reference to a club member (a foreign key to
 * `club_members`, or to the account membership `member` for data ABOUT the person) belongs to exactly one contributor, or is
 * exempted below with a reason. `registry.test.ts` fails when a table is neither: a later wave that adds such a table has to
 * decide how it is exported (Art. 15) and erased (Art. 17) before the build is green again.
 *
 * `exportSubject` returns the data about the person in a form they can read; `eraseSubject` deletes, anonymises or keeps it
 * (and says why) inside the transaction of the erasure process. Files are never deleted in a contributor: it returns the
 * storage keys in `purge` and the caller removes them after the commit.
 */

export interface PrivacySubject {
  clubId: string;
  /** The `club_members` row to export / erase. */
  clubMemberId: string;
  /** The account membership (`member.id`) while the person still has an account in this club, else null. */
  accountMemberId: string | null;
  userId: string | null;
}

export interface EraseOutcome {
  deleted: number;
  anonymized: number;
  kept: number;
  /** Why data stays (shown in the dry run). Required when `kept > 0`. */
  keptReason?: string;
  /** Storage keys of files to remove after the commit (registry rows are already tombstoned). */
  purge?: string[];
}

export interface PrivacyContributor {
  key: string;
  /** Database table names this contributor covers (export and erasure). */
  tables: readonly string[];
  exportSubject(executor: DbExecutor, subject: PrivacySubject): Promise<Record<string, unknown>>;
  eraseSubject(tx: DbExecutor, subject: PrivacySubject): Promise<EraseOutcome>;
}

/**
 * Tables that reference a member but are deliberately not contributors. Keep this list short; every entry needs a reason.
 */
export const EXEMPT_TABLES: Readonly<Record<string, string>> = {
  data_subject_requests: "Proof that the request was handled (Art. 12); holds no content, the member reference becomes NULL when the row is gone",
};

const contributors = new Map<string, PrivacyContributor>();

export function registerContributor(contributor: PrivacyContributor): void {
  if (contributors.has(contributor.key)) throw new Error(`privacy contributor already registered: ${contributor.key}`);
  contributors.set(contributor.key, contributor);
}

/** In registration order, which is also the erasure order (form data first: its lock order must precede the member row). */
export function privacyContributors(): PrivacyContributor[] {
  return [...contributors.values()];
}

/** Table name -> contributor key, for the completeness test and the dry run. */
export function coveredTables(): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of contributors.values()) for (const t of c.tables) out.set(t, c.key);
  return out;
}
