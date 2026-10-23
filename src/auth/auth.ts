import "dotenv/config";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { expo } from "@better-auth/expo";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { eq } from "drizzle-orm";
import { admin, bearer, openAPI, organization, twoFactor } from "better-auth/plugins";

import { organization as organizationTable, user as userTable } from "./auth-schema.js";
import { db } from "../db/client.js";
import { ensureConsentPurposes } from "../lib/consent-purposes.js";
import { assertRejoinAllowed, ensureClubMember, markDetachedMembersLeft } from "../lib/club-members.js";
import { recordKeyReturnsForRemovedAccount } from "../lib/key-returns.js";
import { ConflictError } from "../lib/errors.js";
import { inviteLinkContext } from "../lib/invite-context.js";
import { logger } from "../lib/logger.js";
import { notification, notificationTemplate } from "../db/schema/notifications.js";
import { changesAfterUserUpdate, rememberBeforeUserUpdate, type HookContext } from "../lib/account-change-tracker.js";
import { notifyAccountChange } from "../lib/account-notify.js";
import { sendEmail } from "../lib/email.js";
import { pickMailLanguage, type MailLanguage } from "../lib/notify/i18n.js";
import { APP_NAME, buildResetPasswordEmail, buildVerifyEmailEmail, LOGO_CID, LOGO_PATH } from "../lib/emailTemplate.js";
import { isHttpsDeployment, trustedOrigins } from "../lib/trusted-origins.js";
import { accessControl, adminRole, userRole } from "./permissions.js";
import { writeAudit } from "../lib/audit.js";

if (!process.env.WEB_ORIGIN) {
  throw new Error("WEB_ORIGIN is not set. Copy .env.example to .env and configure it.");
}

const authSecret = process.env.BETTER_AUTH_SECRET;
if (!authSecret) {
  throw new Error("BETTER_AUTH_SECRET is not set. Copy .env.example to .env and configure it.");
}

/**
 * The single, central Better Auth instance. There is deliberately no
 * hand-rolled JWT verification anywhere in this template -- the old
 * Keycloak backend had incomplete/disabled JWT audience validation
 * (NEW-ARCHITECTURE-README §7, CRITICAL finding). Better Auth owns session
 * and token validation end to end via `trustedOrigins` + its own
 * server-side session table lookups.
 */
/** Maps the domain 409 of `assertRejoinAllowed` to a Better Auth error so the join attempt is rejected. */
function rejoinBlocked(err: unknown): never {
  if (err instanceof ConflictError) throw new APIError("CONFLICT", { message: err.message });
  throw err;
}

/** Language of an account notice: the `Accept-Language` of the request that caused it (German if absent). */
const langOf = (source: { request?: Request | null; headers?: Headers | null } | null | undefined): MailLanguage =>
  pickMailLanguage(source?.headers?.get("accept-language") ?? source?.request?.headers.get("accept-language"));

export const auth = betterAuth({
  secret: authSecret,
  // Explicit instead of inferred from the request host -- matters once this
  // sits behind a reverse proxy in production (see .env.example).
  baseURL: process.env.BACKEND_URL,
  database: drizzleAdapter(db, { provider: "pg" }),
  // Shared with index.ts's cors() middleware -- see trusted-origins.ts.
  trustedOrigins,
  advanced: {
    // A `Secure`-flagged cookie over a plain-HTTP LAN connection (a common
    // real dev/testing setup: a phone on the same network hitting the
    // host's IP, no TLS) gets silently dropped by any spec-compliant HTTP
    // client -- sign-in appears to succeed, but the session cookie is
    // never actually stored/resent, so every subsequent authenticated
    // request 401s. Keying this off `NODE_ENV` (as an earlier version of
    // this template did) breaks exactly this scenario, since the Docker
    // path always sets NODE_ENV=production regardless of TLS.
    useSecureCookies: isHttpsDeployment,
    // Only takes effect when COOKIE_DOMAIN is set AND this is an HTTPS
    // deployment -- gated the same way useSecureCookies/secure are above.
    // A registrable domain like "example.com" doesn't domain-match an IP
    // address (local/LAN dev's BACKEND_URL), so applying it unconditionally
    // would make the browser silently reject the entire Set-Cookie during
    // local dev per RFC 6265's domain-match rule -- sign-in would appear to
    // succeed with every subsequent request unauthenticated, no error
    // anywhere. Needed when a client (website, admin dashboard, ...) runs on
    // a different subdomain than this backend (e.g. app.example.com talking
    // to api.example.com) -- leave COOKIE_DOMAIN unset for a single
    // -subdomain / same-origin deployment, which doesn't need this at all.
    crossSubDomainCookies: {
      enabled: isHttpsDeployment && !!process.env.COOKIE_DOMAIN,
      domain: isHttpsDeployment ? process.env.COOKIE_DOMAIN : undefined,
    },
    defaultCookieAttributes: {
      sameSite: "lax",
      secure: isHttpsDeployment,
      domain: isHttpsDeployment ? process.env.COOKIE_DOMAIN : undefined,
    },
  },
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    // Security notice after a completed reset (G8). The reset mail itself stays a Better Auth mail on purpose: it must work
    // before the account has a verified address, so it cannot depend on the dispatcher's mandatory-class contact rules.
    onPasswordReset: async ({ user: resetUser }, request) => {
      await notifyAccountChange("password_changed", { id: resetUser.id, name: resetUser.name, email: resetUser.email }, { lang: langOf({ request }) });
    },
    sendResetPassword: async ({ user, url }) => {
      // Better Auth builds `url` as
      // `${BACKEND_URL}/reset-password/:token?callbackURL=<client redirectTo>`.
      // The callbackURL is empty when the calling client doesn't pass
      // `redirectTo`, and Better Auth's GET /reset-password/:token handler
      // rejects (INVALID_TOKEN) a link without a callbackURL -- so a reset
      // email sent by a client that omits redirectTo would dead-end.
      // Default the callback to the website's reset page (first WEB_ORIGIN)
      // so the link always lands somewhere usable, regardless of caller.
      const resetUrl = new URL(url);
      if (!resetUrl.searchParams.get("callbackURL")) {
        const webOrigin = (process.env.WEB_ORIGIN ?? "").split(",")[0]?.trim();
        if (webOrigin) {
          resetUrl.searchParams.set("callbackURL", `${webOrigin}/reset-password`);
        }
      }
      await sendEmail({
        to: user.email,
        subject: "Passwort zurücksetzen",
        html: buildResetPasswordEmail({ name: user.name, url: resetUrl.href }),
        attachments: [{ filename: "logo.png", path: LOGO_PATH, cid: LOGO_CID }],
      });
    },
  },
  emailVerification: {
    sendVerificationEmail: async ({ user, url }) => {
      await sendEmail({
        to: user.email,
        subject: "E-Mail-Adresse bestätigen",
        html: buildVerifyEmailEmail({ name: user.name, url }),
        attachments: [{ filename: "logo.png", path: LOGO_PATH, cid: LOGO_CID }],
      });
    },
  },
  rateLimit: {
    window: 60,
    max: 20,
  },
  // The admin plugin's remove-user would delete the account without the erasure process (blockers, anonymisation):
  // platform admins use DELETE /admin/users/:id, which runs it first (routes/admin-users.ts).
  disabledPaths: ["/admin/remove-user"],
  // Off by default in Better Auth -- without this, /delete-user 404s.
  user: {
    deleteUser: {
      enabled: true,
      // Wave 10 B8: deleting the account runs the same erasure process as the board's (anonymise the club records instead of
      // letting the FK cascades wipe attendance and role history). Blockers (sole owner, board role, open loans, legal hold,
      // pending exit) stop the deletion before anything changes. Dynamic import: the erasure code imports modules that import this file.
      beforeDelete: async (deleting) => {
        const { eraseAccountMemberships } = await import("../lib/privacy/erasure.js");
        try {
          await eraseAccountMemberships(deleting.id);
        } catch (err) {
          const details = (err as { details?: { code?: string } }).details;
          if (err instanceof ConflictError && details?.code) {
            throw new APIError("BAD_REQUEST", { message: err.message, code: `ERASURE_${details.code.toUpperCase()}` });
          }
          throw err;
        }
      },
    },
  },
  plugins: [
    // Mirrors the mobile template's `expoClient()` (_template_better-auth-mobile/
    // src/auth/auth-client.ts): that plugin sends a custom `expo-origin`
    // header instead of a real browser `Origin` (React Native's fetch can't
    // set the reserved `Origin` header). Without this server-side
    // counterpart, every Better-Auth-native mutation made with an existing
    // session cookie (2FA enable, change password, revoke session, etc. --
    // anything past initial sign-in) fails origin-check with FORBIDDEN/
    // "missing or null origin", because better-auth's core origin-check
    // middleware only recognizes the real `origin`/`referer` headers, which
    // native fetch never sends. This plugin rewrites `expo-origin` into a
    // request better-auth itself already trusts.
    expo(),
    organization({
      // Clubs are created ONLY server-side: by the Wave 6 approval flow
      // (routes/admin-club-registrations.ts) and `npm run seed:club`, both of
      // which call `auth.api.createOrganization({ body: { userId } })` without
      // a session -- Better Auth treats that as a system action and skips this
      // flag. Left at its default (true), any signed-in user could POST
      // /api/auth/organization/create with an arbitrary slug (squatting).
      allowUserToCreateOrganization: false,
      // Owners must not be able to delete their club: the freed slug could be re-squatted and the approved
      // registration would be left with club_id NULL. (Deleting is a platform/DB operation.)
      disableOrganizationDeletion: true,
      organizationHooks: {
        // Wave 10: every new club gets its (inactive) system consent purposes. A failure is logged, not thrown; the
        // consent routes call ensureConsentPurposes again and repair it.
        afterCreateOrganization: async ({ organization: created }) => {
          try {
            await ensureConsentPurposes(created.id);
          } catch (err) {
            logger.error({ err, clubId: created.id }, "[auth] could not seed consent purposes for new club");
          }
        },
        // ADR-003: every account member (founder via createOrganization, addMember, accepted invitation) gets its
        // club_members row, so no join path can slip past. A failure is logged, not thrown: the account membership
        // already exists at this point and the explicit join flows (application approval, club approval, seed) as well
        // as GET /club-members and /me call ensureClubMember again and repair it.
        // Excluded / deceased persons can't re-join through addMember or an invitation (409); the board reopens first.
        beforeAddMember: async ({ member: adding }) => {
          await assertRejoinAllowed(db, adding.organizationId, adding.userId).catch(rejoinBlocked);
        },
        beforeAcceptInvitation: async ({ invitation, user: accepting }) => {
          await assertRejoinAllowed(db, invitation.organizationId, accepting.id).catch(rejoinBlocked);
        },
        afterAddMember: async ({ member: addedMember }) => {
          // Accepting a member invitation links the EXISTING club_members row afterwards (lib/member-invites.ts).
          if (inviteLinkContext.getStore()) return;
          try {
            await ensureClubMember(db, addedMember);
          } catch (err) {
            logger.error({ err, memberId: addedMember.id }, "[auth] could not create club_members row for new member");
          }
        },
        // Removing the account membership keeps the person as club member (FK ON DELETE SET NULL) but closes it
        // (status ausgetreten + history) so no ghost "aktiv" member without account remains. /leave and user deletion
        // fire no hook; there the same closing happens lazily (resolveClubMember, GET /club-members).
        // Keys the removed account still holds leave a `returned` history entry (the holder rows cascade away).
        beforeRemoveMember: async ({ member: removing }) => {
          try {
            await recordKeyReturnsForRemovedAccount(db, removing.id, null);
          } catch (err) {
            logger.error({ err, memberId: removing.id }, "[auth] could not record key returns of removed member");
          }
        },
        afterRemoveMember: async ({ organization: org }) => {
          try {
            await markDetachedMembersLeft(db, org.id);
          } catch (err) {
            logger.error({ err, clubId: org.id }, "[auth] could not close club_members row of removed member");
          }
        },
        afterAcceptInvitation: async ({ member: acceptedMember }) => {
          try {
            await ensureClubMember(db, acceptedMember);
          } catch (err) {
            logger.error({ err, memberId: acceptedMember.id }, "[auth] could not create club_members row for accepted invitation");
          }
        },
        // The slug is the public join key (Aufnahmeantrag) and the name is what the platform admin verified
        // during the registration review -- both must stay stable once assigned, so reject any attempt to
        // change them through /api/auth/organization/update. Re-sending the current value is a no-op;
        // other fields (logo, metadata) stay editable. A name change is a platform/DB operation.
        beforeUpdateOrganization: async ({ organization: data, member }) => {
          if (typeof data.slug !== "string" && typeof data.name !== "string") return;
          const current = await db.query.organization.findFirst({ where: eq(organizationTable.id, member.organizationId) });
          if (typeof data.slug === "string" && current?.slug !== data.slug) {
            throw new APIError("FORBIDDEN", { message: "The club slug cannot be changed" });
          }
          if (typeof data.name === "string" && current?.name !== data.name) {
            throw new APIError("FORBIDDEN", { message: "The club name cannot be changed" });
          }
        },
      },
    }),
    admin({
      ac: accessControl,
      roles: { admin: adminRole, user: userRole },
    }),
    twoFactor(),
    bearer(),
    openAPI(),
  ],
  hooks: {
    // organization/check-slug would let any signed-in user probe which club slugs exist (existence oracle),
    // and nothing in MyVerein needs it any more now that slugs are generated server-side.
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path === "/organization/check-slug") {
        throw new APIError("NOT_FOUND", { message: "Not found" });
      }
    }),
    // Security notice for a password changed while signed in (own change, or set by a platform admin) -- G8.
    after: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== "/change-password" && ctx.path !== "/admin/set-user-password") return;
      if (ctx.context.returned instanceof Error) return; // the change failed
      const adminTarget = ctx.path === "/admin/set-user-password" && typeof (ctx.body as { userId?: unknown } | undefined)?.userId === "string" ? (ctx.body as { userId: string }).userId : null;
      const targetId = adminTarget ?? ctx.context.session?.user.id ?? ctx.context.newSession?.user.id;
      if (!targetId) return;
      const [target] = await db.select({ id: userTable.id, name: userTable.name, email: userTable.email }).from(userTable).where(eq(userTable.id, targetId));
      if (target) await notifyAccountChange("password_changed", target, { lang: langOf(ctx) });
    }),
  },
  databaseHooks: {
    session: {
      create: {
        after: async (session) => {
          // Structural fix for the "no audit trail for account lifecycle
          // events" finding: this write lands in the same Postgres as every
          // domain mutation, instead of a separate IdP database Keycloak
          // could never transactionally join.
          await writeAudit(db, {
            eventType: "session.create",
            subjectId: session.userId,
            clubId: null,
            actorUserId: session.userId,
            payload: {
              sessionId: session.id,
              ipAddress: session.ipAddress ?? null,
              userAgent: session.userAgent ?? null,
            },
          });
        },
      },
    },
    user: {
      // E-mail change and two-factor switch (G8): snapshot before the write, compare against the WRITTEN row after it
      // (lib/account-change-tracker.ts; per request context, no body/session assumptions, no cross-request state).
      update: {
        before: async (data, context) => {
          await rememberBeforeUserUpdate(data, context as HookContext);
        },
        after: async (updated, context) => {
          const change = changesAfterUserUpdate(updated, context as HookContext);
          if (!updated || !change) return;
          if (change.previousEmail) {
            await notifyAccountChange("email_changed", { id: updated.id, name: change.previousEmail.name, email: change.previousEmail.address }, { lang: change.lang });
          }
          if (change.twoFactor !== undefined) {
            await notifyAccountChange(change.twoFactor ? "two_factor_enabled" : "two_factor_disabled", { id: updated.id, name: updated.name, email: updated.email }, { lang: change.lang });
          }
        },
      },
      create: {
        after: async (createdUser) => {
          // System notification (ADR-006): rendered client-side from
          // `translationKey`/`paramsJson` in the viewer's own language by
          // default. An admin-edited `notification_template` row (see
          // admin-notification-templates.ts) overrides that with a fixed
          // `translations` object instead (ADR-009) -- both clients prefer
          // `translations` over translationKey when it's present. No
          // override yet is the common case, so this is a plain lookup,
          // not a join.
          const override = await db.query.notificationTemplate.findFirst({
            where: eq(notificationTemplate.translationKey, "notification.welcome"),
          });
          await db.insert(notification).values({
            kind: "system",
            targetUserId: createdUser.id,
            translationKey: "notification.welcome",
            paramsJson: { appName: APP_NAME },
            translations: override?.translations,
          });
        },
      },
    },
  },
});

export type Auth = typeof auth;
