import { describe, expect, it } from "vitest";

import { adminRole, statement, userRole } from "./permissions.js";

describe("permissions", () => {
  it("extends the default statements with the account resource", () => {
    expect(statement.account).toEqual(["create", "read", "update", "delete"]);
  });

  it("gives admin full account CRUD", () => {
    expect(adminRole.statements.account).toEqual(["create", "read", "update", "delete"]);
    expect(adminRole.authorize({ account: ["delete"] }).success).toBe(true);
  });

  it("does not let a regular user delete accounts", () => {
    expect(userRole.statements.account).toEqual(["create", "read", "update"]);
    expect(userRole.authorize({ account: ["delete"] }).success).toBe(false);
  });

  it("lets a regular user create/read/update accounts", () => {
    expect(userRole.authorize({ account: ["create"] }).success).toBe(true);
    expect(userRole.authorize({ account: ["read"] }).success).toBe(true);
    expect(userRole.authorize({ account: ["update"] }).success).toBe(true);
  });
});
