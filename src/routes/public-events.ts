import { and, eq } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";

import { organization } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { locations } from "../db/schema/locations.js";
import type { EventRow } from "../db/schema/events.js";
import { NotFoundError, ValidationError } from "../lib/errors.js";
import { cancelGuest, confirmGuest, eventByPublicToken, guestAnswers, guestByManageToken, hashToken, registerGuest, updateGuest } from "../lib/event-guests.js";
import { notifyPromoted } from "../lib/event-notify.js";
import { closedReason, describeRegistration, effectiveSettings, loadSettings, MAX_PARTY_SIZE } from "../lib/event-registration.js";
import { takenSeats } from "../lib/event-seats.js";
import { enforceLimit, envInt, HOUR_MS, ipSubject } from "../lib/rate-limits.js";
import { cleanText } from "../lib/text-policy.js";

/**
 * Public routes for guests without account (Wave 12 B14). NO session, NO club guard: the link token of the event, the
 * confirmation code and the management token are the credentials, and only their SHA-256 is stored. Everything is
 * rate limited per salted client IP (DB-backed, shared by all instances); unknown / revoked / malformed tokens give the
 * same 404 and count against a strict "invalid" budget, so tokens cannot be enumerated. A response never carries a
 * participant list, member data or the data of another registration.
 */
export const publicEventRoutes = new Hono();

const ipLimit = () => envInt("PUBLIC_EVENT_IP_LIMIT_PER_HOUR", 300);
const invalidLimit = () => envInt("PUBLIC_EVENT_INVALID_LIMIT_PER_HOUR", 20);
const registerIpLimit = () => envInt("PUBLIC_EVENT_REGISTER_IP_LIMIT_PER_HOUR", 10);
const registerTokenLimit = () => envInt("PUBLIC_EVENT_REGISTER_TOKEN_LIMIT_PER_HOUR", 200);
const registerEmailLimit = () => envInt("PUBLIC_EVENT_REGISTER_EMAIL_LIMIT_PER_HOUR", 3);

publicEventRoutes.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  c.header("X-Robots-Tag", "noindex, nofollow");
  await enforceLimit({ bucket: "public_event.ip", subject: ipSubject(c), windowMs: HOUR_MS, max: ipLimit() });
  await next();
});

/** One 404 for everything that is not a valid credential; counts against the strict "invalid" budget of the client. */
async function notFound(c: Context): Promise<never> {
  await enforceLimit({ bucket: "public_event.invalid", subject: ipSubject(c), windowMs: HOUR_MS, max: invalidLimit() });
  throw new NotFoundError("Not found");
}

async function readJson(c: Context): Promise<unknown> {
  const text = await c.req.text();
  if (text.length > 128 * 1024) throw new ValidationError("Request body too large");
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ValidationError("Invalid JSON body");
  }
}

function summary(event: EventRow, location: { name: string; address: string | null } | null, clubName: string) {
  return {
    title: event.title,
    description: event.description,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    allDay: event.allDay,
    cancelled: event.cancelledAt !== null,
    location,
    clubName,
  };
}

async function publicView(clubId: string, event: EventRow) {
  const [club] = await db.select({ name: organization.name }).from(organization).where(eq(organization.id, clubId));
  const [location] = event.locationId ? await db.select({ name: locations.name, address: locations.address }).from(locations).where(and(eq(locations.id, event.locationId), eq(locations.clubId, clubId))) : [];
  const registration = await describeRegistration(clubId, event);
  const settings = effectiveSettings(await loadSettings(event.id));
  const taken = await takenSeats(db, event.id);
  const open = registration.open && settings.enabled && settings.allowGuests;
  return {
    event: { ...summary(event, location ?? null, club?.name ?? ""), costNote: event.costNote, costCents: event.costCents },
    registration: {
      open,
      closedReason: open ? null : (registration.closedReason ?? "guests_not_allowed"),
      deadlineAt: registration.deadlineAt,
      maxCompanions: registration.maxCompanions,
      // Only whether a place is free (a registration would land on the waitlist), never how many people are in.
      full: event.capacity !== null && taken >= event.capacity,
      form: registration.form,
    },
  };
}

publicEventRoutes.get("/events/:token", async (c) => {
  const found = await eventByPublicToken(c.req.param("token"));
  if (!found) return notFound(c);
  return c.json({ data: await publicView(found.clubId, found.event) });
});

const registerSchema = z.object({
  name: cleanText(z.string().trim().min(1).max(100)),
  email: z.string().trim().toLowerCase().max(200).pipe(z.email()),
  partySize: z.number().int().min(1).max(MAX_PARTY_SIZE).optional(),
  answers: z.record(z.string(), z.unknown()).optional(),
  /** The guest has seen the privacy notice of the form / the club. */
  privacyAccepted: z.literal(true),
  language: z.enum(["de", "en"]).optional(),
  /** Honeypot: invisible for people, bots fill it. */
  website: z.string().max(500).optional(),
});

publicEventRoutes.post("/events/:token/registrations", async (c) => {
  const ip = ipSubject(c);
  await enforceLimit({ bucket: "public_event.register.ip", subject: ip, windowMs: HOUR_MS, max: registerIpLimit() });
  const token = c.req.param("token");
  const found = await eventByPublicToken(token);
  if (!found) return notFound(c);
  await enforceLimit({ bucket: "public_event.register.token", subject: hashToken(token), windowMs: HOUR_MS, max: registerTokenLimit() });

  const parsed = registerSchema.safeParse(await readJson(c));
  if (!parsed.success) throw new ValidationError("Invalid request body", { details: parsed.error.issues });
  const body = parsed.data;
  // A filled honeypot gets the normal answer and nothing happens.
  if (body.website && body.website.trim() !== "") return c.json({ data: { status: "pending_confirmation" } }, 202);
  await enforceLimit({ bucket: "public_event.register.email", subject: hashToken(`${found.event.id}:${body.email}`), windowMs: HOUR_MS, max: registerEmailLimit() });
  if (body.answers && JSON.stringify(body.answers).length > 64 * 1024) throw new ValidationError("Answers are too large");

  await registerGuest(found.clubId, found.event, { name: body.name, email: body.email, partySize: body.partySize ?? 1, answers: body.answers, language: body.language });
  // Same answer for a new address, a pending one and an already registered one: the outcome is in the mail.
  return c.json({ data: { status: "pending_confirmation" } }, 202);
});

const confirmSchema = z.object({ code: z.string().max(100), language: z.enum(["de", "en"]).optional() });

publicEventRoutes.post("/registrations/confirm", async (c) => {
  const parsed = confirmSchema.safeParse(await readJson(c));
  if (!parsed.success) throw new ValidationError("Invalid request body");
  const done = await confirmGuest(parsed.data.code, parsed.data.language);
  if (!done) return notFound(c);
  const view = await publicView(done.clubId, done.event);
  return c.json({ data: { status: done.status, partySize: done.partySize, alreadyConfirmed: done.alreadyConfirmed, manageToken: done.manageToken, event: view.event } });
});

async function managed(c: Context) {
  const reg = await guestByManageToken(c.req.param("guestToken") ?? "");
  if (!reg || reg.row.guestConfirmedAt === null) return notFound(c);
  return reg;
}

publicEventRoutes.get("/registrations/:guestToken", async (c) => {
  const reg = await managed(c);
  const view = await publicView(reg.clubId, reg.event);
  const settings = effectiveSettings(await loadSettings(reg.event.id));
  return c.json({
    data: {
      status: reg.row.status,
      partySize: reg.row.partySize,
      name: reg.row.guestName,
      answers: await guestAnswers(reg.row),
      canChange: reg.event.cancelledAt === null && closedReason(reg.event, settings) === null,
      ...view,
    },
  });
});

const changeSchema = z
  .object({ partySize: z.number().int().min(1).max(MAX_PARTY_SIZE).optional(), answers: z.record(z.string(), z.unknown()).optional(), name: cleanText(z.string().trim().min(1).max(100)).optional() })
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to change" });

publicEventRoutes.patch("/registrations/:guestToken", async (c) => {
  const reg = await managed(c);
  const parsed = changeSchema.safeParse(await readJson(c));
  if (!parsed.success) throw new ValidationError("Invalid request body", { details: parsed.error.issues });
  const result = await updateGuest(reg, parsed.data);
  await notifyPromoted({ clubId: reg.clubId, event: reg.event, promoted: result.promoted });
  return c.json({ data: { status: result.status, partySize: result.partySize } });
});

publicEventRoutes.delete("/registrations/:guestToken", async (c) => {
  const reg = await managed(c);
  const promoted = await cancelGuest(reg);
  await notifyPromoted({ clubId: reg.clubId, event: reg.event, promoted });
  return c.body(null, 204);
});

