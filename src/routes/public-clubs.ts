import { createHash } from "node:crypto";

import { Hono, type Context } from "hono";
import { z } from "zod";

import { BadRequestError, NotFoundError, ValidationError } from "../lib/errors.js";
import { recordPublicLead } from "../lib/club-leads.js";
import { latestPublishedNotice } from "../lib/privacy-notice.js";
import { cleanText } from "../lib/text-policy.js";
import { stripControlChars } from "../lib/search-text.js";
import { SLUG_RE } from "../lib/forms.js";
import { DAY_MS, enforceLimit, envInt, HOUR_MS } from "../lib/rate-limits.js";

const leadIpLimit = () => envInt("PUBLIC_LEAD_IP_LIMIT_PER_HOUR", 5);
const leadClubLimit = () => envInt("PUBLIC_LEAD_CLUB_LIMIT_PER_DAY", 50);
import { liveClubBySlug, publicCaller, publicInvalidLimit, publicIpLimit, publicSearchLimit, publicTrustedInvalidLimit, publicTrustedLimit, SEARCH_CITY_MIN, SEARCH_Q_MIN, searchPublicClubs, shapePublicClub } from "../lib/public-profile.js";

/**
 * Public club routes (Wave 15 B3), mounted at `/public` next to the guest event routes. NO session. Strictly opt-in: a club is
 * only visible while `club_settings.public_profile_enabled` is on, a version is published and the club is not suspended; every
 * other case is the SAME 404 (no oracle for slugs), and failed lookups count against a strict per-client budget. Responses are a
 * fixed field whitelist (`shapePublicClub`) with unsigned URLs of released media only. Caching: a hit is `public, no-cache` (cacheable
 * but revalidated on every request, so revocation is immediate; it does not depend on cookies or request headers); 404/429 `no-store`.
 */
export const publicClubRoutes = new Hono();

const publicHeaders = (c: Context) => {
  c.header("X-Robots-Tag", "noindex, nofollow");
  c.header("Cache-Control", "no-store");
};
const publicGuard = async (c: Context, next: () => Promise<void>) => {
  publicHeaders(c);
  // "/clubs/*" also matches the search itself ("/clubs"), which has its own budget only.
  if (/\/clubs\/?$/.test(c.req.path)) return next();
  const caller = publicCaller(c);
  await enforceLimit({ bucket: caller.subject === "trusted-server" ? "public_club.trusted" : "public_club.ip", subject: caller.subject, windowMs: HOUR_MS, max: caller.subject === "trusted-server" ? publicTrustedLimit() : publicIpLimit() });
  await next();
};
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
  // Only the search budget counts here (not additionally the general per-client budget of the page routes).
  publicHeaders(c);
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

// --- Enquiries / trial training (Wave 15 B4) -------------------------------------------------------------------------------

const leadSchema = z.object({
  name: cleanText(z.string().trim().min(2).max(100)),
  email: z.string().trim().toLowerCase().max(320).pipe(z.email()),
  phone: z.union([cleanText(z.string().trim().max(40)), z.null()]).optional(),
  departmentId: z.uuid().nullable().optional(),
  message: z.union([cleanText(z.string().trim().max(2000), true), z.null()]).optional(),
  trialRequested: z.boolean().optional(),
  /** The visitor has seen the privacy notice of the club. */
  privacyAccepted: z.literal(true),
  /** Honeypot: invisible for people, bots fill it. */
  website: z.string().max(500).optional(),
});

async function readJson(c: Context): Promise<unknown> {
  const text = await c.req.text();
  if (text.length > 16 * 1024) throw new ValidationError("Request body too large");
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ValidationError("Invalid JSON body");
  }
}

/**
 * Public enquiry form. Same 404 as the page when the club is not live or the form is off. Limits: per client
 * (`PUBLIC_LEAD_IP_LIMIT_PER_HOUR`), per club and day (`PUBLIC_LEAD_CLUB_LIMIT_PER_DAY`), per address and club (3 per day). A
 * filled honeypot, a duplicate and a new enquiry all get the same `202`; nothing is mailed to the given address (the form cannot
 * be used to send mail to strangers).
 */
publicClubRoutes.post("/clubs/:slug/leads", async (c) => {
  const caller = publicCaller(c);
  await enforceLimit({ bucket: "public_lead.ip", subject: caller.subject, windowMs: HOUR_MS, max: caller.subject === "trusted-server" ? publicTrustedLimit() : leadIpLimit() });
  const slug = c.req.param("slug");
  const live = SLUG_RE.test(slug) ? await liveClubBySlug(slug) : null;
  // No form without the club's published privacy notice (same 404 as a page without form).
  if (!live || !live.content.leadFormEnabled || !(await latestPublishedNotice(live.club.id))) return publicNotFound(c);
  const parsed = leadSchema.safeParse(await readJson(c));
  if (!parsed.success) throw new ValidationError("Invalid request body", { details: parsed.error.issues });
  const body = parsed.data;
  if (body.website && body.website.trim() !== "") return c.json({ data: { status: "received" } }, 202);
  await enforceLimit({ bucket: "public_lead.club", subject: live.club.id, windowMs: DAY_MS, max: leadClubLimit() });
  await enforceLimit({ bucket: "public_lead.email", subject: createHash("sha256").update(`${live.club.id}:${body.email}`).digest("hex").slice(0, 32), windowMs: DAY_MS, max: 3 });
  // Only departments the page offers; anything else is ignored rather than revealing which ids exist.
  const departmentId = body.departmentId && live.content.departmentIds.includes(body.departmentId) ? body.departmentId : null;
  await recordPublicLead({ clubId: live.club.id, name: body.name, email: body.email, phone: body.phone || null, departmentId, message: body.message || null, trialRequested: live.content.trialTrainingEnabled && body.trialRequested === true });
  return c.json({ data: { status: "received" } }, 202);
});
