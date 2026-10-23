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

  it("grants forms:write to vorsitz/stellv_vorsitz/schriftfuehrer only (deny-by-default for everything else)", () => {
    for (const role of ["vorsitz", "stellv_vorsitz", "schriftfuehrer"] as const) expect(hasClubPermission([role], "forms:write")).toBe(true);
    for (const role of CLUB_ROLE_TYPES.filter((r) => !["vorsitz", "stellv_vorsitz", "schriftfuehrer"].includes(r))) expect(hasClubPermission([role], "forms:write")).toBe(false);
    expect(hasClubPermission([], "forms:write")).toBe(false);
  });
});

describe("announcements permissions (Wave 9 B7)", () => {
  it("announcements:write is held by vorsitz, stellv_vorsitz and schriftfuehrer only", () => {
    for (const role of ["vorsitz", "stellv_vorsitz", "schriftfuehrer"]) expect(hasClubPermission([role], "announcements:write")).toBe(true);
    for (const role of ["mitglied", "kassenwart", "beisitzer", "abteilungsleitung", "trainer", "erziehungsberechtigt", "unknown"]) expect(hasClubPermission([role], "announcements:write")).toBe(false);
  });

  it("announcements:write_department is held by abteilungsleitung and trainer only (scope comes from club_roles.department_id)", () => {
    for (const role of ["abteilungsleitung", "trainer"]) expect(hasClubPermission([role], "announcements:write_department")).toBe(true);
    for (const role of ["mitglied", "vorsitz", "kassenwart", "beisitzer", "erziehungsberechtigt"]) expect(hasClubPermission([role], "announcements:write_department")).toBe(false);
    expect(clubPermissionsFor(["trainer"]).sort()).toEqual(["absences:read", "announcements:write_department"]);
  });
});

describe("privacy permissions (Wave 10 B2)", () => {
  it("privacy:read and privacy:manage are held by vorsitz and stellv_vorsitz only", () => {
    for (const permission of ["privacy:read", "privacy:manage"] as const) {
      for (const role of ["vorsitz", "stellv_vorsitz"]) expect(hasClubPermission([role], permission)).toBe(true);
      for (const role of CLUB_ROLE_TYPES.filter((r) => !["vorsitz", "stellv_vorsitz"].includes(r))) expect(hasClubPermission([role], permission)).toBe(false);
      expect(hasClubPermission([], permission)).toBe(false);
    }
  });

  it("absences:read goes to the board chairs and to trainer/abteilungsleitung (scope = own departments, checked in the route)", () => {
    for (const role of ["vorsitz", "stellv_vorsitz", "abteilungsleitung", "trainer"]) expect(hasClubPermission([role], "absences:read")).toBe(true);
    for (const role of ["mitglied", "schriftfuehrer", "kassenwart", "beisitzer", "erziehungsberechtigt"]) expect(hasClubPermission([role], "absences:read")).toBe(false);
  });

  it("a guardian gets no permission at all", () => {
    expect(clubPermissionsFor(["erziehungsberechtigt"])).toEqual([]);
  });
});

describe("assembly permission (Wave 11 B1)", () => {
  it("assembly:manage is held by vorsitz, stellv_vorsitz and schriftfuehrer only", () => {
    for (const role of ["vorsitz", "stellv_vorsitz", "schriftfuehrer"]) expect(hasClubPermission([role], "assembly:manage")).toBe(true);
    for (const role of CLUB_ROLE_TYPES.filter((r) => !["vorsitz", "stellv_vorsitz", "schriftfuehrer"].includes(r))) expect(hasClubPermission([role], "assembly:manage")).toBe(false);
    expect(hasClubPermission([], "assembly:manage")).toBe(false);
    expect(clubPermissionsFor(["schriftfuehrer"])).toContain("assembly:manage");
  });
});
