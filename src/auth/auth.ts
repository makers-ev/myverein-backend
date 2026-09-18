import "dotenv/config";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { expo } from "@better-auth/expo";
import { eq } from "drizzle-orm";
import { admin, bearer, openAPI, organization, twoFactor } from "better-auth/plugins";

import { db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { notification, notificationTemplate } from "../db/schema/notifications.js";
import { sendEmail } from "../lib/email.js";
import { APP_NAME, buildResetPasswordEmail, buildVerifyEmailEmail, LOGO_CID, LOGO_PATH } from "../lib/emailTemplate.js";
import { isHttpsDeployment, trustedOrigins } from "../lib/trusted-origins.js";
import { accessControl, adminRole, userRole } from "./permissions.js";

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
  // Off by default in Better Auth -- without this, /delete-user 404s.
  user: {
    deleteUser: {
      enabled: true,
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
    organization(),
    admin({
      ac: accessControl,
      roles: { admin: adminRole, user: userRole },
    }),
    twoFactor(),
    bearer(),
    openAPI(),
  ],
  databaseHooks: {
    session: {
      create: {
        after: async (session) => {
          // Structural fix for the "no audit trail for account lifecycle
          // events" finding: this write lands in the same Postgres as every
          // domain mutation, instead of a separate IdP database Keycloak
          // could never transactionally join.
          await db.insert(auditLog).values({
            eventType: "session.create",
            subjectId: session.userId,
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
