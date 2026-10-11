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
  // Implicit base role of every account member (see clubGuard). Never stored in
  // club_roles, cannot be assigned or revoked -- see ASSIGNABLE_ROLE_TYPES.
  "mitglied",
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

/** The implicit base role every (non-guest) account member holds; has no write permissions. */
export const IMPLICIT_ROLE_TYPE = "mitglied" as const;

/** Role types the roles API may assign/revoke -- everything except the implicit `mitglied`. */
export const ASSIGNABLE_ROLE_TYPES = CLUB_ROLE_TYPES.filter((r) => r !== IMPLICIT_ROLE_TYPE) as [
  Exclude<ClubRoleType, "mitglied">,
  ...Exclude<ClubRoleType, "mitglied">[],
];

export type ClubPermission =
  | "members:write" // edit other members' data, change category/status
  | "members:read_sensitive" // read fields beyond name/department (birth date, emergency contact, membership status) for OTHER members
  | "roles:write" // assign/revoke club_roles
  | "departments:write"
  | "club_info:write"
  | "calendars:write" // manage calendars/events + calendar_visibility grants
  | "meetings:write" // manage meetings/agenda/invitees/attendance/resolutions
  | "locations:write" // manage locations/key holders/wifi networks/links
  | "meetings:read_board" // read Vorstandssitzungen (incl. minutes, resolutions, attendance) without being invited
  | "locations:read_access" // read key holders, access notes and 'vorstand'-level wifi/links
  | "inventory:write"; // manage inventory items/loans/damage reports

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
  // Deny-by-default: the base role grants NO write permission at all (explicitly empty).
  // Reads that are not club-wide open are scoped in the routes (meetings, locations).
  mitglied: [],
  vorsitz: [
    "members:write",
    "members:read_sensitive",
    "roles:write",
    "departments:write",
    "club_info:write",
    "calendars:write",
    "meetings:write",
    "locations:write",
    "inventory:write",
    "meetings:read_board",
    "locations:read_access",
  ],
  stellv_vorsitz: [
    "members:write",
    "members:read_sensitive",
    "roles:write",
    "departments:write",
    "club_info:write",
    "calendars:write",
    "meetings:write",
    "locations:write",
    "inventory:write",
    "meetings:read_board",
    "locations:read_access",
  ],
  kassenwart: ["members:read_sensitive"],
  // A schriftfuehrer's real-world job in a German Verein is literally running
  // meeting agendas/Protokolle, so meetings:write is a natural fit here.
  schriftfuehrer: ["members:write", "club_info:write", "calendars:write", "meetings:write", "locations:write", "inventory:write", "meetings:read_board", "locations:read_access"],
  // Beisitzer sit on the board, so they may read Vorstandssitzungen (but write nothing).
  beisitzer: ["meetings:read_board"],
  // Also calendars:write/locations:write/inventory:write, on top of
  // departments:write -- an Abteilungsleitung needs to manage calendars,
  // venues, and equipment day to day, not just the board (same
  // operational-need reasoning as members:read_sensitive above). Note this
  // is club-wide, not scoped to just their own department -- same shape as
  // their existing departments:write (Wave 1 precedent), not a new gap.
  abteilungsleitung: ["departments:write", "calendars:write", "locations:write", "inventory:write", "locations:read_access"],
  trainer: [],
  erziehungsberechtigt: [],
};

/** True if any of the caller's club_roles grants `permission`. */
export function hasClubPermission(roleTypes: readonly string[], permission: ClubPermission): boolean {
  return roleTypes.some((roleType) => (ROLE_PERMISSIONS[roleType as ClubRoleType] ?? []).includes(permission));
}

/** All permissions the caller's roles grant, deduplicated -- lets clients hide UI they'd get a 403 for. */
export function clubPermissionsFor(roleTypes: readonly string[]): ClubPermission[] {
  return [...new Set(roleTypes.flatMap((roleType) => ROLE_PERMISSIONS[roleType as ClubRoleType] ?? []))];
}

/** Roles considered "board" for quick checks (e.g. Vereinsinfo board listing). */
export const BOARD_ROLE_TYPES: ClubRoleType[] = ["vorsitz", "stellv_vorsitz", "kassenwart", "schriftfuehrer", "beisitzer"];
