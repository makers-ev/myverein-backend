/**
 * Roles/permissions for Better Auth's `admin` plugin access control.
 *
 * Better Auth ships default `user`/`admin` roles (see
 * `better-auth/plugins/admin/access`). We extend the default statement set
 * with a resource this template actually has ("account", matching
 * src/db/schema/accounts.ts and src/routes/accounts.ts) so a real project has
 * a working example to model its own resources on instead of hand-rolling
 * role checks -- which is exactly the class of bug the JWT-audience-disabled
 * finding in the old backend fell into (ad-hoc, incomplete authorization
 * logic instead of one central, typed access-control definition).
 */
import { createAccessControl } from "better-auth/plugins/access";
import { adminAc, defaultStatements, userAc } from "better-auth/plugins/admin/access";

export const statement = {
  ...defaultStatements,
  account: ["create", "read", "update", "delete"],
} as const;

export const accessControl = createAccessControl(statement);

export const adminRole = accessControl.newRole({
  ...adminAc.statements,
  account: ["create", "read", "update", "delete"],
});

export const userRole = accessControl.newRole({
  ...userAc.statements,
  account: ["create", "read", "update"],
});

export const roles = {
  admin: adminRole,
  user: userRole,
};
