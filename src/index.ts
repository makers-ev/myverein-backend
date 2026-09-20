import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";

import { auth } from "./auth/auth.js";
import { closeDatabase } from "./db/client.js";
import { AppError, toAppError } from "./lib/errors.js";
import { logger } from "./lib/logger.js";
import { type LoggerEnv, requestId } from "./middleware/request-id.js";
import { adminNotificationRoutes } from "./routes/admin-notifications.js";
import { adminNotificationTemplateRoutes } from "./routes/admin-notification-templates.js";
import { adminStatsRoutes } from "./routes/admin-stats.js";
import { adminEmailRoutes } from "./routes/admin-emails.js";
import { availabilityRoutes } from "./routes/availability.js";
import { calendarRoutes } from "./routes/calendars.js";
import { clubInfoRoutes } from "./routes/club-info.js";
import { clubMemberRoutes } from "./routes/club-members.js";
import { departmentRoutes } from "./routes/departments.js";
import { eventRoutes, icsRoutes } from "./routes/events.js";
import { healthRoutes } from "./routes/health.js";
import { inventoryItemRoutes } from "./routes/inventory-items.js";
import { locationRoutes } from "./routes/locations.js";
import { mediaRoutes } from "./routes/media.js";
import { meetingRoutes } from "./routes/meetings.js";
import { myClubRoutes } from "./routes/my-clubs.js";
import { internalStatsRoutes } from "./routes/internal-stats.js";
import { notificationRoutes } from "./routes/notifications.js";
import { trustedOrigins } from "./lib/trusted-origins.js";

const app = new Hono<LoggerEnv>();

app.use("*", requestId);

// JSON API with no HTML to protect -- CSP is deliberately skipped, the
// nonce-CSP proxy pattern in the website template is overkill/wrong here.
app.use(
  "*",
  secureHeaders({
    xContentTypeOptions: true,
    xFrameOptions: "DENY",
    referrerPolicy: "strict-origin-when-cross-origin",
  }),
);

app.use(
  "*",
  cors({
    origin: trustedOrigins,
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    credentials: true,
  }),
);

// Central error mapping: any AppError thrown by a route/middleware is turned
// into its mapped HTTP status + JSON body. Anything else is treated as an
// opaque 500 so internals never leak to clients.
app.onError((err, c) => {
  const appError = toAppError(err);
  if (!(err instanceof AppError)) {
    c.get("logger").error({ err }, "unhandled error");
  }
  return c.json(appError.toJSON(), appError.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503);
});

// Better Auth owns everything under /api/auth/* -- sign-up, sign-in,
// session management, 2FA, organization, admin, and the OpenAPI reference
// (per plugin config in src/auth/auth.ts). No hand-rolled auth routes exist
// anywhere else in this app.
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

app.route("/", healthRoutes);
app.route("/internal", internalStatsRoutes);
app.route("/admin", adminStatsRoutes);
app.route("/admin", adminEmailRoutes);
app.route("/notifications", notificationRoutes);
app.route("/admin/notifications", adminNotificationRoutes);
app.route("/admin/notification-templates", adminNotificationTemplateRoutes);
app.route("/my-clubs", myClubRoutes);
app.route("/club-members", clubMemberRoutes);
app.route("/departments", departmentRoutes);
app.route("/club-info", clubInfoRoutes);
app.route("/calendars", calendarRoutes);
app.route("/events", eventRoutes);
app.route("/events.ics", icsRoutes);
app.route("/availability", availabilityRoutes);
app.route("/meetings", meetingRoutes);
app.route("/locations", locationRoutes);
app.route("/inventory-items", inventoryItemRoutes);
app.route("/media", mediaRoutes);

const port = Number(process.env.PORT ?? 3000);
// Loopback-only by default -- LAN testing (a browser hitting this machine's
// LAN IP, e.g. from another device or a non-localhost admin/website origin)
// needs an explicit opt-in, same reasoning as mycouple-backend's BIND_HOST.
const hostname = process.env.BIND_HOST ?? "127.0.0.1";

const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
  logger.info(`Server is running on http://${hostname}:${info.port}`);
});

async function shutdown(signal: string) {
  logger.info(`[shutdown] received ${signal}, closing server`);
  server.close(async () => {
    await closeDatabase();
    process.exit(0);
  });
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

export type AppType = typeof app;
