import { zValidator } from "@hono/zod-validator";
import { and, asc, count, desc, eq, ilike, isNotNull, isNull, or } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";

import { db } from "../db/client.js";
import { clubLeads, LEAD_STATUSES, type LeadStatus } from "../db/schema/club-leads.js";
import { departments } from "../db/schema/departments.js";
import { writeAudit } from "../lib/audit.js";
import { assertTransition, convertLead, shapeLeads } from "../lib/club-leads.js";
import { hasClubPermission } from "../lib/club-permissions.js";
import { likePattern } from "../lib/club-search.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import { cleanText } from "../lib/text-policy.js";
import { clubGuard, type ClubEnv } from "../middleware/club-guard.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { sessionGuard } from "../middleware/session-guard.js";

/**
 * Interested people / trial training pipeline of the board (Wave 15 B4), mounted at `/club-leads`. Only `leads:write`
 * (vorsitz, stellv_vorsitz, schriftfuehrer, abteilungsleitung); everybody else 403. Enquiries arrive through
 * `POST /public/clubs/:slug/leads` (routes/public-clubs.ts) or are entered here by hand.
 */
export const clubLeadRoutes = new Hono<ClubEnv>();

clubLeadRoutes.use("*", rateLimit({ windowMs: 60_000, max: 60 }));
clubLeadRoutes.use("*", sessionGuard);
clubLeadRoutes.use("*", clubGuard);
clubLeadRoutes.use("*", async (c, next) => {
  if (!hasClubPermission(c.get("clubRoleTypes"), "leads:write")) throw new ForbiddenError("Missing leads:write permission");
  c.header("Cache-Control", "private, no-store");
  await next();
});

const hook = (result: { success: boolean; error?: { issues: unknown } }) => {
  if (!result.success) throw new ValidationError("Invalid request", { details: result.error?.issues });
};

const optionalText = (max: number, multiline = false) =>
  z.union([cleanText(z.string().trim().max(max), multiline), z.null()]).transform((v) => (v === null || v === "" ? null : v));
const email = z.union([z.string().trim().toLowerCase().max(320).pipe(z.email()), z.literal(""), z.null()]).transform((v) => v || null);

async function assertDepartment(clubId: string, departmentId: string | null | undefined): Promise<void> {
  if (!departmentId) return;
  const [d] = await db.select({ id: departments.id }).from(departments).where(and(eq(departments.id, departmentId), eq(departments.clubId, clubId)));
  if (!d) throw new ValidationError("Unknown department", { details: { code: "unknown_department" } });
}

async function loadLead(c: Context<ClubEnv>) {
  const [row] = await db.select().from(clubLeads).where(and(eq(clubLeads.id, c.req.param("id") ?? ""), eq(clubLeads.clubId, c.get("clubId"))));
  if (!row) throw new NotFoundError("Lead not found");
  return row;
}

const listQuery = z.object({
  status: z.enum(LEAD_STATUSES).optional(),
  departmentId: z.uuid().optional(),
  waitlisted: z.enum(["true", "false"]).optional(),
  q: z.string().trim().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

clubLeadRoutes.get("/", zValidator("query", listQuery, hook), async (c) => {
  const clubId = c.get("clubId");
  const q = c.req.valid("query");
  const where = and(
    eq(clubLeads.clubId, clubId),
    q.status ? eq(clubLeads.status, q.status) : undefined,
    q.departmentId ? eq(clubLeads.departmentId, q.departmentId) : undefined,
    q.waitlisted === "true" ? isNotNull(clubLeads.waitlistedAt) : q.waitlisted === "false" ? isNull(clubLeads.waitlistedAt) : undefined,
    q.q ? or(ilike(clubLeads.name, likePattern(q.q)), ilike(clubLeads.email, likePattern(q.q))) : undefined,
  );
  const [total] = await db.select({ n: count() }).from(clubLeads).where(where);
  const rows = await db.select().from(clubLeads).where(where).orderBy(desc(clubLeads.lastRequestAt), desc(clubLeads.id)).limit(q.pageSize).offset((q.page - 1) * q.pageSize);
  return c.json({ data: await shapeLeads(rows), page: q.page, pageSize: q.pageSize, total: Number(total?.n ?? 0) });
});

/** Waitlists per department (and one without department), first come first served by `waitlistedAt`. */
clubLeadRoutes.get("/waitlist", zValidator("query", z.object({ departmentId: z.uuid().optional() }), hook), async (c) => {
  const clubId = c.get("clubId");
  const { departmentId } = c.req.valid("query");
  const rows = await db
    .select()
    .from(clubLeads)
    .where(and(eq(clubLeads.clubId, clubId), isNotNull(clubLeads.waitlistedAt), departmentId ? eq(clubLeads.departmentId, departmentId) : undefined))
    .orderBy(asc(clubLeads.waitlistedAt), asc(clubLeads.id));
  const shaped = await shapeLeads(rows);
  const groups = new Map<string, { department: { id: string; name: string } | null; leads: Array<(typeof shaped)[number] & { position: number }> }>();
  for (const lead of shaped) {
    const key = lead.department?.id ?? "none";
    const group = groups.get(key) ?? { department: lead.department, leads: [] };
    group.leads.push({ ...lead, position: group.leads.length + 1 });
    groups.set(key, group);
  }
  return c.json({ data: [...groups.values()].sort((a, b) => (a.department?.name ?? "￿").localeCompare(b.department?.name ?? "￿")) });
});

clubLeadRoutes.get("/:id", async (c) => c.json({ data: (await shapeLeads([await loadLead(c)]))[0] }));

const createSchema = z.object({
  name: cleanText(z.string().trim().min(2).max(100)),
  email: email.optional(),
  phone: optionalText(40).optional(),
  departmentId: z.uuid().nullable().optional(),
  message: optionalText(2000, true).optional(),
  trialOn: z.iso.date().nullable().optional(),
});

clubLeadRoutes.post("/", zValidator("json", createSchema, hook), async (c) => {
  const clubId = c.get("clubId");
  const body = c.req.valid("json");
  await assertDepartment(clubId, body.departmentId);
  const row = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(clubLeads)
      .values({ clubId, name: body.name, email: body.email ?? null, phone: body.phone ?? null, departmentId: body.departmentId ?? null, message: body.message ?? null, trialOn: body.trialOn ?? null, source: "manuell", createdBy: c.get("membership").id })
      .returning();
    await writeAudit(tx, { eventType: "club_lead.create", subjectId: created!.id, payload: { clubId, leadId: created!.id } });
    return created!;
  });
  return c.json({ data: (await shapeLeads([row]))[0] }, 201);
});

const patchSchema = z
  .object({
    status: z.enum(LEAD_STATUSES).optional(),
    notes: optionalText(4000, true).optional(),
    trialOn: z.iso.date().nullable().optional(),
    departmentId: z.uuid().nullable().optional(),
    waitlisted: z.boolean().optional(),
    name: cleanText(z.string().trim().min(2).max(100)).optional(),
    email: email.optional(),
    phone: optionalText(40).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to change" });

clubLeadRoutes.patch("/:id", zValidator("json", patchSchema, hook), async (c) => {
  const clubId = c.get("clubId");
  const lead = await loadLead(c);
  const body = c.req.valid("json");
  if (body.status) assertTransition(lead.status as LeadStatus, body.status);
  await assertDepartment(clubId, body.departmentId);
  const { waitlisted, ...rest } = body;
  const set: Record<string, unknown> = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
  if (waitlisted !== undefined) set.waitlistedAt = waitlisted ? (lead.waitlistedAt ?? new Date()) : null;
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx.update(clubLeads).set({ ...set, updatedAt: new Date() }).where(eq(clubLeads.id, lead.id)).returning();
    await writeAudit(tx, { eventType: "club_lead.update", subjectId: lead.id, payload: { clubId, leadId: lead.id, changedFields: Object.keys(body), status: body.status } });
    return row!;
  });
  return c.json({ data: (await shapeLeads([updated]))[0] });
});

clubLeadRoutes.delete("/:id", async (c) => {
  const clubId = c.get("clubId");
  const lead = await loadLead(c);
  await db.transaction(async (tx) => {
    await tx.delete(clubLeads).where(eq(clubLeads.id, lead.id));
    await writeAudit(tx, { eventType: "club_lead.delete", subjectId: lead.id, payload: { clubId, leadId: lead.id } });
  });
  return c.body(null, 204);
});

/**
 * Creates a member record, so it additionally needs `members:write` (department leads manage enquiries but create no member
 * records). A probable duplicate (same e-mail) is `409 possible_duplicate` unless `{ confirmDuplicate: true }`.
 */
clubLeadRoutes.post("/:id/convert", zValidator("json", z.object({ confirmDuplicate: z.boolean().optional() }).optional().default({}), hook), async (c) => {
  if (!hasClubPermission(c.get("clubRoleTypes"), "members:write")) throw new ForbiddenError("Missing members:write permission");
  const lead = await loadLead(c);
  const result = await convertLead(c.get("clubId"), lead.id, c.get("membership").id, { confirmDuplicate: c.req.valid("json")?.confirmDuplicate === true });
  return c.json({ data: { lead: (await shapeLeads([result.lead]))[0], clubMemberId: result.clubMemberId } }, 201);
});
