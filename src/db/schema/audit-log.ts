import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Shared audit trail for both auth lifecycle events (wired via Better Auth's
 * `databaseHooks`, see src/auth/auth.ts) and domain mutations (e.g. the
 * example accounts resource). Because this lives in the same Postgres as
 * everything else, an audit write can share a transaction with the domain
 * mutation that triggered it -- the old Keycloak backend could not do this
 * since auth events lived in a separate database.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** e.g. "session.create", "user.create", "account.delete" */
    eventType: text("event_type").notNull(),
    /** Identifier of the entity the event is about (user id, account id, ...) */
    subjectId: text("subject_id"),
    /** Club the event belongs to (Wave 10 B1); NULL for platform events (sessions, admin). No FK: the trail outlives the club row. */
    clubId: text("club_id"),
    /** Account that caused the event; NULL for system jobs. No FK: the trail outlives the account. */
    actorUserId: text("actor_user_id"),
    /** `club_members.id` of the person whose data the event is about (member-centric view); NULL if none. */
    subjectMemberId: text("subject_member_id"),
    /** Structured payload, filtered through the per-event whitelist of `writeAudit` (src/lib/audit.ts). */
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("audit_log_club_created_idx").on(table.clubId, table.createdAt),
    index("audit_log_club_member_idx").on(table.clubId, table.subjectMemberId, table.createdAt),
  ],
);

export type AuditLogRow = typeof auditLog.$inferSelect;
export type NewAuditLogRow = typeof auditLog.$inferInsert;
