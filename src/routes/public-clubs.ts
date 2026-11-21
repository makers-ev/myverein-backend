import { Hono, type Context } from "hono";

import { BadRequestError, NotFoundError } from "../lib/errors.js";
import { stripControlChars } from "../lib/search-text.js";
import { SLUG_RE } from "../lib/forms.js";
import { enforceLimit, HOUR_MS } from "../lib/rate-limits.js";
import { liveClubBySlug, publicCaller, publicInvalidLimit, publicIpLimit, publicSearchLimit, publicTrustedInvalidLimit, publicTrustedLimit, SEARCH_CITY_MIN, SEARCH_Q_MIN, searchPublicClubs, shapePublicClub } from "../lib/public-profile.js";

/**
 * Public club routes (Wave 15 B3), mounted at `/public` next to the guest event routes. NO session. Strictly opt-in: a club is
 * only visible while `club_settings.public_profile_enabled` is on, a version is published and the club is not suspended; every
 * other case is the SAME 404 (no oracle for slugs), and failed lookups count against a strict per-client budget. Responses are a
 * fixed field whitelist (`shapePublicClub`) with unsigned URLs of released media only. Caching: a hit is `public, no-cache` (cacheable
 * but revalidated on every request, so revocation is immediate; it does not depend on cookies or request headers); 404/429 `no-store`.
 */
export const publicClubRoutes = new Hono();

const publicGuard = async (c: Context, next: () => Promise<void>) => {
  c.header("X-Robots-Tag", "noindex, nofollow");
  c.header("Cache-Control", "no-store");
  const caller = publicCaller(c);
  await enforceLimit({ bucket: caller.subject === "trusted-server" ? "public_club.trusted" : "public_club.ip", subject: caller.subject, windowMs: HOUR_MS, max: caller.subject === "trusted-server" ? publicTrustedLimit() : publicIpLimit() });
  await next();
};
publicClubRoutes.use("/clubs", publicGuard);
publicClubRoutes.use("/clubs/*", publicGuard);

/** One 404 for unknown, disabled, unpublished and suspended clubs; counts against the strict "invalid" budget of the caller. */
export async function publicNotFound(c: Context): Promise<never> {
  // The failure budget applies to every caller: per visitor (also a visitor forwarded by the trusted website server) and, for the
  // trusted server without a forwarded address, to its shared bucket.
  const caller = publicCaller(c);
  const trustedShared = caller.subject === "trusted-server";
  await enforceLimit({ bucket: trustedShared ? "public_club.trusted_invalid" : "public_club.invalid", subject: caller.subject, windowMs: HOUR_MS, max: trustedShared ? publicTrustedInvalidLimit() : publicInvalidLimit() });
  throw new NotFoundError("Not found");
}

/**
 * Public data, but publishing, unpublishing and a suspension must take effect at once: shared caches may store the response but
 * have to revalidate it on every request (`no-cache`), so a revoked page is never served from a cache.
 */
export function publicCacheHeaders(c: Context): void {
  c.header("Cache-Control", "public, no-cache");
  c.header("Vary", "Accept-Encoding");
}

publicClubRoutes.get("/clubs/:slug", async (c) => {
  const slug = c.req.param("slug");
  const live = SLUG_RE.test(slug) ? await liveClubBySlug(slug) : null;
  if (!live) return publicNotFound(c);
  const data = await shapePublicClub(live.club, live.content);
  publicCacheHeaders(c);
  return c.json({ data });
});

/** Club search (Wave 15 B5): opt-in clubs only (`discoverable`), at most 10 hits, no total, own rate limit per client. */
publicClubRoutes.get("/clubs", async (c) => {
  const caller = publicCaller(c);
  await enforceLimit({ bucket: "public_club.search", subject: caller.subject, windowMs: HOUR_MS, max: caller.subject === "trusted-server" ? publicTrustedLimit() : publicSearchLimit() });
  const clean = (v: string | undefined) => stripControlChars(v ?? "").trim().slice(0, 100).trim();
  const q = clean(c.req.query("q"));
  const city = clean(c.req.query("city"));
  const qOk = q.length >= SEARCH_Q_MIN;
  const cityOk = city.length >= SEARCH_CITY_MIN;
  if ((!qOk && !cityOk) || (q.length > 0 && !qOk) || (city.length > 0 && !cityOk)) {
    throw new BadRequestError(`Search needs a name of at least ${SEARCH_Q_MIN} or a city of at least ${SEARCH_CITY_MIN} characters`, { code: "QUERY_TOO_SHORT", details: { code: "query_too_short", min: SEARCH_Q_MIN, minCity: SEARCH_CITY_MIN } });
  }
  const data = await searchPublicClubs(qOk ? q : null, cityOk ? city : null);
  publicCacheHeaders(c);
  return c.json({ data });
});
