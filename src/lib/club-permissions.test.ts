import { describe, expect, it } from "vitest";

import { ASSIGNABLE_ROLE_TYPES, CLUB_ROLE_TYPES, clubPermissionsFor, hasClubPermission } from "./club-permissions.js";

describe("hasClubPermission", () => {
  it("grants members:write to vorsitz", () => {
    expect(hasClubPermission(["vorsitz"], "members:write")).toBe(true);
  });

  it("grants members:read_sensitive to kassenwart but not members:write", () => {
    expect(hasClubPermission(["kassenwart"], "members:read_sensitive")).toBe(true);
    expect(hasClubPermission(["kassenwart"], "members:write")).toBe(false);
  });

  it("denies everything to a plain member with no club_roles", () => {
    expect(hasClubPermission([], "members:write")).toBe(false);
    expect(hasClubPermission([], "members:read_sensitive")).toBe(false);
    expect(hasClubPermission([], "roles:write")).toBe(false);
  });

  it("grants a permission if ANY held role grants it (multi-role membership)", () => {
    expect(hasClubPermission(["trainer", "kassenwart"], "members:read_sensitive")).toBe(true);
  });

  it("beisitzer and trainer/erziehungsberechtigt hold no write permissions", () => {
    for (const role of ["beisitzer", "trainer", "erziehungsberechtigt"] as const) {
      expect(hasClubPermission([role], "members:write")).toBe(false);
      expect(hasClubPermission([role], "roles:write")).toBe(false);
      expect(hasClubPermission([role], "departments:write")).toBe(false);
      expect(hasClubPermission([role], "club_info:write")).toBe(false);
    }
  });

  it("ignores an unknown role_type instead of throwing", () => {
    expect(hasClubPermission(["some_future_role"], "members:write")).toBe(false);
  });

  it("grants calendars:write to vorsitz/stellv_vorsitz/schriftfuehrer/abteilungsleitung but not kassenwart/trainer", () => {
    for (const role of ["vorsitz", "stellv_vorsitz", "schriftfuehrer", "abteilungsleitung"] as const) {
      expect(hasClubPermission([role], "calendars:write")).toBe(true);
    }
    for (const role of ["kassenwart", "beisitzer", "trainer", "erziehungsberechtigt"] as const) {
      expect(hasClubPermission([role], "calendars:write")).toBe(false);
    }
  });

  it("the implicit role mitglied is a role type, has no permissions and is not assignable", () => {
    expect(CLUB_ROLE_TYPES).toContain("mitglied");
    expect(ASSIGNABLE_ROLE_TYPES).not.toContain("mitglied");
    expect(clubPermissionsFor(["mitglied"])).toEqual([]);
    expect(hasClubPermission(["mitglied"], "meetings:write")).toBe(false);
    expect(hasClubPermission(["mitglied"], "meetings:read_board")).toBe(false);
    expect(hasClubPermission(["mitglied"], "locations:read_access")).toBe(false);
  });

  it("grants the new read permissions only to the agreed roles", () => {
    for (const role of ["vorsitz", "stellv_vorsitz", "schriftfuehrer", "beisitzer"]) expect(hasClubPermission([role], "meetings:read_board")).toBe(true);
    for (const role of ["kassenwart", "abteilungsleitung", "trainer", "erziehungsberechtigt"]) expect(hasClubPermission([role], "meetings:read_board")).toBe(false);
    for (const role of ["vorsitz", "stellv_vorsitz", "schriftfuehrer", "abteilungsleitung"]) expect(hasClubPermission([role], "locations:read_access")).toBe(true);
    for (const role of ["kassenwart", "beisitzer", "trainer", "erziehungsberechtigt"]) expect(hasClubPermission([role], "locations:read_access")).toBe(false);
  });

  it("schriftfuehrer lacks roles:write (why it is not a claimable founding role)", () => {
    expect(hasClubPermission(["schriftfuehrer"], "roles:write")).toBe(false);
  });
});
