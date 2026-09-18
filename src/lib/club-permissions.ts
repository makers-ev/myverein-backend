/**
 * Fine-grained club roles -> module permissions. Deliberately config code,
 * not a DB rights matrix -- see Architecture Overview - MyVerein §7 and
 * Data Model - MyVerein Backend §5 "Alternatives Considered" for why (the
 * role-to-permission mapping changes rarely and per deployment, not per club
 * at runtime).
 *
 * This sits ON TOP OF Better Auth's own `member.role` (owner/member, default
 * org plugin roles, unmodified) -- `member.role` only gates Better-Auth-
 * native org actions (invite/remove members via the org plugin itself).
 * Everything MyVerein-specific (who can edit member data, assign roles,
 * manage departments/club info) is decided here, from `club_roles.roleType`,
 * independent of the org-level role. See club-guard.ts for how the two
 * combine.
 */

export const CLUB_ROLE_TYPES = [
  "vorsitz",
  "stellv_vorsitz",
  "kassenwart",
  "schriftfuehrer",
  "beisitzer",
  "abteilungsleitung",
  "trainer",
  "erziehungsberechtigt",
] as const;

export type ClubRoleType = (typeof CLUB_ROLE_TYPES)[number];

export type ClubPermission =
  | "members:write" // edit other members' data, change category/status
  | "members:read_sensitive" // read fields beyond name/department (birth date, emergency contact, membership status) for OTHER members
  | "roles:write" // assign/revoke club_roles
  | "departments:write"
  | "club_info:write";

/**
 * Which permissions each role_type grants. A membership can hold several
 * roles at once (see club-roles.ts) -- `hasClubPermission` checks across all
 * of them, not just one.
 *
 * Beitragsstatus-Sichtbarkeit (open question in the Implementation Plan):
 * resolved here as "vorsitz/stellv_vorsitz/kassenwart", since those are the
 * roles with an actual operational need to see it -- schriftfuehrer/
 * beisitzer/abteilungsleitung/trainer do not get `members:read_sensitive`.
 */
const ROLE_PERMISSIONS: Record<ClubRoleType, ClubPermission[]> = {
  vorsitz: ["members:write", "members:read_sensitive", "roles:write", "departments:write", "club_info:write"],
  stellv_vorsitz: ["members:write", "members:read_sensitive", "roles:write", "departments:write", "club_info:write"],
  kassenwart: ["members:read_sensitive"],
  schriftfuehrer: ["members:write", "club_info:write"],
  beisitzer: [],
  abteilungsleitung: ["departments:write"],
  trainer: [],
  erziehungsberechtigt: [],
};

/** True if any of the caller's club_roles grants `permission`. */
export function hasClubPermission(roleTypes: readonly string[], permission: ClubPermission): boolean {
  return roleTypes.some((roleType) => (ROLE_PERMISSIONS[roleType as ClubRoleType] ?? []).includes(permission));
}

/** Roles considered "board" for quick checks (e.g. Vereinsinfo board listing). */
export const BOARD_ROLE_TYPES: ClubRoleType[] = ["vorsitz", "stellv_vorsitz", "kassenwart", "schriftfuehrer", "beisitzer"];
