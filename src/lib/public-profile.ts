import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { and, asc, eq, gte, ilike, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import type { Context } from "hono";

import { organization } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { calendars } from "../db/schema/calendars.js";
import { clubPublicProfiles, type ClubPublicProfileRow, type PublicProfileContent } from "../db/schema/club-public-profiles.js";
import { clubPlatformStatus } from "../db/schema/club-platform.js";
import { clubSettings } from "../db/schema/club-settings.js";
import { departments } from "../db/schema/departments.js";
import { events } from "../db/schema/events.js";
import { locations } from "../db/schema/locations.js";
import { mediaFiles } from "../db/schema/media-files.js";
import { sponsors } from "../db/schema/sponsors.js";
import { isClubSuspended } from "./club-platform.js";
import { latestPublishedNotice } from "./privacy-notice.js";
import { clientIp, envInt } from "./rate-limits.js";
import { publicMediaUrls, syncPublicOptIn } from "./media.js";
import { todayBerlin } from "./member-lifecycle.js";
import { SPONSOR_LOGO_OWNER, sponsorStatus } from "./sponsors.js";

/**
 * Public club page (Wave 15 B3) and the public opt-in of its media (Wave 15 BM). Rules:
 * - Strict opt-in (E1): reachable only while `club_settings.public_profile_enabled` is true, a version is PUBLISHED and the club
 *   is not suspended; otherwise every public call gets the same 404.
 * - Field whitelist: the public shape is built field by field from the published snapshot (`shapePublicClub`); nothing else of
 *   the club (members, board names, counts, internal notes) is ever read for it.
 * - Media: a file is `public_opt_in` exactly while it is part of the live page (`syncPublicMedia`); revoking the page, a sponsor
 *   ending, a suspension or a replaced image takes the opt-in back at once.
 */

/** `owner_type` of images uploaded for the public page. */
export const PUBLIC_PROFILE_OWNER = "public_profile";
export const MAX_GALLERY_IMAGES = 6;
export const MAX_PROFILE_IMAGES = 30;
export const PUBLIC_EVENT_DAYS = 90;
export const PUBLIC_EVENT_LIMIT = 20;

export const EMPTY_CONTENT: PublicProfileContent = {
  tagline: null,
  description: null,
  city: null,
  address: null,
  contactEmail: null,
  contactPhone: null,
  website: null,
  logoKey: null,
  coverKey: null,
  galleryKeys: [],
  departmentIds: [],
  eventCalendarIds: [],
  showSponsors: false,
  leadFormEnabled: false,
  trialTrainingEnabled: false,
};

export const CONTENT_KEYS = Object.keys(EMPTY_CONTENT) as Array<keyof PublicProfileContent>;

/** The draft of a row (or the empty default) as content. */
export function draftOf(row: ClubPublicProfileRow | undefined | null): PublicProfileContent {
  if (!row) return { ...EMPTY_CONTENT };
  const out = { ...EMPTY_CONTENT } as Record<string, unknown>;
  for (const key of CONTENT_KEYS) out[key] = (row as unknown as Record<string, unknown>)[key] ?? EMPTY_CONTENT[key];
  return out as unknown as PublicProfileContent;
}

/** A stored snapshot normalised to exactly the content keys (older snapshots get the defaults for new keys). */
export function normalizeContent(raw: unknown): PublicProfileContent {
  const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out = { ...EMPTY_CONTENT } as Record<string, unknown>;
  for (const key of CONTENT_KEYS) if (src[key] !== undefined) out[key] = src[key];
  return out as unknown as PublicProfileContent;
}

export function sameContent(a: PublicProfileContent, b: PublicProfileContent): boolean {
  return CONTENT_KEYS.every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]));
}

export const imageKeysOf = (c: PublicProfileContent): string[] => [c.logoKey, c.coverKey, ...c.galleryKeys].filter((k): k is string => !!k);

export async function loadProfileRow(clubId: string): Promise<ClubPublicProfileRow | undefined> {
  const [row] = await db.select().from(clubPublicProfiles).where(eq(clubPublicProfiles.clubId, clubId)).limit(1);
  return row;
}

export async function publicSettings(clubId: string): Promise<{ publicProfileEnabled: boolean; discoverable: boolean }> {
  const [row] = await db.select({ publicProfileEnabled: clubSettings.publicProfileEnabled, discoverable: clubSettings.discoverable }).from(clubSettings).where(eq(clubSettings.clubId, clubId)).limit(1);
  return { publicProfileEnabled: row?.publicProfileEnabled ?? false, discoverable: row?.discoverable ?? false };
}

/** The published content of a club whose page is live right now, or null (not enabled, not published, suspended). */
export async function liveContent(clubId: string): Promise<PublicProfileContent | null> {
  const [settings, row] = await Promise.all([publicSettings(clubId), loadProfileRow(clubId)]);
  if (!settings.publicProfileEnabled || !row?.published) return null;
  if (await isClubSuspended(clubId)) return null;
  return normalizeContent(row.published);
}

/** Sponsors shown on a live page: active (Berlin day) and `oeffentlich`, only if the page shows sponsors. */
async function publicSponsorRows(clubId: string, content: PublicProfileContent) {
  if (!content.showSponsors) return [];
  const rows = await db.select().from(sponsors).where(and(eq(sponsors.clubId, clubId), eq(sponsors.visibility, "oeffentlich"))).orderBy(asc(sponsors.name), asc(sponsors.id));
  const today = todayBerlin();
  return rows.filter((r) => sponsorStatus(r, today) === "aktiv");
}

/**
 * Recomputes which media of the club are released (`public_opt_in`): the images of the live published page and the logos of the
 * sponsors it shows. Everything else of the owner types `public_profile` and `sponsor_logo` goes back to `private`. Call after
 * every change that can affect it (publish/unpublish, settings, sponsor changes, suspension) and from the daily job (sponsors
 * whose contract ended).
 */
export async function syncPublicMedia(clubId: string): Promise<number> {
  const content = await liveContent(clubId);
  const wanted = new Set<string>();
  if (content) {
    for (const key of imageKeysOf(content)) wanted.add(key);
    for (const s of await publicSponsorRows(clubId, content)) if (s.logoKey) wanted.add(s.logoKey);
  }
  return syncPublicOptIn(clubId, [PUBLIC_PROFILE_OWNER, SPONSOR_LOGO_OWNER], wanted);
}

/** Daily safety net: re-syncs every club that has released media or a live page (catches sponsors whose end date passed). */
export async function syncAllPublicMedia(): Promise<number> {
  const withMedia = await db.selectDistinct({ clubId: mediaFiles.clubId }).from(mediaFiles).where(eq(mediaFiles.visibility, "public_opt_in"));
  const enabled = await db.select({ clubId: clubSettings.clubId }).from(clubSettings).where(eq(clubSettings.publicProfileEnabled, true));
  const ids = new Set([...withMedia.map((r) => r.clubId), ...enabled.map((r) => r.clubId)].filter((v): v is string => !!v));
  let changed = 0;
  for (const id of ids) changed += await syncPublicMedia(id);
  return changed;
}

export const PUBLIC_MEDIA_SYNC_JOB_TYPE = "public_media_sync";
export const PUBLIC_MEDIA_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Exactly the keys of the public page, nothing else (the data-leak tests compare against this list). */
export const PUBLIC_CLUB_KEYS = ["slug", "name", "tagline", "description", "city", "address", "contact", "logoUrl", "coverUrl", "galleryUrls", "departments", "events", "sponsors", "leadForm"] as const;

/** Builds the public shape from the published snapshot, field by field (whitelist). */
export async function shapePublicClub(club: { id: string; name: string; slug: string }, content: PublicProfileContent) {
  const now = new Date();
  const until = new Date(now.getTime() + PUBLIC_EVENT_DAYS * 86_400_000);
  const [depts, evs, sponsorRows] = await Promise.all([
    content.departmentIds.length ? db.select({ id: departments.id, name: departments.name }).from(departments).where(and(eq(departments.clubId, club.id), inArray(departments.id, content.departmentIds))).orderBy(asc(departments.name)) : Promise.resolve([]),
    content.eventCalendarIds.length
      ? db
          .select({ title: events.title, startsAt: events.startsAt, endsAt: events.endsAt, allDay: events.allDay, cancelledAt: events.cancelledAt, locationName: locations.name })
          .from(events)
          .innerJoin(calendars, eq(calendars.id, events.calendarId))
          .leftJoin(locations, eq(locations.id, events.locationId))
          .where(and(eq(calendars.clubId, club.id), inArray(events.calendarId, content.eventCalendarIds), gte(events.startsAt, now), lte(events.startsAt, until)))
          .orderBy(asc(events.startsAt), asc(events.id))
          .limit(PUBLIC_EVENT_LIMIT)
      : Promise.resolve([]),
    publicSponsorRows(club.id, content),
  ]);
  const urls = await publicMediaUrls(club.id, [...imageKeysOf(content), ...sponsorRows.map((s) => s.logoKey)]);
  const notice = content.leadFormEnabled ? await latestPublishedNotice(club.id) : null;
  const url = (key: string | null) => (key ? (urls.get(key) ?? null) : null);
  const departmentList = depts.map((d) => ({ id: d.id, name: d.name }));
  return {
    slug: club.slug,
    name: club.name,
    tagline: content.tagline,
    description: content.description,
    city: content.city,
    address: content.address,
    contact: { email: content.contactEmail, phone: content.contactPhone, website: content.website },
    logoUrl: url(content.logoKey),
    coverUrl: url(content.coverKey),
    galleryUrls: content.galleryKeys.map((k) => urls.get(k)).filter((u): u is string => !!u),
    departments: departmentList,
    events: evs.map((e) => ({ title: e.title, startsAt: e.startsAt, endsAt: e.endsAt, allDay: e.allDay, cancelled: e.cancelledAt !== null, locationName: e.locationName ?? null })),
    sponsors: sponsorRows.map((s) => ({ name: s.name, website: s.website, logoUrl: url(s.logoKey) })),
    leadForm: {
      enabled: content.leadFormEnabled,
      trialTraining: content.leadFormEnabled && content.trialTrainingEnabled,
      departments: content.leadFormEnabled ? departmentList : [],
      // The club's published privacy notice (a public legal text) for the enquiry form; only while the form is on.
      privacyNotice: notice ? { version: notice.version, body: notice.body, publishedAt: notice.publishedAt } : null,
    },
  };
}

/** The live club behind a public slug, or null (unknown, not enabled, not published, suspended: indistinguishable). */
export async function liveClubBySlug(slug: string): Promise<{ club: { id: string; name: string; slug: string }; content: PublicProfileContent } | null> {
  const [club] = await db.select({ id: organization.id, name: organization.name, slug: organization.slug }).from(organization).where(eq(organization.slug, slug)).limit(1);
  if (!club) return null;
  const content = await liveContent(club.id);
  return content ? { club, content } : null;
}

// --- Caller identification of the public endpoints -----------------------------------------------------------------------

/**
 * Who a public request counts against. Browsers: the hashed client IP (`clientIp`). The website's server (SSR/ISR, server
 * actions) would otherwise share ONE IP for all visitors, so it may authenticate with `X-Public-Api-Token`
 * (`PUBLIC_API_TRUSTED_TOKEN`) and forward the visitor's address in `X-Public-Client-Ip`; without a forwarded address it gets the
 * shared "trusted" bucket with its own limit. The token is never accepted when unset.
 */
export function publicCaller(c: Context): { subject: string; trusted: boolean } {
  const configured = process.env.PUBLIC_API_TRUSTED_TOKEN ?? "";
  const given = c.req.header("x-public-api-token") ?? "";
  const salt = process.env.UNSUBSCRIBE_SECRET || process.env.BETTER_AUTH_SECRET || "rate-limit";
  const hashIp = (ip: string) => createHmac("sha256", salt).update(`rate-limit-ip:${ip}`).digest("hex").slice(0, 32);
  if (configured.length >= 16 && given.length > 0) {
    const a = createHash("sha256").update(configured).digest();
    const b = createHash("sha256").update(given).digest();
    if (timingSafeEqual(a, b)) {
      const forwarded = (c.req.header("x-public-client-ip") ?? "").trim();
      if (forwarded && forwarded.length <= 64 && /^[0-9a-fA-F:.]+$/.test(forwarded)) return { subject: hashIp(forwarded), trusted: true };
      return { subject: "trusted-server", trusted: true };
    }
  }
  return { subject: hashIp(clientIp(c)), trusted: false };
}

export const publicIpLimit = () => envInt("PUBLIC_CLUB_IP_LIMIT_PER_HOUR", 300);
export const publicInvalidLimit = () => envInt("PUBLIC_CLUB_INVALID_LIMIT_PER_HOUR", 30);
export const publicTrustedLimit = () => envInt("PUBLIC_CLUB_TRUSTED_LIMIT_PER_HOUR", 20_000);
/** Failed lookups of the trusted server when it forwards no visitor address (shared bucket, so it cannot be used to probe slugs freely). */
export const publicTrustedInvalidLimit = () => envInt("PUBLIC_CLUB_TRUSTED_INVALID_LIMIT_PER_HOUR", 600);
export const publicSearchLimit = () => envInt("PUBLIC_CLUB_SEARCH_LIMIT_PER_HOUR", 60);
export const SEARCH_Q_MIN = 3;
export const SEARCH_CITY_MIN = 2;
export const SEARCH_LIMIT = 10;

/**
 * Club search (Wave 15 B5, E2): only clubs that opted in to BOTH the public page (enabled + published) and `discoverable`, never a
 * suspended one. Name (`q`, at least 3 characters) and/or city (at least 2); LIKE metacharacters are escaped. At most 10 hits,
 * name / slug / city / released logo only, no total count: a club that did not opt in is indistinguishable from one that does
 * not exist.
 */
export async function searchPublicClubs(q: string | null, city: string | null) {
  const like = (v: string) => `%${v.replace(/[\\%_]/g, "\\$&")}%`;
  const rows = await db
    .select({ id: organization.id, name: organization.name, slug: organization.slug, published: clubPublicProfiles.published })
    .from(organization)
    .innerJoin(clubSettings, and(eq(clubSettings.clubId, organization.id), eq(clubSettings.publicProfileEnabled, true), eq(clubSettings.discoverable, true)))
    .innerJoin(clubPublicProfiles, and(eq(clubPublicProfiles.clubId, organization.id), isNotNull(clubPublicProfiles.published)))
    .leftJoin(clubPlatformStatus, eq(clubPlatformStatus.clubId, organization.id))
    .where(and(isNull(clubPlatformStatus.suspendedAt), q ? ilike(organization.name, like(q)) : undefined, city ? sql`${clubPublicProfiles.published}->>'city' ILIKE ${like(city)}` : undefined))
    .orderBy(sql`lower(${organization.name})`, asc(organization.id))
    .limit(SEARCH_LIMIT);
  const out = [];
  for (const r of rows) {
    const content = normalizeContent(r.published);
    const urls = await publicMediaUrls(r.id, [content.logoKey]);
    out.push({ slug: r.slug, name: r.name, city: content.city, logoUrl: content.logoKey ? (urls.get(content.logoKey) ?? null) : null });
  }
  return out;
}
