import "dotenv/config";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";

import * as authSchema from "../auth/auth-schema.js";
import { logger } from "../lib/logger.js";
import * as absencesSchema from "./schema/absences.js";
import * as assemblySchema from "./schema/assembly.js";
import * as auditLogSchema from "./schema/audit-log.js";
import * as availabilitySchema from "./schema/availability.js";
import * as calendarVisibilitySchema from "./schema/calendar-visibility.js";
import * as calendarsSchema from "./schema/calendars.js";
import * as communicationSchema from "./schema/communication.js";
import * as jobsSchema from "./schema/jobs.js";
import * as rateLimitsSchema from "./schema/rate-limits.js";
import * as clubApplicationsSchema from "./schema/club-applications.js";
import * as clubInfoPagesSchema from "./schema/club-info-pages.js";
import * as clubPrivacyNoticesSchema from "./schema/club-privacy-notices.js";
import * as privacySchema from "./schema/privacy.js";
import * as clubRegistrationsSchema from "./schema/club-registrations.js";
import * as clubExitRequestsSchema from "./schema/club-exit-requests.js";
import * as clubMemberInvitesSchema from "./schema/club-member-invites.js";
import * as clubMembersSchema from "./schema/club-members.js";
import * as clubSettingsSchema from "./schema/club-settings.js";
import * as clubMembershipsSchema from "./schema/club-memberships.js";
import * as clubRolesSchema from "./schema/club-roles.js";
import * as departmentsSchema from "./schema/departments.js";
import * as eventAttendeesSchema from "./schema/event-attendees.js";
import * as eventsSchema from "./schema/events.js";
import * as formsSchema from "./schema/forms.js";
import * as guardianLinksSchema from "./schema/guardian-links.js";
import * as inventorySchema from "./schema/inventory.js";
import * as locationLinksSchema from "./schema/location-links.js";
import * as locationWifiSchema from "./schema/location-wifi.js";
import * as locationsSchema from "./schema/locations.js";
import * as mediaFilesSchema from "./schema/media-files.js";
import * as meetingsSchema from "./schema/meetings.js";
import * as notificationsSchema from "./schema/notifications.js";

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is not set. Copy .env.example to .env and configure it.");
}

/**
 * Explicit pool bounds. The old Keycloak backend template shipped an
 * unbounded `pg` pool (documented weakness, see NEW-ARCHITECTURE-README §7)
 * which let a burst of concurrent requests exhaust Postgres connections.
 * `max`/`min`/`idleTimeoutMillis` are set deliberately here and should be
 * tuned per deployment via env vars rather than left implicit.
 */
export const pool = new Pool({
  connectionString: DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX ?? 10),
  min: Number(process.env.DB_POOL_MIN ?? 2),
  idleTimeoutMillis: Number(process.env.DB_POOL_IDLE_TIMEOUT_MS ?? 30_000),
  connectionTimeoutMillis: Number(process.env.DB_POOL_CONNECTION_TIMEOUT_MS ?? 5_000),
});

pool.on("error", (err) => {
  // A backend connection that is idle in the pool errored out. Log and let
  // the pool recycle it; it must never crash the process.
  logger.error({ err }, "[db] unexpected error on idle client");
});

export const schema = {
  ...authSchema,
  ...auditLogSchema,
  ...notificationsSchema,
  ...clubMembershipsSchema,
  ...clubMembersSchema,
  ...clubMemberInvitesSchema,
  ...clubSettingsSchema,
  ...clubExitRequestsSchema,
  ...clubApplicationsSchema,
  ...clubRegistrationsSchema,
  ...departmentsSchema,
  ...clubRolesSchema,
  ...guardianLinksSchema,
  ...clubInfoPagesSchema,
  ...calendarsSchema,
  ...calendarVisibilitySchema,
  ...eventsSchema,
  ...eventAttendeesSchema,
  ...availabilitySchema,
  ...mediaFilesSchema,
  ...meetingsSchema,
  ...locationsSchema,
  ...locationWifiSchema,
  ...locationLinksSchema,
  ...inventorySchema,
  ...formsSchema,
  ...jobsSchema,
  ...rateLimitsSchema,
  ...communicationSchema,
  ...absencesSchema,
  ...assemblySchema,
  ...clubPrivacyNoticesSchema,
  ...privacySchema,
};

export const db = drizzle(pool, { schema });

/** Cheap liveness probe used by GET /ready. Throws if the DB is unreachable. */
export async function pingDatabase(): Promise<void> {
  await pool.query("SELECT 1");
}

/** Graceful shutdown hook for process signal handlers in src/index.ts. */
export async function closeDatabase(): Promise<void> {
  await pool.end();
}
