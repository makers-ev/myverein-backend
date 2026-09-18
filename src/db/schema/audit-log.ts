import { pgTable, text, timestamp, uuid, jsonb } from "drizzle-orm/pg-core";

/**
 * Shared audit trail for both auth lifecycle events (wired via Better Auth's
 * `databaseHooks`, see src/auth/auth.ts) and domain mutations (e.g. the
 * example accounts resource). Because this lives in the same Postgres as
 * everything else, an audit write can share a transaction with the domain
 * mutation that triggered it -- the old Keycloak backend could not do this
 * since auth events lived in a separate database.
 */
export const auditLog = pgTable("audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** e.g. "session.create", "user.create", "account.delete" */
  eventType: text("event_type").notNull(),
  /** Identifier of the entity the event is about (user id, account id, ...) */
  subjectId: text("subject_id"),
  /** Free-form structured payload for the event. */
  payload: jsonb("payload").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AuditLogRow = typeof auditLog.$inferSelect;
export type NewAuditLogRow = typeof auditLog.$inferInsert;
