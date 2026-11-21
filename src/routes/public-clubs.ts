import { Hono, type Context } from "hono";

import { NotFoundError } from "../lib/errors.js";
import { SLUG_RE } from "../lib/forms.js";
import { enforceLimit, HOUR_MS } from "../lib/rate-limits.js";
import { liveClubBySlug, publicCaller, publicInvalidLimit, publicIpLimit, publicTrustedLimit, shapePublicClub } from "../lib/public-profile.js";

/**
 * Public club routes (Wave 15 B3), mounted at `/public` next to the guest event routes. NO session. Strictly opt-in: a club is
 * only visible while `club_settings.public_profile_enabled` is on, a version is published and the club is not suspended; every
 * other case is the SAME 404 (no oracle for slugs), and failed lookups count against a strict per-client budget. Responses are a
 * fixed field whitelist (`shapePublicClub`) with unsigned URLs of released media only. Caching: a hit is public for 5 minutes
 * (it does not depend on cookies or other request headers, so a shared cache cannot be poisoned); 404 and 429 are `no-store`.
 */
export const publicClubRoutes = new Hono();

publicClubRoutes.use("/clubs/*", async (c, next) => {
  c.header("X-Robots-Tag", "noindex, nofollow");
  c.header("Cache-Control", "no-store");
  const caller = publicCaller(c);
  await enforceLimit({ bucket: caller.subject === "trusted-server" ? "public_club.trusted" : "public_club.ip", subject: caller.subject, windowMs: HOUR_MS, max: caller.subject === "trusted-server" ? publicTrustedLimit() : publicIpLimit() });
  await next();
});

/** One 404 for unknown, disabled, unpublished and suspended clubs; counts against the strict "invalid" budget of the caller. */
export async function publicNotFound(c: Context): Promise<never> {
  const caller = publicCaller(c);
  if (caller.subject !== "trusted-server") await enforceLimit({ bucket: "public_club.invalid", subject: caller.subject, windowMs: HOUR_MS, max: publicInvalidLimit() });
  throw new NotFoundError("Not found");
}

export function publicCacheHeaders(c: Context, maxAgeSeconds: number): void {
  c.header("Cache-Control", `public, max-age=${maxAgeSeconds}, s-maxage=${maxAgeSeconds}, stale-while-revalidate=60`);
  c.header("Vary", "Accept-Encoding");
}

publicClubRoutes.get("/clubs/:slug", async (c) => {
  const slug = c.req.param("slug");
  const live = SLUG_RE.test(slug) ? await liveClubBySlug(slug) : null;
  if (!live) return publicNotFound(c);
  const data = await shapePublicClub(live.club, live.content);
  publicCacheHeaders(c, 300);
  return c.json({ data });
});
