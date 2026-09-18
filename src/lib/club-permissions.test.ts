import { describe, expect, it } from "vitest";

import { hasClubPermission } from "./club-permissions.js";

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
});
