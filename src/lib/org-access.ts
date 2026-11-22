import { and, eq } from "drizzle-orm";

import { member, organization } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { resolveClubRoleTypes } from "./club-access.js";
import { hasClubPermission } from "./club-permissions.js";

/**
 * Gate for Better Auth's organization plugin over HTTP (Wave 15 review, blocker 1). The plugin's own read endpoints
 * (`list-members`, `get-full-organization`, `list-invitations`, ...) return every member with name and e-mail to ANY member of
 * the organization -- including external guests (guardians, sponsors, service providers) -- and bypass `clubGuard` completely.
 * MyVerein clients never call them (members come from `/club-members` with its read scoping), so they are deny-by-default:
 * only the board (`members:write` in that club) may use them. The self-service paths below stay open for every signed-in user.
 * Server-side `auth.api.*` calls (no HTTP request) are not affected.
 */
export const ORG_SELF_SERVICE_PATHS: ReadonlySet<string> = new Set([
  "/organization/list",
  "/organization/set-active",
  "/organization/leave",
  "/organization/accept-invitation",
  "/organization/reject-invitation",
  "/organization/get-invitation",
  "/organization/list-user-invitations",
  "/organization/create",
]);

export function isGatedOrgPath(path: string): boolean {
  return path.startsWith("/organization/") && !ORG_SELF_SERVICE_PATHS.has(path);
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 && v.length <= 200 ? v : null);

/** The organization a request targets: explicit id or slug (query/body), else the session's active organization. */
export async function targetOrganizationId(query: Record<string, unknown> | undefined, body: Record<string, unknown> | undefined, activeOrganizationId: string | null | undefined): Promise<string | null> {
  const id = str(query?.organizationId) ?? str(body?.organizationId);
  if (id) return id;
  const slug = str(query?.organizationSlug) ?? str(body?.organizationSlug);
  if (slug) {
    const [row] = await db.select({ id: organization.id }).from(organization).where(eq(organization.slug, slug)).limit(1);
    return row?.id ?? null;
  }
  return activeOrganizationId ?? null;
}

/** True if `userId` holds `members:write` in the club (effective roles, like clubGuard). */
export async function mayUseOrgEndpoints(userId: string, clubId: string | null): Promise<boolean> {
  if (!clubId) return false;
  const membership = await db.query.member.findFirst({ where: and(eq(member.organizationId, clubId), eq(member.userId, userId)) });
  if (!membership || membership.role === "guest") return false;
  const roles = await resolveClubRoleTypes(membership, clubId);
  return roles !== null && hasClubPermission(roles, "members:write");
}
