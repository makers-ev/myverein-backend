import { hasClubPermission } from "./club-permissions.js";
import type { FieldDefinition } from "./custom-fields.js";

/**
 * Who may read and write which custom field value (Wave 8 B7, ADR-005). Deny-by-default: anything not explicitly granted
 * here is refused, an unknown `visible_to` / `editable_by` value grants nothing.
 *
 * Read (the person a value belongs to is "self"):
 * - self always sees the own values (incl. sensitive ones: it is their own data);
 * - `sensitive` values of OTHER people need `members:read_sensitive`, whatever `visible_to` says (every such read is
 *   audited by the route);
 * - `visible_to = vorstand`: `members:write` or `members:read_sensitive`;
 * - `visible_to = funktionstraeger`: the board (as above) plus the roles `trainer` and `abteilungsleitung`;
 * - `visible_to = mitglied`: every account member (the implicit role `mitglied`; external guests are not members).
 *
 * Write:
 * - the board writes with `members:write` (a `sensitive` field additionally needs `members:read_sensitive`, so nobody
 *   can write data they could not read back), whatever `editable_by` says;
 * - self writes only fields with `editable_by = self`;
 * - an archived definition is never written.
 */

/** Roles (besides the board) that count as "Funktionsträger" for `visible_to = funktionstraeger`. */
export const FUNKTIONSTRAEGER_ROLES = ["trainer", "abteilungsleitung"] as const;

type Access = Pick<FieldDefinition, "visibleTo" | "editableBy" | "sensitive" | "archivedAt">;

export interface Viewer {
  /** The caller's club role types (as resolved by `clubGuard`, incl. the implicit `mitglied`). */
  roleTypes: readonly string[];
  /** The value belongs to the caller. */
  isSelf: boolean;
}

/** `members:write` or `members:read_sensitive`: the part of the board that works with member data. */
export function isBoardLevel(roleTypes: readonly string[]): boolean {
  return hasClubPermission(roleTypes, "members:write") || hasClubPermission(roleTypes, "members:read_sensitive");
}

/**
 * The credential overview (`GET /club-members/credentials`) is a club-wide list: board-level callers and the Funktionsträger
 * roles only, NEVER plain members, even if a credential field is visible to `mitglied` on a single member's profile.
 */
export function canViewCredentialOverview(roleTypes: readonly string[]): boolean {
  return isBoardLevel(roleTypes) || roleTypes.some((r) => (FUNKTIONSTRAEGER_ROLES as readonly string[]).includes(r));
}

export function canReadValue(def: Pick<Access, "visibleTo" | "sensitive">, viewer: Viewer): boolean {
  if (viewer.isSelf) return true;
  if (def.sensitive) return hasClubPermission(viewer.roleTypes, "members:read_sensitive");
  switch (def.visibleTo) {
    case "vorstand":
      return isBoardLevel(viewer.roleTypes);
    case "funktionstraeger":
      return isBoardLevel(viewer.roleTypes) || viewer.roleTypes.some((r) => (FUNKTIONSTRAEGER_ROLES as readonly string[]).includes(r));
    case "mitglied":
      return viewer.roleTypes.includes("mitglied") || isBoardLevel(viewer.roleTypes);
    default:
      return false;
  }
}

/** Board write (`PUT /club-members/:id/custom-fields`). */
export function canBoardWrite(def: Pick<Access, "sensitive" | "archivedAt">, roleTypes: readonly string[]): boolean {
  if (def.archivedAt !== null) return false;
  if (!hasClubPermission(roleTypes, "members:write")) return false;
  return !def.sensitive || hasClubPermission(roleTypes, "members:read_sensitive");
}

/** Self write (`PATCH /club-members/me/custom-fields`). */
export function canSelfWrite(def: Pick<Access, "editableBy" | "archivedAt">): boolean {
  return def.archivedAt === null && def.editableBy === "self";
}

/**
 * A guardian (Erziehungsberechtigte) of a child reads what a plain member could see of that child plus what the child may
 * fill in itself: `editable_by = self` fields and `visible_to = mitglied` fields, never `sensitive` ones and never fields
 * that are board / Funktionsträger internal (not even their label).
 */
export function canGuardianRead(def: Pick<Access, "visibleTo" | "editableBy" | "sensitive" | "archivedAt">): boolean {
  return def.archivedAt === null && !def.sensitive && (def.editableBy === "self" || def.visibleTo === "mitglied");
}

/** A guardian writes only what the child itself may write (`editable_by = self`), never `sensitive` fields. */
export function canGuardianWrite(def: Pick<Access, "editableBy" | "sensitive" | "archivedAt">): boolean {
  return canSelfWrite(def) && !def.sensitive;
}
